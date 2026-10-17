// Game-data steps for the APK installer box: copy the user's own game files
// (a folder or single files picked on the PC) to the headset over USB.
//
// cfg.data = [{
//   label:    "Your X-Wing Alliance folder",       heading of the step
//   hint:     "the folder with STRINGS.TXT",        shown before the copy
//   kind:     "folder" | "files",
//   target:   "/sdcard/OpenXWA",                    where the files go
//   marker:   "STRINGS.TXT",     folder: path inside the game folder that locates it (and proves it's on the headset)
//   include:  ["System", "*.hog"],  folder: only these top-level entries
//   exclude:  ["System/User.ini"],  folder: never copy these
//   keep_name: true,             folder: copy into target/<picked folder name> (one table per folder, ...)
//   tar:      "wipeout",         folder: send as target/<tar>.tar (the app unpacks it; adb-made folders in
//                                Android/data aren't readable by the app)
//   names:    ["sf64.o2r"],      files: required file names (checked on the headset)
//   accept:   ".chd,.cue,.bin",  files: file picker filter
//   check:    ["cstrike/liblist.gam"]  paths below target that must all exist (overrides the default check)
//   optional: true
// }]
import { state, el, fmtSize } from "./common.js";

const lower = (s) => s.toLowerCase();
const segs = (p) => p.split("/").filter(Boolean);
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export async function sh(cmd) {
  return state.conn.adb.subprocess.noneProtocol.spawnWaitText(cmd);
}
export async function exists(path) {
  return (await sh(`[ -e ${q(path)} ] && echo yes`)).trim() === "yes";
}
export async function freeBytes() {
  const line = (await sh("df -k /sdcard")).trim().split("\n").pop().trim().split(/\s+/);
  const kb = Number(line[3]);
  return Number.isFinite(kb) ? kb * 1024 : Infinity;
}

// Where in the picked folder does the game folder start? The user may pick the
// game folder itself or a folder above it. Returns the path prefix or null.
export function findRoot(paths, marker) {
  if (!marker) return "";
  const m = segs(lower(marker));
  let best = null;
  for (const p of paths) {
    const s = segs(lower(p));
    for (let i = 0; i + m.length <= s.length; i++) {
      if (m.every((x, j) => s[i + j] === x)) {
        const pre = segs(p).slice(0, i).join("/");
        if (best === null || pre.length < best.length) best = pre;
        break;
      }
    }
  }
  return best;
}

function globMatch(name, pat) {
  const re = new RegExp("^" + pat.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return re.test(name);
}

// files picked with <input webkitdirectory> -> [{ file, rel }] below the game root
export function selectFolderFiles(files, item) {
  const all = files.map((f) => ({ file: f, p: f.webkitRelativePath.split("/").slice(1).join("/") }));
  const root = findRoot(all.map((x) => x.p), item.marker);
  if (root === null) return null;
  const pre = root ? root + "/" : "";
  const excl = (item.exclude || []).map(lower);
  return all
    .filter(({ p }) => p.startsWith(pre))
    .map(({ file, p }) => ({ file, rel: p.slice(pre.length) }))
    .filter(({ rel }) => {
      const top = segs(rel)[0] || "";
      if (item.include && !item.include.some((pat) => globMatch(top, pat))) return false;
      return !excl.includes(lower(rel));
    });
}

// ustar archive of the files as one stream (for apps that unpack a tar themselves)
const enc = new TextEncoder();
function tarHeader(name, size, mtime) {
  const h = new Uint8Array(512);
  const put = (s, off, len) => h.set(enc.encode(s).slice(0, len), off);
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  let prefix = "";
  if (name.length > 100) { const i = name.lastIndexOf("/", 155); prefix = name.slice(0, i); name = name.slice(i + 1); }
  put(name, 0, 100); put(oct(0o644, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(mtime, 12), 136, 12); put("        ", 148, 8); put("0", 156, 1);
  put("ustar\0", 257, 6); put("00", 263, 2); put(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
export function tarOf(list, rootName) {
  const size = list.reduce((s, { file }) => s + 512 + Math.ceil(file.size / 512) * 512, 0) + 1024;
  let i = 0, reader = null, pad = 0;
  const stream = new ReadableStream({
    async pull(ctl) {
      if (reader) {
        const { done, value } = await reader.read();
        if (!done) { ctl.enqueue(value); return; }
        reader = null;
        if (pad) { ctl.enqueue(new Uint8Array(pad)); return; }
      }
      if (i >= list.length) { ctl.enqueue(new Uint8Array(1024)); ctl.close(); return; }
      const { file, rel } = list[i++];
      ctl.enqueue(tarHeader(`${rootName}/${rel}`, file.size, Math.floor(file.lastModified / 1000)));
      pad = (512 - (file.size % 512)) % 512;
      reader = file.stream().getReader();
    },
  });
  return { stream, size };
}

const appPkg = (target) => (target.match(/\/Android\/data\/([^/]+)/) || [])[1];

// Apps own their Android/data folder only if they created it, so start the app
// once (on Quest, simulate the headset being worn so the app really starts).
// If that doesn't work (headset asleep, PICO), fixAppPerms opens the folders up.
async function ensureAppDir(item) {
  const pkg = appPkg(item.target);
  if (!pkg) return;
  if (!(await sh(`pm path ${pkg}`)).trim()) throw new Error("Install the app first (the Install button above), then copy the game files.");
  const dir = `/sdcard/Android/data/${pkg}/files`;
  if (await exists(dir)) return;
  await sh("am broadcast -a com.oculus.vrpowermanager.prox_close >/dev/null 2>&1; input keyevent KEYCODE_WAKEUP");
  const act = (await sh(`cmd package resolve-activity --brief -a android.intent.action.MAIN ${pkg}`)).trim().split("\n").pop().trim();
  if (act.includes("/")) {
    await sh(`am start -n ${act} >/dev/null 2>&1`);
    for (let t = 0; t < 40 && !(await exists(dir)); t++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 1000));
    await sh(`am force-stop ${pkg}`);
  }
  await sh("am broadcast -a com.oculus.vrpowermanager.automation_disable >/dev/null 2>&1");
}

// Folders and files adb creates inside Android/data belong to the shell user,
// so the app couldn't read them: open them up.
async function fixAppPerms(item) {
  const pkg = appPkg(item.target);
  if (!pkg) return;
  const base = `/sdcard/Android/data/${pkg}`;
  await sh(`find ${q(base)} -type d -exec chmod 2777 {} + 2>/dev/null; find ${q(item.target)} -type f -user shell -exec chmod 666 {} + 2>/dev/null; true`);
}

// adbd can't create folders inside an app's Android/data folder ("secure_mkdirs
// failed"), but the shell can: create every target folder first.
export async function mkdirs(dirs) {
  const all = [...new Set(dirs)];
  for (let i = 0; i < all.length; i += 40) {
    await sh(`mkdir -p ${all.slice(i, i + 40).map(q).join(" ")}`);
  }
}
const parentOf = (p) => p.slice(0, p.lastIndexOf("/"));

export async function pushList(list, destOf, { setMsg, setBar }, label) {
  const total = list.reduce((s, x) => s + x.file.size, 0);
  const free = await freeBytes();
  if (free < total + 200 * 1024 * 1024) throw new Error(`Not enough free space on the headset: ${label} needs ${fmtSize(total)}, ${fmtSize(free)} is free.`);
  await mkdirs(list.map((x) => parentOf(destOf(x))));
  const sync = await state.conn.adb.sync();
  let done = 0;
  try {
    setBar(0);
    for (const [i, x] of list.entries()) {
      let sent = 0;
      const prog = new TransformStream({ transform(c, ctl) { sent += c.byteLength; setBar(total ? (done + sent) / total : 1); ctl.enqueue(c); } });
      setMsg(`Copying ${label}: file ${i + 1} of ${list.length}, ${fmtSize(done)} of ${fmtSize(total)}. Keep the headset plugged in.`);
      await sync.write({ filename: destOf(x), file: x.file.stream().pipeThrough(prog), mtime: Math.floor(x.file.lastModified / 1000) });
      done += x.file.size;
    }
  } finally { await sync.dispose(); }
  setBar(null);
  return total;
}

const whereOf = (item) => item.target.replace(/^\/sdcard\//, "");

export async function checkItem(item) {
  if (item.check) { // explicit list of paths that must all exist below target
    for (const c of item.check) if (!(await exists(`${item.target}/${c}`))) return false;
    return true;
  }
  if (item.tar) return (await exists(`${item.target}/${item.tar}/${item.marker}`)) || (await exists(`${item.target}/${item.tar}.tar`));
  if (item.kind === "folder" && item.marker && !item.keep_name) return exists(`${item.target}/${item.marker}`);
  if (item.kind === "files" && item.names) {
    for (const n of item.names) if (!(await exists(`${item.target}/${n}`))) return false;
    return true;
  }
  return null; // nothing to check (tables, ROMs, disc images...)
}


export async function copyItem(item, files, ui) {
  await ensureAppDir(item);
  let n, total;
  if (item.kind === "files") {
    if (item.names) {
      const missing = item.names.filter((nm) => !files.some((f) => lower(f.name) === lower(nm)));
      const picked = files.filter((f) => item.names.some((nm) => lower(nm) === lower(f.name)));
      if (!picked.length) throw new Error(`Pick ${item.names.join(" and ")}.`);
      files = picked;
      if (missing.length) ui.setMsg(`Copying ${picked.map((f) => f.name).join(", ")}; still missing: ${missing.join(", ")}.`, "warn");
    }
    const list = files.map((f) => ({ file: f, rel: f.name }));
    total = await pushList(list, (x) => `${item.target}/${x.rel}`, ui, item.label.replace(/^Your /, "your "));
    n = list.length;
  } else {
    const list = selectFolderFiles(files, item);
    if (!list) throw new Error(`That doesn't look like the right folder: ${item.marker} is missing. Pick ${item.hint || "the game folder"}.`);
    if (!list.length) throw new Error("No game files found in that folder.");
    const base = item.keep_name ? `${item.target}/${files[0].webkitRelativePath.split("/")[0]}` : item.target;
    if (item.tar) {
      const { stream, size } = tarOf(list, item.tar);
      const free = await freeBytes();
      if (free < size + 200 * 1024 * 1024) throw new Error(`Not enough free space on the headset: the game files need ${fmtSize(size)}, ${fmtSize(free)} is free.`);
      let sent = 0;
      const prog = new TransformStream({ transform(c, ctl) { sent += c.byteLength; ui.setBar(sent / size); ui.setMsg(`Copying the game files: ${fmtSize(sent)} of ${fmtSize(size)}. Keep the headset plugged in.`); ctl.enqueue(c); } });
      await mkdirs([item.target]);
      const sync = await state.conn.adb.sync();
      try { ui.setBar(0); await sync.write({ filename: `${item.target}/${item.tar}.tar`, file: stream.pipeThrough(prog) }); }
      finally { await sync.dispose(); }
      ui.setBar(null);
      total = size;
    } else {
      total = await pushList(list, (x) => `${base}/${x.rel}`, ui, "the game files");
    }
    n = list.length;
  }
  await fixAppPerms(item);
  ui.setMsg(`**Copied ${n} file${n === 1 ? "" : "s"} (${fmtSize(total)})** to ${whereOf(item)}.${item.tar ? " The game unpacks them on its next start." : ""}`, "ok");
}

export function makeDataSteps(cfg, run, ui) {
  const items = cfg.data || [];
  const found = new Map(); // item -> true/false/null
  const steps = items.map((item, idx) => {
    const text = el("p", { class: "inst-step-text" });
    const btn = el("button", { type: "button", class: "btn btn-primary btn-sm" });
    const input = item.kind === "files"
      ? el("input", { type: "file", hidden: true, multiple: true, accept: item.accept || false })
      : el("input", { type: "file", hidden: true, multiple: true, webkitdirectory: true });
    const box = el("div", { class: "inst-step", hidden: true },
      el("div", { class: "inst-step-head" }, el("span", { class: "inst-num" }, String(idx + 2)),
        el("strong", {}, item.label + (item.optional ? " (optional)" : ""))),
      text, btn, input);
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.value = "";
      if (files.length) run(() => copy(item, files));
    });
    return { item, box, text, btn };
  });

  const where = whereOf;

  async function check(item) { return checkItem(item); }

  async function refresh() {
    for (const s of steps) found.set(s.item, state.conn ? await check(s.item) : null);
  }

  async function copy(item, files) {
    await copyItem(item, files, ui);
    found.set(item, await check(item));
  }

  function render(busy) {
    for (const s of steps) {
      const { item } = s;
      s.box.hidden = !state.conn;
      s.btn.disabled = busy;
      if (!state.conn) continue;
      const f = found.get(item);
      const pickWord = item.kind === "files" ? (item.names && item.names.length === 1 ? `Choose ${item.names[0]}…` : "Choose files…") : "Choose folder…";
      if (f === true) {
        s.text.textContent = `✓ Already on the headset in ${where(item)}.`;
        s.text.className = "inst-step-text inst-ok";
        s.btn.textContent = "Copy again";
        s.btn.className = "btn btn-ghost btn-sm";
      } else {
        s.text.textContent = `${f === false ? "Not on the headset yet. " : ""}Pick ${item.hint}: ${item.kind === "files" ? "they are" : "it is"} copied over USB to ${where(item)}${item.keep_name ? "/<folder name>" : ""}. Nothing is uploaded to the internet.`;
        s.text.className = "inst-step-text" + (f === false && !item.optional ? " inst-warn" : "");
        s.btn.textContent = pickWord;
        s.btn.className = "btn btn-primary btn-sm";
      }
    }
  }

  return { boxes: steps.map((s) => s.box), refresh, render, count: steps.length };
}
