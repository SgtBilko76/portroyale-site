// Port Royale browser installer: installs ports on a Meta Quest or PICO
// headset over USB (WebUSB + ADB, via Tango / ya-webadb).
// Built into ../../installer.js by `npm run build` in installer/.
//
// The page holds <div class="installer" data-config='{...}'> boxes:
//   native ports:  { "relay", "game", "assets": [{name, url, size}] }
//   WinlatorXR:    { "mode": "winlator", "relay", "game", "winlatorxr": {...}, "mod": {...} }
// Downloads go through the relay (GitHub release downloads have no CORS headers).

import { mountApk } from "./apk.js";
import { mountWinlator } from "./winlator.js";
import { mountHeadset, onHeadset } from "./headset.js";
import { usbSupported } from "./common.js";

document.querySelectorAll(".installer[data-config]").forEach((root) => {
  const cfg = JSON.parse(root.dataset.config);
  // On the headset itself (Quest / PICO browser) or in browsers without WebUSB
  // (Firefox, Safari): direct download + install with the headset's Files app.
  if (onHeadset() || !usbSupported()) mountHeadset(root, cfg);
  else if (cfg.mode === "winlator") mountWinlator(root, cfg);
  else mountApk(root, cfg);
});
