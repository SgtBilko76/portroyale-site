#!/usr/bin/env python3
"""Read package name, version and minSdk of a remote APK without downloading it.

Only the zip directory and AndroidManifest.xml are fetched (HTTP range requests), so even
multi-GB APKs cost a few hundred KB. Used by build.py for catalog.json, which the Port Royale
headset app reads to tell "installed / update available".

    python3 tools/apkinfo.py <apk-url>
"""
import io
import json
import struct
import sys
import urllib.request
import zipfile

UA = {"User-Agent": "portroyale-site"}
BLOCK = 256 * 1024


class RangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests (block cached)."""

    def __init__(self, url):
        self.url, self.pos, self.cache = url, 0, {}
        req = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            self.url = r.geturl()  # follow the GitHub redirect once
            cr = r.headers.get("Content-Range", "")
            if r.status != 206 or "/" not in cr:
                raise IOError("server ignores range requests")
            self.size = int(cr.rsplit("/", 1)[1])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _block(self, n):
        if n not in self.cache:
            a = n * BLOCK
            b = min(a + BLOCK, self.size) - 1
            req = urllib.request.Request(self.url, headers={**UA, "Range": f"bytes={a}-{b}"})
            with urllib.request.urlopen(req, timeout=60) as r:
                self.cache[n] = r.read()
        return self.cache[n]

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        out = bytearray()
        while n > 0:
            blk = self._block(self.pos // BLOCK)
            off = self.pos % BLOCK
            chunk = blk[off:off + n]
            if not chunk:
                break
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, b):
        d = self.read(len(b))
        b[:len(d)] = d
        return len(d)


ATTR_IDS = {0x0101021B: "versionCode", 0x0101021C: "versionName", 0x0101020C: "minSdkVersion"}


def parse_axml(data):
    """Binary AndroidManifest.xml -> {package, versionCode, versionName, minSdk}."""
    strings, resmap, info = [], [], {}
    pos = struct.unpack_from("<HHI", data, 0)[1]
    while pos + 8 <= len(data):
        typ, hsize, size = struct.unpack_from("<HHI", data, pos)
        if size == 0:
            break
        if typ == 0x0001:  # string pool
            count, _styles, flags, sstart, _ = struct.unpack_from("<IIIII", data, pos + 8)
            utf8 = flags & 0x100
            offs = struct.unpack_from(f"<{count}I", data, pos + hsize)
            base = pos + sstart
            for o in offs:
                p = base + o
                if utf8:
                    n = data[p]; p += 2 if n & 0x80 else 1  # utf16 length
                    n = data[p]
                    if n & 0x80:
                        n = ((n & 0x7F) << 8) | data[p + 1]; p += 2
                    else:
                        p += 1
                    strings.append(data[p:p + n].decode("utf-8", "replace"))
                else:
                    n = struct.unpack_from("<H", data, p)[0]; p += 2
                    if n & 0x8000:
                        n = ((n & 0x7FFF) << 16) | struct.unpack_from("<H", data, p)[0]; p += 2
                    strings.append(data[p:p + 2 * n].decode("utf-16-le", "replace"))
        elif typ == 0x0180:  # resource ids of attribute names
            resmap = list(struct.unpack_from(f"<{(size - hsize) // 4}I", data, pos + hsize))
        elif typ == 0x0102:  # start element
            name_i = struct.unpack_from("<I", data, pos + 20)[0]
            astart, asize, acount = struct.unpack_from("<HHH", data, pos + 24)
            tag = strings[name_i] if name_i < len(strings) else ""
            if tag in ("manifest", "uses-sdk"):
                for i in range(acount):
                    a = pos + 16 + astart + i * asize
                    _ns, nm, raw, _sz, _r, dtype, val = struct.unpack_from("<IIIHBBI", data, a)
                    key = ATTR_IDS.get(resmap[nm] if nm < len(resmap) else 0) or (strings[nm] if nm < len(strings) else "")
                    if dtype == 0x03 or (raw != 0xFFFFFFFF and dtype != 0x10):
                        v = strings[raw if raw != 0xFFFFFFFF else val]
                    else:
                        v = val
                    if key in ("package", "versionCode", "versionName", "minSdkVersion"):
                        info[key] = v
            if tag == "uses-sdk":
                break
        pos += size
    out = {"package": info.get("package"), "versionCode": info.get("versionCode"),
           "versionName": info.get("versionName")}
    ms = info.get("minSdkVersion")
    if ms is not None:
        try:
            out["minSdk"] = int(ms)
        except ValueError:
            pass
    return out


def apk_info(url):
    with zipfile.ZipFile(RangeFile(url)) as z:
        return parse_axml(z.read("AndroidManifest.xml"))


def zip_root(url, marker):
    """Path prefix inside a remote zip under which `marker` sits ("0AD/" for 0AD/data/...), or None."""
    m = marker.lower().strip("/")
    try:
        with zipfile.ZipFile(RangeFile(url)) as z:
            best = None
            for n in z.namelist():
                ln = n.lower()
                if ln == m or ln.endswith("/" + m):
                    pre = n[:len(n) - len(m)]
                    if best is None or len(pre) < len(best):
                        best = pre
            return best
    except Exception as e:
        print(f"  ! zip_root {url}: {e}")
        return None


if __name__ == "__main__":
    for u in sys.argv[1:]:
        print(json.dumps(apk_info(u)))
