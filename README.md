# Portroyale site

Static website for the Portroyale VR ports. There's one page per GitHub repo, with pictures, a manual (install steps and controller mapping), download links and the GitHub Sponsors button.

## Build

    python3 build.py            # build into public/ from games.json + cached releases
    python3 build.py --refresh  # fetch the latest releases from GitHub first

Open `public/index.html` in a browser. To host it, upload the contents of `public/` to any web host.

## Edit

- **Texts, features, install steps, controls:** `games.json`. It supports `**bold**`, `*italic*`, `` `code` `` and `[links](https://...)`. Use `"install": "default"` for the standard sideload steps.
- **Pictures:** put them in `images/<slug>/`. They're shown in file-name order, and the first one is the header picture. Files with `logo`, `banner` or `splash` in the name are shown whole instead of cropped. A port with no pictures gets a red title card.
- **Downloads:** these come from each repo's GitHub releases. Run `--refresh` after publishing a release.
- **Look:** `style.css`.

## Online

The site is published with GitHub Pages at https://portroyale.online. Every push to `main` rebuilds and deploys it (`.github/workflows/deploy.yml`). The workflow also runs once a day, so new GitHub releases appear on the site automatically.
