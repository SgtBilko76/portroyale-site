#!/usr/bin/env python3
"""Build the Port Royale site into public/.

    python3 build.py            build from games.json and the cached release data
    python3 build.py --refresh  also fetch the latest releases from GitHub first

Pictures: drop files into images/<slug>/. They are shown in name order, the
first one is the page's hero picture, unless the game sets "hero" to a file name. Files with "logo", "banner", "splash" or "product"
in the name are shown whole instead of cropped.
"""
import html
import json
import os
import re
import shutil
import sys
import urllib.request
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "public"
IMAGES = ROOT / "images"
CACHE = ROOT / "releases.json"
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}

DEFAULT_INSTALL = [
    "Enable developer mode on your Quest.",
    "Download the APK below.",
    "Sideload it with [SideQuest](https://sidequestvr.com/setup-howto) or `adb install -r <file>.apk`.",
    "Launch it from *Library → Unknown Sources*.",
]


# ---------------------------------------------------------------- helpers

def inline(text):
    """Escape text and apply the small Markdown subset used in games.json."""
    codes = []

    def keep_code(m):
        codes.append(f"<code>{html.escape(m.group(1))}</code>")
        return f"\x00{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", keep_code, text)
    text = html.escape(text, quote=False)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
                  lambda m: f'<a href="{html.escape(m.group(2))}" target="_blank" rel="noopener">{m.group(1)}</a>',
                  text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], text)


def esc(text):
    return html.escape(str(text))


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024


def human_date(iso):
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%d %b %Y")
    except (TypeError, ValueError):
        return ""


def images_for(slug):
    folder = IMAGES / slug
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMG_EXT)


def hero_image(game, imgs):
    """Page header picture: the "hero" name from games.json, else the first picture."""
    name = game.get("hero")
    if name:
        for img in imgs:
            if img.name == name:
                return img
    return imgs[0] if imgs else None


def is_whole(path):
    return any(k in path.name.lower() for k in ("logo", "banner", "splash", "product"))


# ---------------------------------------------------------------- releases

def _gh_json(url):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "portroyale-site-builder"}
    # Unauthenticated requests are limited to 60 per hour, which one refresh of
    # all the repos can exhaust. GITHUB_TOKEN / GH_TOKEN (e.g. `gh auth token`,
    # or the token the GitHub Actions workflow already has) raises that a lot.
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def _assets_of(user, repo, rel):
    """Assets of a release. The releases list sometimes comes back without them
    right after an upload, so ask for the single release in that case."""
    assets = rel.get("assets") or []
    if not assets and rel.get("id"):
        try:
            assets = _gh_json(f"https://api.github.com/repos/{user}/{repo}/releases/{rel['id']}").get("assets") or []
        except Exception as e:
            print(f"  ! {repo} {rel.get('tag_name')}: {e}")
    return [{"name": a["name"], "size": a["size"], "url": a["browser_download_url"]}
            for a in assets if not a["name"].endswith(".sha256")]


def fetch_releases(user, games):
    data = {}
    for g in games:
        url = f"https://api.github.com/repos/{user}/{g['repo']}/releases?per_page=5"
        try:
            rels = _gh_json(url)
        except Exception as e:  # keep whatever the cache had
            print(f"  ! {g['repo']}: {e}")
            continue
        data[g["repo"]] = [{
            "tag": x["tag_name"],
            "name": x.get("name") or x["tag_name"],
            "date": x.get("published_at") or x.get("created_at"),
            "prerelease": x.get("prerelease", False),
            "url": x["html_url"],
            "assets": _assets_of(user, g["repo"], x),
        } for x in rels if not x.get("draft")]
        print(f"  {g['repo']}: {len(data[g['repo']])} release(s)")
    return data


# ---------------------------------------------------------------- layout

def seo_head(site, title, desc, path, image, ld):
    url = f"{site['url']}/{path}"
    img = f"{site['url']}/{image}" if image else f"{site['url']}/images/site/logo.png"
    tags = [
        f'<link rel="canonical" href="{esc(url)}">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{esc(site["title"])}">',
        f'<meta property="og:title" content="{esc(title)}">',
        f'<meta property="og:description" content="{esc(desc)}">',
        f'<meta property="og:url" content="{esc(url)}">',
        f'<meta property="og:image" content="{esc(img)}">',
        '<meta name="twitter:card" content="summary_large_image">',
    ]
    if ld:
        tags.append('<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False).replace("</", "<\\/") + "</script>")
    return "\n".join(tags)


def page(site, title, body, desc="", path="", image=None, ld=None):
    desc = desc or site["tagline"]
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
{seo_head(site, title, desc, path, image, ld)}
<link rel="icon" href="images/site/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Open+Sans:wght@400;600;700&display=swap">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="topbar">
  <div class="wrap topbar-inner">
    <a class="brand" href="index.html"><span>{esc(site['title'])}</span></a>
    <nav class="nav" aria-label="Main">
      <a href="index.html#native">Ports</a>
      <a href="index.html#emulator">Emulators</a>
      <a href="index.html#winlator">WinlatorXR</a>
      <a href="https://github.com/{esc(site['github_user'])}" target="_blank" rel="noopener">GitHub</a>
      <a class="btn btn-kofi btn-sm" href="{esc(site['kofi_url'])}" target="_blank" rel="noopener">{KOFI} Ko-fi</a>
    </nav>
  </div>
</header>
<main id="main">
{body}
</main>
<footer class="footer">
  <div class="wrap footer-inner">
    <div>
      <p class="footer-title">{esc(site['title'])}</p>
      <p>{esc(site['tagline'])}</p>
    </div>
    <div>
      <p class="footer-head">Best regards to</p>
      <p>{esc(site['thanks'])}</p>
    </div>
    <div>
      <p class="footer-head">Source</p>
      <p>Every port is free and open source on <a href="https://github.com/{esc(site['github_user'])}" target="_blank" rel="noopener">GitHub</a>.</p>
    </div>
  </div>
  <p class="wrap fineprint">All game names and trademarks belong to their owners. Ports of commercial games contain no game data: you need your own copy.</p>
</footer>
</body>
</html>
"""


HEART = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14.3 1.9 8.4A3.8 3.8 0 0 1 8 3.6a3.8 3.8 0 0 1 6.1 4.8Z"/></svg>'
GH = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 0Z"/></svg>'
KOFI = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h9.2a3.3 3.3 0 0 1 0 6.6h-.6A4 4 0 0 1 6.7 13H5.3A3.3 3.3 0 0 1 2 9.7Zm9.2 4.9a1.6 1.6 0 0 0 0-3.2h-.5v3.2ZM1.5 14h10v1.5h-10Z"/></svg>'
DL = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 1h2v7.2l2.6-2.6L13 7l-5 5-5-5 1.4-1.4L7 8.2ZM2 13h12v2H2Z"/></svg>'


def picture(game, img, cls="", eager=False):
    if img is None:
        return f'<div class="titlecard {cls}"><span>{esc(game["name"])}</span></div>'
    whole = " whole" if is_whole(img) else ""
    rel = img.relative_to(ROOT).as_posix()
    load = "" if eager else ' loading="lazy"'
    return f'<img class="{cls}{whole}" src="{esc(rel)}" alt="{esc(game["name"])}"{load}>'


def latest(releases):
    return releases[0] if releases else None


# ---------------------------------------------------------------- index

def build_index(site, cats, games, rels):
    parts = [f"""
<section class="hero">
  <div class="wrap hero-inner">
    <div>
      <p class="eyebrow">Welcome to {esc(site['title'])}</p>
      <h1>{esc(site['tagline'])}</h1>
      <p class="lead">{esc(site['intro'])}</p>
      <div class="actions">
        <a class="btn btn-primary" href="#native">Browse the ports</a>
        <a class="btn btn-kofi" href="{esc(site['kofi_url'])}" target="_blank" rel="noopener">{KOFI} Ko-fi</a>
      </div>
      <ul class="stats">
        <li><strong>{len(games)}</strong> VR ports</li>
        <li><strong>100%</strong> free</li>
        <li><strong>0</strong> PCs needed</li>
      </ul>
    </div>
  </div>
</section>"""]
    for c in cats:
        members = [g for g in games if g["category"] == c["id"]]
        if not members:
            continue
        cards = []
        for g in members:
            imgs = images_for(g["slug"])
            rel = latest(rels.get(g["repo"], []))
            badge = f'<span class="badge">{esc(rel["tag"])}</span>' if rel else ""
            cards.append(f"""
      <a class="card" href="{esc(g['slug'])}.html">
        <div class="card-media">{picture(g, imgs[0] if imgs else None, "card-img")}{badge}</div>
        <div class="card-body">
          <h3>{esc(g['name'])}</h3>
          <p>{inline(g['tagline'])}</p>
          <span class="more">Details, manual &amp; download →</span>
        </div>
      </a>""")
        parts.append(f"""
<section class="section" id="{esc(c['id'])}">
  <div class="wrap">
    <h2 class="section-title">{esc(c['name'])}</h2>
    <p class="section-blurb">{esc(c['blurb'])}</p>
    <div class="grid">{''.join(cards)}
    </div>
  </div>
</section>""")
    parts.append(f"""
<section class="section sponsor-band">
  <div class="wrap sponsor-inner">
    <div>
      <h2>Keep the ports coming</h2>
      <p>Every port here is free and open source. A coffee on Ko-fi pays for the hours that go into the next one.</p>
    </div>
    <div class="actions">
      <a class="btn btn-kofi btn-lg" href="{esc(site['kofi_url'])}" target="_blank" rel="noopener">{KOFI} Buy me a coffee</a>
    </div>
  </div>
</section>""")
    ld = {"@context": "https://schema.org", "@type": "WebSite", "name": site["title"],
          "url": site["url"] + "/", "description": site["intro"]}
    return page(site, f"{site['title']} | {site['tagline']}", "".join(parts), site["intro"], "", None, ld)


# ---------------------------------------------------------------- game page

def build_game(site, cats, game, rels, prev_g, next_g):
    user = site["github_user"]
    repo_url = f"https://github.com/{user}/{game['repo']}"
    releases = rels.get(game["repo"], [])
    rel = latest(releases)
    imgs = images_for(game["slug"])
    cat = next(c for c in cats if c["id"] == game["category"])

    primary = None
    if rel and rel["assets"]:
        # A release with separate Quest and PICO APKs lists them
        # alphabetically, PICO first; the main button is for Quest.
        primary = next((a for a in rel["assets"] if "pico" not in a["name"].lower()),
                       rel["assets"][0])
    dl_btn = (f'<a class="btn btn-primary" href="{esc(primary["url"])}">{DL} Download {esc(rel["tag"])}</a>'
              if primary else
              f'<a class="btn btn-primary" href="{repo_url}/releases" target="_blank" rel="noopener">{DL} Releases</a>')

    facts = []
    if rel:
        facts.append(("Latest release", f'<a href="{esc(rel["url"])}" target="_blank" rel="noopener">{esc(rel["name"])}</a>'))
        if human_date(rel["date"]):
            facts.append(("Released", human_date(rel["date"])))
        if primary:
            facts.append(("Download size", human_size(primary["size"])))
    facts.append(("Type", esc(cat["name"])))
    facts.append(("Source", f'<a href="{repo_url}" target="_blank" rel="noopener">{esc(game["repo"])}</a>'))
    facts_html = "".join(f"<div><dt>{k}</dt><dd>{v}</dd></div>" for k, v in facts)

    about = "".join(f"<p>{inline(p)}</p>" for p in game.get("about", []))
    features = "".join(f"<li>{inline(f)}</li>" for f in game.get("features", []))
    needs = "".join(f"<li>{inline(n)}</li>" for n in game.get("needs", []))

    steps = game.get("install", "default")
    if steps == "default":
        steps = DEFAULT_INSTALL
    install = "".join(f"<li>{inline(s)}</li>" for s in steps)
    if game.get("install_extra"):
        install_extra = f'<p class="note">{inline(game["install_extra"])}</p>'
    else:
        install_extra = ""

    controls = ""
    if game.get("controls"):
        c = game["controls"]
        head = "".join(f"<th scope=\"col\">{esc(h)}</th>" for h in c["columns"])
        rows = "".join(
            "<tr>" + "".join((f'<th scope="row">{inline(cell)}</th>' if i == 0 else f"<td>{inline(cell)}</td>")
                             for i, cell in enumerate(r)) + "</tr>"
            for r in c["rows"])
        note = f'<p class="note">{inline(game["controls_note"])}</p>' if game.get("controls_note") else ""
        controls = f"""
      <h3 id="controls">Controller mapping</h3>
      <div class="table-scroll"><table class="controls"><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>{note}"""
    else:
        controls = f"""
      <h3 id="controls">Controller mapping</h3>
      <p class="note">The controller mapping is documented in the <a href="{repo_url}#readme" target="_blank" rel="noopener">repository README</a>.</p>"""

    notes = ""
    if game.get("notes"):
        notes = "<h3>Good to know</h3><ul class=\"notes\">" + "".join(f"<li>{inline(n)}</li>" for n in game["notes"]) + "</ul>"

    downloads = []
    for i, r in enumerate(releases[:3]):
        files = "".join(
            f'<li><a class="file" href="{esc(a["url"])}">{DL}<span>{esc(a["name"])}</span><small>{human_size(a["size"])}</small></a></li>'
            for a in r["assets"]) or '<li class="note">No files attached.</li>'
        tag = '<span class="badge badge-inline">latest</span>' if i == 0 else ""
        downloads.append(f"""
        <div class="release">
          <p class="release-head"><a href="{esc(r['url'])}" target="_blank" rel="noopener">{esc(r['name'])}</a> {tag}<small>{esc(r['tag'])} · {human_date(r['date'])}</small></p>
          <ul class="files">{files}</ul>
        </div>""")
    if not downloads:
        downloads.append(f'<p class="note">No release yet: check the <a href="{repo_url}" target="_blank" rel="noopener">repository</a>.</p>')

    gallery = ""
    extra = imgs[1:]
    videos = game.get("videos") or ([{"id": game["video"], "label": game.get("video_label", "")}] if game.get("video") else [])
    gallery_items = []
    for v in videos:
        label = f'<span class="shot-label">{esc(v["label"])}</span>' if v.get("label") else ""
        gallery_items.append(
            f'<a class="shot video" href="https://www.youtube.com/watch?v={esc(v["id"])}" target="_blank" rel="noopener">'
            f'<img src="https://img.youtube.com/vi/{esc(v["id"])}/hqdefault.jpg" alt="Video: {esc(v.get("label") or game["name"])}" loading="lazy">'
            f'{label}<span class="play" aria-hidden="true">▶</span></a>')
    gallery_items += [f'<a class="shot" href="{esc(p.relative_to(ROOT).as_posix())}" target="_blank">{picture(game, p)}</a>' for p in extra]
    if gallery_items:
        gallery = f"""
<section class="section section-alt">
  <div class="wrap">
    <h2 class="section-title">Pictures &amp; video</h2>
    <div class="gallery">{''.join(gallery_items)}</div>
  </div>
</section>"""

    pager = ""
    if prev_g or next_g:
        left = f'<a href="{esc(prev_g["slug"])}.html">← {esc(prev_g["name"])}</a>' if prev_g else "<span></span>"
        right = f'<a href="{esc(next_g["slug"])}.html">{esc(next_g["name"])} →</a>' if next_g else "<span></span>"
        pager = f'<nav class="wrap pager" aria-label="More ports">{left}{right}</nav>'

    body = f"""
<section class="game-hero">
  <div class="game-hero-media">{picture(game, hero_image(game, imgs), "game-hero-img", eager=True)}</div>
  <div class="wrap game-hero-inner">
    <p class="crumbs"><a href="index.html">Home</a> / <a href="index.html#{esc(cat['id'])}">{esc(cat['name'])}</a></p>
    <h1>{esc(game['name'])}</h1>
    <p class="lead">{inline(game['tagline'])}</p>
    <div class="actions">
      {dl_btn}
      <a class="btn btn-ghost" href="{repo_url}" target="_blank" rel="noopener">{GH} GitHub</a>
      <a class="btn btn-kofi" href="{esc(site['kofi_url'])}" target="_blank" rel="noopener">{KOFI} Ko-fi</a>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap two-col">
    <div class="prose">
      <h2 class="section-title">About</h2>
      {about}
      <h3>Features</h3>
      <ul class="ticks">{features}</ul>
    </div>
    <aside class="facts">
      <dl>{facts_html}</dl>
      <h3>You need</h3>
      <ul class="needs">{needs}</ul>
      <a class="btn btn-primary btn-block" href="#download">{DL} Get it</a>
    </aside>
  </div>
</section>

<section class="section section-alt" id="manual">
  <div class="wrap">
    <h2 class="section-title">Manual</h2>
    <div class="manual">
      <div>
        <h3>Installation</h3>
        <ol class="steps">{install}</ol>{install_extra}
        {notes}
      </div>
      <div>{controls}
      </div>
    </div>
  </div>
</section>

<section class="section" id="download">
  <div class="wrap two-col">
    <div>
      <h2 class="section-title">Download</h2>
      {''.join(downloads)}
      <p class="note">All releases: <a href="{repo_url}/releases" target="_blank" rel="noopener">{repo_url.replace('https://', '')}/releases</a></p>
    </div>
    <aside class="sponsor-card">
      <p class="sponsor-heart">{KOFI}</p>
      <h3>Enjoying {esc(game['name'])}?</h3>
      <p>This port is free. A coffee on Ko-fi supports its development and the next ports.</p>
      <a class="btn btn-kofi btn-block" href="{esc(site['kofi_url'])}" target="_blank" rel="noopener">{KOFI} Buy me a coffee</a>
    </aside>
  </div>
</section>
{gallery}
<section class="section credits">
  <div class="wrap"><p><strong>Credits:</strong> {inline(game.get('credits', ''))}</p></div>
</section>
{pager}
"""
    desc = re.sub(r"[*`\[\]]", "", game["tagline"])
    image = next((p.relative_to(ROOT).as_posix() for p in imgs if p.suffix.lower() != ".svg"), None)
    ld = {
        "@context": "https://schema.org", "@type": "SoftwareApplication",
        "name": game["name"], "description": desc,
        "url": f"{site['url']}/{game['slug']}.html",
        "applicationCategory": "GameApplication", "operatingSystem": "Android (Meta Quest)",
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "author": {"@type": "Person", "name": site["github_user"], "url": f"https://github.com/{user}"},
        "sameAs": repo_url,
    }
    if image:
        ld["image"] = f"{site['url']}/{image}"
    if rel:
        ld["softwareVersion"] = rel["tag"]
        if primary:
            ld["downloadUrl"] = primary["url"]
    return page(site, f"{game['name']} | {site['title']}", body, desc, f"{game['slug']}.html", image, ld)


# ---------------------------------------------------------------- main

def main():
    data = json.loads((ROOT / "games.json").read_text(encoding="utf-8"))
    site, cats, games = data["site"], data["categories"], data["games"]

    rels = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    if "--refresh" in sys.argv or not rels:
        print("Fetching releases from GitHub...")
        rels.update(fetch_releases(site["github_user"], games))
        CACHE.write_text(json.dumps(rels, indent=1))

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copy(ROOT / "style.css", OUT / "style.css")
    shutil.copytree(IMAGES, OUT / "images")

    (OUT / "index.html").write_text(build_index(site, cats, games, rels), encoding="utf-8")
    ordered = [g for c in cats for g in games if g["category"] == c["id"]]
    for i, g in enumerate(ordered):
        prev_g = ordered[i - 1] if i > 0 else None
        next_g = ordered[i + 1] if i + 1 < len(ordered) else None
        (OUT / f"{g['slug']}.html").write_text(build_game(site, cats, g, rels, prev_g, next_g), encoding="utf-8")
    write_seo_files(site, ordered, rels)
    print(f"Built {len(ordered) + 1} pages into {OUT}")


def write_seo_files(site, ordered, rels):
    """sitemap.xml, robots.txt and the IndexNow key file."""
    today = date.today().isoformat()
    urls = [(f"{site['url']}/", today, "1.0")]
    for g in ordered:
        r = latest(rels.get(g["repo"], []))
        urls.append((f"{site['url']}/{g['slug']}.html", (r["date"] or today)[:10] if r else today, "0.8"))
    items = "".join(f"  <url><loc>{esc(u)}</loc><lastmod>{d}</lastmod><priority>{p}</priority></url>\n"
                    for u, d, p in urls)
    (OUT / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                                     '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                                     f"{items}</urlset>\n", encoding="utf-8")
    (OUT / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {site['url']}/sitemap.xml\n")
    if site.get("indexnow_key"):
        (OUT / f"{site['indexnow_key']}.txt").write_text(site["indexnow_key"])


if __name__ == "__main__":
    main()
