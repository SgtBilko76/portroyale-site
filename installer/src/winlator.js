// "Install from your browser" box for WinlatorXR mods. Steps:
//   1. connect the headset
//   2. WinlatorXR: compare the installed version with the newest public
//      WinlatorXR release and install / update it (updates keep containers)
//   3. game files: copy the user's own game folder to /sdcard/Download/<folder>
//   4. VR mod: download the mod package, unzip it into that folder and put the
//      .wxrprofile.json into /sdcard/Download/Winlator/WxrProfiles
//      (or, for a container image, copy the file to /sdcard/Download)
// Container creation / profile import stay manual steps inside WinlatorXR.
import { unzipSync } from "fflate";
import { pmInstallStream } from "./pm-install.js";
import { state, onChange, el, fmtSize, connect, friendlyError, relayFetch, makeChrome, usbSupported, NO_USB_TEXT, CONNECT_PROMPT } from "./common.js";

const DL = "/sdcard/Download";
const PROFILE_DIR = `${DL}/Winlator/WxrProfiles`;

// "dawn-42", "WinlatorXR-dawn-42.apk", "winlatorxr_dawn42" -> { line: "dawn", n: 42 }
// Release lines are named alphabetically (arf, blit, cats, dawn, eat...), so
// line name first, then number, gives the order.
export function parseWxrVersion(s) {
  const m = String(s || "").toLowerCase().match(/(?:^|[^a-z])([a-z]+)[-_]?(\d+)(?:\.apk)?$/) || String(s || "").toLowerCase().match(/([a-z]+)[-_]?(\d+)/);
  return m ? { line: m[1], n: Number(m[2]), label: `${m[1]}-${m[2]}` } : null;
}
function cmpVer(a, b) {
  if (a.line !== b.line) return a.line < b.line ? -1 : 1;
  return a.n - b.n;
}

async function sh(cmd) {
  return state.conn.adb.subprocess.noneProtocol.spawnWaitText(cmd);
}
async function exists(path) {
  return (await sh(`[ -e '${path}' ] && echo yes`)).trim() === "yes";
}
async function freeBytes() {
  const out = await sh(`df -k ${DL}`);
  const line = out.trim().split("\n").pop().trim().split(/\s+/);
  const kb = Number(line[3]);
  return Number.isFinite(kb) ? kb * 1024 : Infinity;
}
const streamOf = (data) => new ReadableStream({ start(c) { c.enqueue(data); c.close(); } });

export function mountWinlator(root, cfg) {
  const wxr = { ...cfg.winlatorxr };
  const mod = cfg.mod;
  const isImage = mod.kind === "file";
  let busy = false;
  let installed = null; // { raw, ver } | { raw: "" } when missing
  let gameFound = null;
  let modDone = false;
  const ui = makeChrome();
  const { setMsg, setBar } = ui;

  // Newest public WinlatorXR release, checked live (the page's copy may be a day old).
  fetch("https://api.github.com/repos/WinlatorXR/WinlatorXR/releases/latest")
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      const a = rel && (rel.assets || []).find((x) => /\.apk$/i.test(x.name));
      if (!a) return;
      const v = parseWxrVersion(a.name), cur = parseWxrVersion(wxr.name);
      if (v && (!cur || cmpVer(v, cur) > 0)) {
        Object.assign(wxr, { name: a.name, url: a.browser_download_url, size: a.size, release_url: rel.html_url });
        render();
      }
    })
    .catch(() => {});

  const step = (n, title) => {
    const text = el("p", { class: "inst-step-text" });
    const btn = el("button", { type: "button", class: "btn btn-primary btn-sm" });
    const box = el("div", { class: "inst-step" },
      el("div", { class: "inst-step-head" }, el("span", { class: "inst-num" }, String(n)), el("strong", {}, title)),
      text, btn);
    return { box, text, btn, set(t, kind = "") { text.replaceChildren(t); text.className = "inst-step-text" + (kind ? " inst-" + kind : ""); } };
  };

  const connectBtn = el("button", { type: "button", class: "btn btn-primary btn-block" }, "Connect headset");
  const sWxr = step(1, "WinlatorXR");
  const sGame = isImage ? null : step(2, `Your ${mod.game_label} files`);
  const sMod = step(isImage ? 2 : 3, isImage ? "Container image" : "VR mod");
  const folderInput = el("input", { type: "file", hidden: true, webkitdirectory: true, multiple: true });
  const next = el("p", { class: "inst-small inst-next", hidden: true });
  next.append(...(cfg.next ? [el("strong", {}, "Last steps in WinlatorXR: "), cfg.next, " Details are in the manual on this page."] : []));

  function render() {
    const supported = usbSupported();
    const conn = state.conn;
    ui.renderStatus();
    connectBtn.hidden = !supported || !!conn;
    connectBtn.disabled = busy;
    const latest = parseWxrVersion(wxr.name);
    for (const s of [sWxr, sGame, sMod]) if (s) { s.box.hidden = !conn; s.btn.disabled = busy; }
    next.hidden = !conn || !modDone || !cfg.next;
    if (!supported) setMsg(NO_USB_TEXT, "warn");
    else if (!busy && !conn && !ui.msg.textContent) setMsg("Plug your Quest into this computer with a USB cable (developer mode on), then press Connect.");
    if (!conn) return;

    // 1. WinlatorXR
    const newest = latest ? latest.label : wxr.name;
    if (!installed) { sWxr.set("Checking…"); sWxr.btn.hidden = true; }
    else if (!installed.raw) {
      sWxr.set(`Not installed. Newest release: ${newest}.`, "warn");
      sWxr.btn.hidden = false; sWxr.btn.textContent = `Install WinlatorXR ${newest} (${fmtSize(wxr.size)})`;
    } else if (installed.ver && latest && cmpVer(installed.ver, latest) >= 0) {
      sWxr.set(`✓ ${installed.raw} installed${cmpVer(installed.ver, latest) > 0 ? ` (newer than the public ${newest})` : " (newest)"}.`, "ok");
      sWxr.btn.hidden = true;
    } else {
      sWxr.set(`${installed.raw} installed, ${newest} is out. Updating keeps your containers and games.`, "warn");
      sWxr.btn.hidden = false; sWxr.btn.textContent = `Update to ${newest} (${fmtSize(wxr.size)})`;
    }
    // 2. game files
    if (sGame) {
      if (gameFound === null) { sGame.set("Checking…"); sGame.btn.hidden = true; }
      else {
        sGame.set(gameFound
          ? `✓ Found in Download/${mod.folder}.`
          : `Not on the headset yet. Pick your ${mod.game_label} folder (the one with ${mod.marker.split("/").pop()}): it is copied over USB to Download/${mod.folder}. Nothing is uploaded to the internet.`,
          gameFound ? "ok" : "warn");
        sGame.btn.hidden = false;
        sGame.btn.textContent = gameFound ? "Copy the game folder again" : `Choose your ${mod.game_label} folder…`;
        sGame.btn.className = gameFound ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm";
      }
    }
    // 3. mod / image
    sMod.btn.hidden = false;
    if (isImage) {
      sMod.set(modDone ? `✓ ${mod.name} is in Download.` : `Copies ${mod.name} to the headset's Download folder, ready to import in WinlatorXR.`, modDone ? "ok" : "");
      sMod.btn.textContent = modDone ? "Copy again" : `Copy the container image (${fmtSize(mod.size)})`;
    } else {
      sMod.set(modDone ? `✓ ${mod.name} unpacked into Download/${mod.folder}; profile copied to Download/Winlator/WxrProfiles.` : `Unpacks ${mod.name} into Download/${mod.folder} and puts its WinlatorXR profile where WinlatorXR can import it.`, modDone ? "ok" : "");
      sMod.btn.textContent = modDone ? "Install the mod again" : `Install the VR mod (${fmtSize(mod.size)})`;
    }
    sMod.btn.className = modDone ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm";
  }
  onChange(() => { if (!state.conn) { installed = null; gameFound = null; } render(); });

  async function run(fn) {
    if (busy) return;
    busy = true; render();
    try { await fn(); }
    catch (e) {
      console.error("[installer]", e);
      setBar(null);
      const f = friendlyError(e);
      if (f.pkg === wxr.package || /signatures do not match/i.test(f.text)) {
        setMsg("Your WinlatorXR is a differently signed build, so it can't be updated in place. Uninstalling it would delete all your containers: back them up first (Containers → Export), then uninstall WinlatorXR on the headset and press Install again.", "err");
      } else setMsg(f.text, "err");
    } finally { busy = false; render(); }
  }

  async function refresh() {
    const out = await sh(`dumpsys package ${wxr.package} 2>/dev/null | grep -m1 versionName`);
    const raw = ((out.match(/versionName=(\S+)/) || [])[1] || "").trim();
    installed = { raw, ver: parseWxrVersion(raw) };
    if (sGame) gameFound = await exists(`${DL}/${mod.folder}/${mod.marker}`);
    render();
  }

  connectBtn.addEventListener("click", () => run(async () => {
    setMsg(CONNECT_PROMPT);
    const c = await connect(setMsg);
    if (!c) { setMsg("No headset picked. Press Connect to try again."); return; }
    setMsg("Connected. Work through the steps below.", "ok");
    await refresh();
  }));

  // progress helper for streams of known size
  const counter = (size, label) => {
    let sent = 0;
    return new TransformStream({
      transform(chunk, ctl) {
        sent += chunk.byteLength;
        setBar(Math.min(1, sent / size));
        setMsg(`${label}: ${fmtSize(sent)} of ${fmtSize(size)}. Keep the headset plugged in.`);
        ctl.enqueue(chunk);
      },
    });
  };

  sWxr.btn.addEventListener("click", () => run(async () => {
    const free = await freeBytes();
    if (free < wxr.size * 1.2) throw new Error(`Not enough free space on the headset: WinlatorXR needs about ${fmtSize(wxr.size * 1.2)}, ${fmtSize(free)} is free.`);
    setMsg(`Downloading ${wxr.name}…`);
    const res = await relayFetch(cfg.relay, wxr.url);
    const size = Number(res.headers.get("Content-Length")) || wxr.size;
    setBar(0);
    await pmInstallStream(state.conn.adb, size, res.body.pipeThrough(counter(size, `Installing ${wxr.name}`)));
    setBar(null);
    const fresh = !installed || !installed.raw;
    await refresh();
    setMsg(fresh ? `**WinlatorXR ${installed.raw} is installed.** Start it once on the headset so it can finish its first-time setup.` : `**WinlatorXR is updated to ${installed.raw}.** Your containers and games are kept.`, "ok");
  }));

  if (sGame) {
    sGame.btn.addEventListener("click", () => folderInput.click());
    folderInput.addEventListener("change", () => {
      const files = Array.from(folderInput.files || []);
      folderInput.value = "";
      if (!files.length) return;
      run(async () => {
        const marker = mod.marker.toLowerCase();
        // paths below the picked folder; find where the game folder starts (the user may pick a parent folder)
        const rel = files.map((f) => ({ f, p: f.webkitRelativePath.split("/").slice(1).join("/") }));
        let prefix = null;
        for (const { p } of rel) {
          const lp = p.toLowerCase();
          if (lp === marker) { prefix = ""; break; }
          if (lp.endsWith("/" + marker)) {
            const pre = p.slice(0, p.length - marker.length);
            if (prefix === null || pre.length < prefix.length) prefix = pre;
          }
        }
        if (prefix === null) throw new Error(`That doesn't look like the ${mod.game_label} folder: ${mod.marker} is missing. Pick the folder that contains it.`);
        const todo = rel.filter(({ p }) => p.startsWith(prefix)).map(({ f, p }) => ({ f, p: p.slice(prefix.length) }));
        const total = todo.reduce((s, x) => s + x.f.size, 0);
        const free = await freeBytes();
        if (free < total + 200 * 1024 * 1024) throw new Error(`Not enough free space on the headset: the game needs ${fmtSize(total)}, ${fmtSize(free)} is free.`);
        const sync = await state.conn.adb.sync();
        let done = 0;
        try {
          setBar(0);
          for (const [i, { f, p }] of todo.entries()) {
            let sent = 0;
            const prog = new TransformStream({
              transform(chunk, ctl) {
                sent += chunk.byteLength;
                setBar((done + sent) / total);
                ctl.enqueue(chunk);
              },
            });
            setMsg(`Copying ${mod.game_label}: file ${i + 1} of ${todo.length}, ${fmtSize(done)} of ${fmtSize(total)}. Keep the headset plugged in.`);
            await sync.write({ filename: `${DL}/${mod.folder}/${p}`, file: f.stream().pipeThrough(prog), mtime: Math.floor(f.lastModified / 1000) });
            done += f.size;
          }
        } finally { await sync.dispose(); }
        setBar(null);
        gameFound = await exists(`${DL}/${mod.folder}/${mod.marker}`);
        setMsg(`**${mod.game_label} copied** to Download/${mod.folder} (${todo.length} files, ${fmtSize(total)}).`, "ok");
      });
    });
  }

  sMod.btn.addEventListener("click", () => run(async () => {
    setMsg(`Downloading ${mod.name}…`);
    const res = await relayFetch(cfg.relay, mod.url);
    const size = Number(res.headers.get("Content-Length")) || mod.size;
    const sync = await state.conn.adb.sync();
    try {
      if (isImage) {
        setBar(0);
        await sync.write({ filename: `${DL}/${mod.name}`, file: res.body.pipeThrough(counter(size, `Copying ${mod.name}`)) });
      } else {
        // small package: download fully, unzip in the browser, push each file
        const chunks = [];
        let got = 0;
        const reader = res.body.getReader();
        setBar(0);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); got += value.byteLength;
          setBar(got / size);
          setMsg(`Downloading ${mod.name}: ${fmtSize(got)} of ${fmtSize(size)}`);
        }
        const buf = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
        const entries = Object.entries(unzipSync(buf)).filter(([p]) => !p.endsWith("/"));
        for (const [i, [p, data]] of entries.entries()) {
          setBar((i + 1) / entries.length);
          setMsg(`Installing the mod: file ${i + 1} of ${entries.length}`);
          await sync.write({ filename: `${DL}/${mod.folder}/${p}`, file: streamOf(data) });
          if (/\.wxrprofile\.json$/i.test(p)) {
            await sync.write({ filename: `${PROFILE_DIR}/${p.split("/").pop()}`, file: streamOf(data) });
          }
        }
      }
    } finally { await sync.dispose(); }
    setBar(null);
    modDone = true;
    setMsg(isImage ? `**${mod.name} is in the headset's Download folder.**` : `**The VR mod is installed** in Download/${mod.folder}.`, "ok");
  }));

  root.replaceChildren(
    ui.status,
    el("div", { class: "inst-body" }, ui.msg, ui.barWrap, connectBtn, sWxr.box, sGame && sGame.box, sMod.box, next, folderInput),
  );
  render();
}
