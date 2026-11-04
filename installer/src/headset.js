// Install box for browsers without WebUSB, above all the Meta Quest Browser and
// PICO browser on the headset itself: no PC, no cable. The APK is downloaded
// straight from the GitHub release, then installed with the headset's Files app.
// Firefox / Safari on a PC get the same download buttons plus a short note.
import { el, md, fmtSize } from "./common.js";

const UA = navigator.userAgent || "";
export const isPicoBrowser = () => /PicoBrowser|Pico Neo|PICO 4|Pico/i.test(UA) && !/OculusBrowser/i.test(UA);
export const isQuestBrowser = () => /OculusBrowser|Quest/i.test(UA);
export const onHeadset = () => isQuestBrowser() || isPicoBrowser();

function pickForHeadset(assets) {
  const pico = assets.filter((a) => /pico/i.test(a.name));
  const other = assets.filter((a) => !/pico/i.test(a.name));
  if (isPicoBrowser() && pico.length) return pico[0];
  return other[0] || assets[0];
}

const dlButton = (a, primary = true) =>
  el("a", { class: `btn ${primary ? "btn-primary" : "btn-ghost"} btn-block`, href: a.url, download: a.name, rel: "noopener" },
    `Download ${a.name} (${fmtSize(a.size)})`);

const steps = (items) => el("ol", { class: "inst-steps" }, items.map((t) => el("li", {}, md(t))));

function questSteps(file) {
  return [
    `Press **Download** above and wait until it's done (the download icon in the browser's top bar).`,
    `Open the **Files** app (Library → Files) and go to **Downloads**.`,
    `Point at **${file}**, press the **⋮** (three dots) next to it → **Open with** → **Package installer**.`,
    `The first time, the headset says installing unknown apps is blocked: press **Settings**, turn on **Allow from this source**, go back.`,
    `Press **Install**. When it's done, find the app in **Library → Unknown Sources** (the drop-down at the top of the Library).`,
  ];
}
function picoSteps(file) {
  return [
    `Press **Download** above and wait until it's done.`,
    `Open **Files** → **Downloads** and tap **${file}**.`,
    `Allow installing from this source if asked, then tap **Install**. The app shows up in your library.`,
  ];
}
const headsetSteps = (file) => (isPicoBrowser() ? picoSteps(file) : questSteps(file));

// Notes for the parts that still need files from a PC (game data the user owns).
function dataNote(cfg) {
  if (!cfg.data || !cfg.data.length) return null;
  const where = cfg.data.filter((d) => !d.optional).map((d) => d.target).join(", ") || cfg.data[0].target;
  return el("p", { class: "inst-msg inst-warn" }, md(
    `This port also needs **your own game files** (${where} on the headset). They live on your PC, so copy them once with the USB installer ` +
    `(open this page in Chrome or Edge on a PC) or by plugging the headset into the PC and dragging the folder over. ` +
    `See the Manual below.`));
}

export function mountHeadset(root, cfg) {
  const head = onHeadset();
  const intro = head
    ? `**Install right here on your headset**, no PC needed. Needs a recent headset update (Settings → General → Software update).`
    : `Your browser can't talk to USB devices, so the one-click USB install only works in **Chrome** or **Edge**. ` +
      `You can still download the APK here, or open this page in the **Meta Quest Browser on the headset** and install it there without a PC.`;
  const kids = [el("p", { class: "inst-msg" + (head ? " inst-ok" : " inst-warn") }, md(intro))];

  if (cfg.mode === "winlator") {
    const w = cfg.winlatorxr, m = cfg.mod;
    kids.push(
      el("div", { class: "inst-step" },
        el("div", { class: "inst-step-head" }, el("span", { class: "inst-num" }, "1"), el("strong", {}, `WinlatorXR (${w.name})`)),
        dlButton({ name: w.url.split("/").pop(), url: w.url, size: w.size }),
        head ? steps(headsetSteps(w.url.split("/").pop())) : null),
      el("div", { class: "inst-step" },
        el("div", { class: "inst-step-head" }, el("span", { class: "inst-num" }, "2"), el("strong", {}, `${cfg.game || "The"} mod`)),
        dlButton(m, false),
        el("p", { class: "inst-step-text" }, md(m.kind === "zip"
          ? `The mod goes into your own **${m.game_label || "game"}** folder in /sdcard/Download/${m.folder}. The game files come from your PC, so this part needs a PC once: see the Manual below.`
          : `Follow the Manual below to put the container image in place.`))),
    );
  } else {
    const assets = cfg.assets;
    const a = pickForHeadset(assets);
    kids.push(dlButton(a));
    // Other APKs of the release (e.g. the PICO build) as small links.
    const others = assets.filter((x) => x !== a);
    if (others.length) kids.push(el("p", { class: "inst-small" }, "Other headset: ",
      ...others.map((x, i) => [i ? ", " : "", el("a", { href: x.url, download: x.name, rel: "noopener" }, `${x.name} (${fmtSize(x.size)})`)]).flat()));
    if (head) kids.push(steps(headsetSteps(a.name)));
    else kids.push(el("p", { class: "inst-small" }, md("Then install it with SideQuest or adb install -r (see the Manual below).")));
    const dn = dataNote(cfg);
    if (dn) kids.push(dn);
  }
  root.replaceChildren(el("div", { class: "inst-body" }, ...kids.filter(Boolean)));
  // The "First time?" help is about USB + developer mode: not needed on the headset.
  const help = head && root.closest(".install-card") && root.closest(".install-card").querySelector(".inst-help");
  if (help) help.hidden = true;
}
