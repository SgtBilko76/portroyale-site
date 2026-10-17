// Shared pieces of the Port Royale browser installer: the headset connection
// (one per page, shared by every installer box), DOM helpers and error texts.

import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";

export { AdbDaemonWebUsbDeviceManager };
export const usbSupported = () => !!AdbDaemonWebUsbDeviceManager.BROWSER;

const credentialStore = new AdbWebCredentialStore("Port Royale");

// conn = { adb, device, model, maker, isPico } while a headset is connected
export const state = { conn: null };
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());
export function setConn(c) { state.conn = c; notify(); }

export function fmtSize(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

// tiny **bold** support for status messages
export function md(text) {
  const frag = document.createDocumentFragment();
  String(text).split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (/^\*\*.*\*\*$/.test(part)) frag.append(el("strong", {}, part.slice(2, -2)));
    else if (part) frag.append(part);
  });
  return frag;
}

export async function connect(setMsg) {
  const device = await AdbDaemonWebUsbDeviceManager.BROWSER.requestDevice();
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
  state.conn = { adb, device, maker: maker.trim(), model: model.trim(), isPico: /pico|bytedance/i.test(maker + model) };
  transport.disconnected.then(() => {
    if (state.conn && state.conn.adb === adb) { state.conn = null; notify(); }
  });
  notify();
  return state.conn;
}

export function connLabel() {
  const c = state.conn;
  return c ? `Connected: ${c.model || "headset"}${c.maker ? " (" + c.maker + ")" : ""}` : "No headset connected";
}

export function friendlyError(e) {
  const m = String((e && e.message) || e);
  const pkg = (m.match(/package ([\w.]+)/) || [])[1];
  if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(m)) {
    return { text: "A version of this app with a different signature is already installed. Uninstall it first, then install again (this deletes its saves and settings).", pkg };
  }
  if (/INSUFFICIENT_STORAGE|No space left/i.test(m)) return { text: "Not enough free space on the headset. Delete some apps or files and try again." };
  if (/VERSION_DOWNGRADE/i.test(m)) {
    return { text: "A newer version of this app is already installed. Uninstall it first if you want this one (this deletes its saves and settings).", pkg };
  }
  if (/NO_MATCHING_ABIS|CPU_ABI/i.test(m)) return { text: "This APK doesn't run on this headset." };
  if (/Failed to fetch|NetworkError|relay|download failed/i.test(m)) return { text: "The download failed. Check your internet connection and try again, or use the manual download below." };
  if (/transferIn|transferOut|disconnected/i.test(m)) return { text: "The headset was disconnected. Plug it in again and reconnect." };
  return { text: m };
}

export async function relayFetch(relay, url) {
  const res = await fetch(`${relay.replace(/\/$/, "")}/?url=${encodeURIComponent(url)}`);
  if (!res.ok || !res.body) throw new Error(`download failed (relay ${res.status})`);
  return res;
}

// Status line + message + progress bar used by both box types.
export function makeChrome() {
  const dot = el("span", { class: "inst-dot" });
  const statusText = el("span", { class: "inst-status-text" }, "No headset connected");
  const status = el("div", { class: "inst-status", role: "status", "aria-live": "polite" }, dot, statusText);
  const msg = el("p", { class: "inst-msg" });
  const setMsg = (t, kind = "") => { msg.replaceChildren(md(t || "")); msg.className = "inst-msg" + (kind ? " inst-" + kind : ""); };
  const bar = el("div", { class: "inst-bar-fill" });
  const barWrap = el("div", { class: "inst-bar", hidden: true }, bar);
  const setBar = (frac) => { barWrap.hidden = frac == null; if (frac != null) bar.style.width = `${Math.round(frac * 100)}%`; };
  const renderStatus = () => {
    dot.className = "inst-dot" + (state.conn ? " on" : "");
    statusText.textContent = connLabel();
  };
  return { status, msg, setMsg, barWrap, setBar, renderStatus };
}

export const NO_USB_TEXT = "Your browser can't talk to USB devices. Open this page in **Chrome** or **Edge** on a PC, Mac or Android phone.";
export const CONNECT_PROMPT = "Pick your headset in the browser's list (Quest, PICO or \"Android\").";
