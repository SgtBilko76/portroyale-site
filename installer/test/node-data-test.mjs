// Node test of the game-data copy (src/data.js) on a real headset:
//   node test/node-data-test.mjs <local-folder> <data-item-json> [--install <apk-url>]
// Local files are wrapped to look like browser File objects from <input webkitdirectory>.
import { readFileSync, readdirSync, statSync, openAsBlob } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WebUSB } from "usb";
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { setConn } from "../src/common.js";
import { copyItem, checkItem, findRoot, sh } from "../src/data.js";
import { pmInstallStream } from "../src/pm-install.js";

const [dir, itemJson, flag, apkUrl] = process.argv.slice(2);
const item = JSON.parse(itemJson);

const pem = readFileSync(homedir() + "/.android/adbkey", "utf8");
const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
const credentialStore = { async generateKey() { throw new Error("x"); }, async *iterateKeys() { yield { buffer: new Uint8Array(der), name: "test" }; } };
const manager = new AdbDaemonWebUsbDeviceManager(new WebUSB({ allowedDevices: [{ vendorId: 0x2833 }] }));
const [device] = await manager.getDevices();
{ const raw = device.raw, orig = raw.transferIn; raw.transferIn = (ep, len) => orig.call(raw, ep, len, 3600000); }
const adb = new Adb(await AdbDaemonTransport.authenticate({ serial: device.serial, connection: await device.connect(), credentialStore }));
setConn({ adb, model: "Quest 3", maker: "Oculus" });

console.log("findRoot tests:", JSON.stringify([
  findRoot(["a.txt", "System/Botpack.u"], "System/Botpack.u"),
  findRoot(["UT/System/Botpack.u", "UT/Maps/x.unr"], "System/Botpack.u"),
  findRoot(["x/collectors_cd/BOOTTIE.EXE", "x/remastered/TIE95.EXE"], "TIE95.EXE"),
  findRoot(["foo.txt"], "STRINGS.TXT"),
]));

if (flag === "--install") {
  const res = await fetch(`https://portroyale-apk-relay.portroyale.workers.dev/?url=${encodeURIComponent(apkUrl)}`);
  await pmInstallStream(adb, Number(res.headers.get("Content-Length")), res.body);
  console.log("installed", apkUrl.split("/").pop());
}

// local folder -> browser-like File objects
const top = path.basename(dir);
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n), st = statSync(p);
    if (st.isDirectory()) walk(p);
    else files.push({ p, name: n, size: st.size, lastModified: st.mtimeMs, webkitRelativePath: top + "/" + path.relative(dir, p).split(path.sep).join("/") });
  }
})(dir);
for (const f of files) { const blob = await openAsBlob(f.p); f.stream = () => blob.stream(); }

const ui = { setMsg: (t) => process.stdout.write(`\r${String(t).slice(0, 110).padEnd(110)}`), setBar: () => {} };
console.log("before: on headset =", await checkItem(item));
const t0 = Date.now();
await copyItem(item, files, ui);
console.log(`\ncopied ${files.length} local files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("after: on headset =", await checkItem(item));
console.log((await sh(`ls -la '${item.target}' | head -8`)).trim());
await adb.close();
process.exit(0);
