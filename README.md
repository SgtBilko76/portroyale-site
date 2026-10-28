# Port Royale site

Static website for the Port Royale VR ports. There's one page per GitHub repo, with pictures, a manual (install steps and controller mapping), download links and the GitHub Sponsors button.

## Build

    python3 build.py            # build into public/ from games.json + cached releases
    python3 build.py --refresh  # fetch the latest releases from GitHub first

Open `public/index.html` in a browser. To host it, upload the contents of `public/` to any web host.

## Edit

- **Texts, features, install steps, controls:** `games.json`. It supports `**bold**`, `*italic*`, `` `code` `` and `[links](https://...)`. Use `"install": "default"` for the standard sideload steps.
- **Pictures:** put them in `images/<slug>/`. They're shown in file-name order, and the first one is the header picture. Files with `logo`, `banner` or `splash` in the name are shown whole instead of cropped. A port with no pictures gets a red title card.
- **Downloads:** these come from each repo's GitHub releases. Run `--refresh` after publishing a release.
- **Videos:** `"videos": [{"id": "<YouTube id>", "label": "caption"}]` in `games.json` (a single `"video"` + `"video_label"` also works).
- **Controller picture:** add `controls_diagram` to a game in `games.json` (which label goes on which button, see the top of `tools/controls_diagram.py`), then run `uv run --with pillow tools/controls_diagram.py <slug>`. It writes `images/controls/<slug>.webp` (two Quest controllers over a blurred picture of the game), and the page shows it at the top of the Manual. Commit the `.webp`; the table stays for the details.
- **Look:** `style.css`.
- **Moved pages:** `site.redirects` in `games.json` maps an old file name to its new address (e.g. `"csvr.html": "https://www.csvr.online/"`); the build writes a forwarding page so old links and search results keep working.

## Online

The site is published with GitHub Pages at https://portroyale.online. Every push to `main` rebuilds and deploys it (`.github/workflows/deploy.yml`). The workflow also runs once a day, so new GitHub releases appear on the site automatically.

## Browser installer

Port pages whose latest release has an APK get an "Install from your browser" box: it installs the APK on a Quest or PICO over USB (WebUSB + ADB, Chrome/Edge only).

- Code: `installer/src/` (built into `installer.js` with `cd installer && npm install && npm run build`; commit the built `installer.js`).
- GitHub release downloads have no CORS headers, so the APK is fetched through a Cloudflare Worker: `installer/relay/worker.js`, live at `site.apk_relay` in `games.json`. It only relays APKs from SgtBilko76 releases. Redeploy with `cd installer/relay && npx wrangler deploy`.
- Test without a browser: `installer/test/node-install-test.mjs <apk-url> [relay]` (needs `npm i --no-save usb` and `adb kill-server`).
- WinlatorXR pages: the box checks the installed WinlatorXR against the newest public release (`_winlatorxr` in `releases.json`, refreshed by `--refresh` and live in the browser), installs/updates it, copies the user's game folder and unpacks the mod. Per-game settings: `winlator_install` in `games.json` (`asset` = part of the release file name, `folder` under `/sdcard/Download`, `marker` file that proves the game folder, `game_label`, `next` = the manual steps left in WinlatorXR; `"kind": "file"` copies a container image instead).
- Game files for native ports: `data` in a game's `games.json` entry adds copy steps to its install box (folder or file pickers; see the field list at the top of `installer/src/data.js`). Full-game APKs (category `full`, "Complete games") have no `data`. Inside `Android/data/<app>` the installer creates folders with the shell (adbd can't) and makes them readable for the app.
- Test the copy on a headset: `installer/test/node-data-test.mjs <local-folder> '<data item json>'`.
- UI test with a fake headset: `node test/ui/build.mjs` (writes a test bundle into `public/`), serve `public/`, `node test/ui/shot.mjs <page-url> out.png` (needs `npm i --no-save puppeteer-core`). Rebuild with `npm run build` + `python3 build.py` afterwards.
