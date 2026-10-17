// "Install from your browser" box for native ports: one APK (or a Quest + PICO pair).
import { PackageManager } from "@yume-chan/android-bin";
import { pmInstallStream } from "./pm-install.js";
import { state, onChange, el, fmtSize, connect, friendlyError, relayFetch, makeChrome, usbSupported, NO_USB_TEXT, CONNECT_PROMPT } from "./common.js";

// Pick the APK that fits the connected headset: names with "pico" are PICO builds.
function pickAsset(assets) {
  if (assets.length === 1) return assets[0];
  const pico = assets.filter((a) => /pico/i.test(a.name));
  const other = assets.filter((a) => !/pico/i.test(a.name));
  if (state.conn && state.conn.isPico && pico.length) return pico[0];
  return other[0] || assets[0];
}

export function mountApk(root, cfg) {
  const assets = cfg.assets;
  let busy = false;
  let chosen = null; // asset name picked by hand in the dropdown
  const ui = makeChrome();
  const { setMsg, setBar } = ui;

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
    const supported = usbSupported();
    const a = asset();
    const conn = state.conn;
    if (!chosen) select.value = a.name;
    ui.renderStatus();
    connectBtn.hidden = !supported || !!conn;
    connectBtn.disabled = busy;
    installBtn.hidden = !conn;
    installBtn.disabled = busy;
    installBtn.textContent = `Install ${a.name} (${fmtSize(a.size)})`;
    fileRow.hidden = !conn;
    fileLink.disabled = busy;
    if (!supported) setMsg(NO_USB_TEXT, "warn");
    else if (!busy && !conn && !ui.msg.textContent) setMsg("Plug your headset into this computer with a USB cable (developer mode on), then press Connect.");
  }
  onChange(render);

  async function run(fn) {
    if (busy) return;
    busy = true; extraBtn.hidden = true; render();
    try { await fn(); }
    catch (e) {
      console.error("[installer]", e);
      setBar(null);
      const f = friendlyError(e);
      setMsg(f.text, "err");
      if (f.pkg && state.conn) {
        extraBtn.textContent = `Uninstall ${f.pkg}`;
        extraBtn.hidden = false;
        extraBtn.onclick = () => run(async () => {
          setMsg(`Uninstalling ${f.pkg}…`);
          await new PackageManager(state.conn.adb).uninstall(f.pkg);
          setMsg("Old version removed. Press Install again.", "ok");
        });
      }
    } finally { busy = false; render(); }
  }

  connectBtn.addEventListener("click", () => run(async () => {
    setMsg(CONNECT_PROMPT);
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
    await pmInstallStream(state.conn.adb, size, stream.pipeThrough(counter));
    setBar(null);
    setMsg(`**${cfg.game || "The port"} is installed.** On Quest, find it in Library → Unknown Sources; on PICO, in your library. If this port needs game files, follow the manual on this page.`, "ok");
  }

  installBtn.addEventListener("click", () => run(async () => {
    const a = asset();
    setMsg(`Downloading ${a.name}…`);
    const res = await relayFetch(cfg.relay, a.url);
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
    ui.status,
    el("div", { class: "inst-body" }, selectRow, ui.msg, ui.barWrap, connectBtn, installBtn, extraBtn, fileRow, fileInput),
  );
  render();
}
