// Port Royale browser installer: installs a port's APK on a Meta Quest or
// PICO headset over USB (WebUSB + ADB, via Tango / ya-webadb).
// Built into ../../installer.js by `npm run build` in installer/.
//
// The page holds one <div class="installer" data-config='{...}'> per port:
//   { "relay": "https://...workers.dev", "assets": [{name, url, size}], "game": "Bugdom VR" }
// The APK is fetched through the relay (GitHub release downloads have no CORS
// headers) and streamed straight into `pm install`, so big APKs never sit in memory.

import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { PackageManager } from "@yume-chan/android-bin";
import { pmInstallStream } from "./pm-install.js";

const credentialStore = new AdbWebCredentialStore("Port Royale");

// One headset connection shared by every installer box on the page.
let conn = null; // { adb, device, model, maker, isPico }
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

function fmtSize(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

async function connect(setMsg) {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  const device = await manager.requestDevice();
  if (!device) return null; // picker closed
  let connection;
  try {
    connection = await device.connect();
  } catch (e) {
    if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
      throw new Error("Another program is using the headset (SideQuest, Meta Quest Developer Hub or adb). Close it, or run \"adb kill-server\", then try again.");
    }
    throw e;
  }
  setMsg("Put on your headset and tap **Allow** on the \"Allow USB debugging?\" prompt. Tick \"Always allow from this computer\" so it won't ask again.");
  const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore });
  const adb = new Adb(transport);
  const [maker, model] = await Promise.all([adb.getProp("ro.product.manufacturer"), adb.getProp("ro.product.model")]);
  conn = { adb, device, maker: maker.trim(), model: model.trim(), isPico: /pico|bytedance/i.test(maker + model) };
  transport.disconnected.then(() => {
    if (conn && conn.adb === adb) { conn = null; notify(); }
  });
  notify();
  return conn;
}

// Pick the APK that fits the connected headset: names with "pico" are PICO builds.
function pickAsset(assets) {
  if (assets.length === 1) return assets[0];
  const pico = assets.filter((a) => /pico/i.test(a.name));
  const other = assets.filter((a) => !/pico/i.test(a.name));
  if (conn && conn.isPico && pico.length) return pico[0];
  return other[0] || assets[0];
}

function friendlyError(e) {
  const m = String((e && e.message) || e);
  if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(m)) {
    const pkg = (m.match(/package ([\w.]+)/) || [])[1];
    return { text: "A version of this port with a different signature is already installed. Uninstall it first, then install again (this deletes its saves and settings).", pkg };
  }
  if (/INSUFFICIENT_STORAGE/i.test(m)) return { text: "Not enough free space on the headset. Delete some apps or files and try again." };
  if (/VERSION_DOWNGRADE/i.test(m)) {
    const pkg = (m.match(/package ([\w.]+)/) || [])[1];
    return { text: "A newer version of this port is already installed. Uninstall it first if you want this one (this deletes its saves and settings).", pkg };
  }
  if (/NO_MATCHING_ABIS|CPU_ABI/i.test(m)) return { text: "This APK doesn't run on this headset." };
  if (/Failed to fetch|NetworkError|relay|download/i.test(m)) return { text: "The download failed. Check your internet connection and try again, or use the manual download below." };
  if (/transferIn|transferOut|disconnected|The device was disconnected/i.test(m)) return { text: "The headset was disconnected. Plug it in again and reconnect." };
  return { text: m };
}

function md(text) {
  // tiny **bold** support for status messages
  const frag = document.createDocumentFragment();
  text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (/^\*\*.*\*\*$/.test(part)) frag.append(el("strong", {}, part.slice(2, -2)));
    else if (part) frag.append(part);
  });
  return frag;
}

function mount(root) {
  const cfg = JSON.parse(root.dataset.config);
  const assets = cfg.assets;
  const relay = (cfg.relay || "").replace(/\/$/, "");
  let busy = false;
  let chosen = null; // asset name picked by hand in the dropdown

  const dot = el("span", { class: "inst-dot" });
  const statusText = el("span", { class: "inst-status-text" }, "No headset connected");
  const status = el("div", { class: "inst-status", role: "status", "aria-live": "polite" }, dot, statusText);

  const msg = el("p", { class: "inst-msg" });
  const setMsg = (t, kind = "") => { msg.replaceChildren(md(t || "")); msg.className = "inst-msg" + (kind ? " inst-" + kind : ""); };

  const bar = el("div", { class: "inst-bar-fill" });
  const barWrap = el("div", { class: "inst-bar", hidden: true }, bar);
  const setBar = (frac) => { barWrap.hidden = frac == null; if (frac != null) bar.style.width = `${Math.round(frac * 100)}%`; };

  const connectBtn = el("button", { type: "button", class: "btn btn-primary btn-block" }, "Connect headset");
  const installBtn = el("button", { type: "button", class: "btn btn-primary btn-block", hidden: true }, "Install");
  const extraBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm", hidden: true });

  const select = el("select", { class: "inst-select", "aria-label": "APK to install" },
    assets.map((a) => el("option", { value: a.name }, `${a.name} (${fmtSize(a.size)})`)));
  const selectRow = el("label", { class: "inst-row", hidden: assets.length < 2 }, el("span", {}, "APK"), select);
  select.addEventListener("change", () => { chosen = select.value; render(); });

  const fileInput = el("input", { type: "file", accept: ".apk,application/vnd.android.package-archive", hidden: true });
  const fileLink = el("button", { type: "button", class: "inst-link" }, "install an APK file from this computer");
  const fileRow = el("p", { class: "inst-small", hidden: true }, "Or ", fileLink, ".");
  fileLink.addEventListener("click", () => fileInput.click());

  const asset = () => (chosen && assets.find((a) => a.name === chosen)) || pickAsset(assets);

  function render() {
    const supported = !!AdbDaemonWebUsbDeviceManager.BROWSER;
    const a = asset();
    if (!chosen) select.value = a.name;
    dot.className = "inst-dot" + (conn ? " on" : "");
    statusText.textContent = conn ? `Connected: ${conn.model || "headset"}${conn.maker ? " (" + conn.maker + ")" : ""}` : "No headset connected";
    connectBtn.hidden = !supported || !!conn;
    connectBtn.disabled = busy;
    installBtn.hidden = !conn;
    installBtn.disabled = busy;
    installBtn.textContent = `Install ${a.name} (${fmtSize(a.size)})`;
    fileRow.hidden = !conn;
    fileLink.disabled = busy;
    if (!supported) {
      setMsg("Your browser can't talk to USB devices. Open this page in **Chrome** or **Edge** on a PC, Mac or Android phone.", "warn");
    } else if (!busy && !conn && !msg.textContent) {
      setMsg("Plug your headset into this computer with a USB cable (developer mode on), then press Connect.");
    }
  }
  listeners.add(render);

  async function run(fn) {
    if (busy) return;
    busy = true; extraBtn.hidden = true; render();
    try { await fn(); }
    catch (e) {
      console.error("[installer]", e);
      setBar(null);
      const f = friendlyError(e);
      setMsg(f.text, "err");
      if (f.pkg && conn) {
        extraBtn.textContent = `Uninstall ${f.pkg}`;
        extraBtn.hidden = false;
        extraBtn.onclick = () => run(async () => {
          setMsg(`Uninstalling ${f.pkg}…`);
          await new PackageManager(conn.adb).uninstall(f.pkg);
          setMsg("Old version removed. Press Install again.", "ok");
        });
      }
    } finally { busy = false; render(); }
  }

  connectBtn.addEventListener("click", () => run(async () => {
    setMsg("Pick your headset in the browser's list (Quest, PICO or \"Android\").");
    const c = await connect(setMsg);
    if (!c) { setMsg("No headset picked. Press Connect to try again."); return; }
    setMsg(assets.length > 1 ? `Ready. The ${c.isPico ? "PICO" : "Quest"} APK is selected.` : "Ready to install.", "ok");
  }));

  async function installStream(size, stream, label) {
    let sent = 0;
    const counter = new TransformStream({
      transform(chunk, ctl) {
        sent += chunk.byteLength;
        setBar(Math.min(1, sent / size));
        if (sent < size) setMsg(`Installing ${label}: ${fmtSize(sent)} of ${fmtSize(size)}. Keep the headset plugged in.`);
        else setMsg("Finishing the install on the headset…");
        ctl.enqueue(chunk);
      },
    });
    setBar(0);
    await pmInstallStream(conn.adb, size, stream.pipeThrough(counter));
    setBar(null);
    setMsg(`**${cfg.game || "The port"} is installed.** On Quest, find it in Library → Unknown Sources; on PICO, in your library. If this port needs game files, follow the manual on this page.`, "ok");
  }

  installBtn.addEventListener("click", () => run(async () => {
    const a = asset();
    setMsg(`Downloading ${a.name}…`);
    const res = await fetch(`${relay}/?url=${encodeURIComponent(a.url)}`);
    if (!res.ok || !res.body) throw new Error(`download failed (relay ${res.status})`);
    const size = Number(res.headers.get("Content-Length")) || a.size;
    await installStream(size, res.body, a.name);
  }));

  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    run(() => installStream(f.size, f.stream(), f.name));
  });

  root.replaceChildren(
    status,
    el("div", { class: "inst-body" }, selectRow, msg, barWrap, connectBtn, installBtn, extraBtn, fileRow, fileInput),
  );
  render();
}

document.querySelectorAll(".installer[data-config]").forEach(mount);
