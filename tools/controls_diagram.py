#!/usr/bin/env python3
"""Render controller-mapping pictures for the port pages.

Reads `controls_diagram` from each games.json entry and writes
images/controls/<slug>.webp: two Meta Quest Touch controllers over a blurred
picture of the game, with a label for every bound input.

    uv run --with pillow tools/controls_diagram.py            # all games with a diagram
    uv run --with pillow tools/controls_diagram.py xonotic    # one game
    uv run --with pillow tools/controls_diagram.py xonotic --svg   # also keep the SVG/HTML

Needs Chromium (Playwright's download is found automatically, or set CHROME=...).

games.json format (all keys optional, a missing key = no label):

    "controls_diagram": {
      "left":  {"stick": ["press - ...", "directions - ..."], "y": "...", "x": "...",
                "menu": "...", "trigger": "...", "grip": "..."},
      "right": {"stick": [...], "b": "...", "a": "...", "system": "system menu",
                "trigger": "...", "grip": "..."},
      "background": "2-silent-siege.jpg"      # picture in images/<slug>/, default = header picture
    }

A label is a string or a list of lines.
"""
import glob
import html
import json
import math
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_FILE = os.path.join(ROOT, "tools", "fonts", "OpenSans-Bold.ttf")
OUT_DIR = os.path.join(ROOT, "images", "controls")

W, H = 1680, 800
CX = W / 2
FS = 30            # label font size
LH = 38            # label line height
INK = "#232832"    # controller outline
BODY = "#eef0f3"   # controller fill
SHADE = "#d5d9df"  # controller shaded parts

# Left controller in local coordinates (inner side = +x). The right one is the mirror image.
LX, TY = CX - 505, 60

FACE = dict(cx=250, cy=170, rx=205, ry=122, rot=-10)
UNDER = dict(cx=275, cy=228, rx=180, ry=104, rot=-10)
HANDLE = ("M 70,250 C 38,380 52,525 92,612 C 116,668 205,684 240,640 "
          "C 272,600 292,522 330,425 C 352,368 378,325 405,290 Z")
GRIP = ("M 286,392 C 318,396 336,420 330,448 C 322,488 302,528 276,552 "
        "C 254,570 222,560 222,532 C 222,490 236,440 252,410 C 260,396 272,390 286,392 Z")
TRIGGER = ("M 392,250 C 432,244 462,272 458,312 C 455,346 432,370 410,366 "
           "C 396,336 388,292 392,250 Z")
STICK = (205, 112)
BTN_Y = (300, 150)     # B on the right controller
BTN_X = (215, 205)     # A
BTN_MENU = (130, 196)  # Meta button on the right controller

# Where each label's leader line ends, local coordinates.
ANCHORS = {
    "stick": (STICK[0] - 30, STICK[1] - 40),
    "btn2": (BTN_Y[0] - 8, BTN_Y[1] - 19),
    "btn1": (BTN_X[0] - 8, BTN_X[1] - 19),
    "menu": (BTN_MENU[0] - 8, BTN_MENU[1] - 12),
    "trigger": (450, 330),
    "grip": (318, 470),
}
# Round parts a leader line must not cross: slot -> (center, rx, ry), local coordinates.
PARTS = {
    "stick": ((STICK[0], STICK[1] - 24), 38, 27),
    "btn2": (BTN_Y, 25, 19.5),
    "btn1": (BTN_X, 25, 19.5),
    "menu": (BTN_MENU, 17, 13.3),
}
KEYS = {
    "left": {"stick": "stick", "y": "btn2", "x": "btn1", "menu": "menu", "trigger": "trigger", "grip": "grip"},
    "right": {"stick": "stick", "b": "btn2", "a": "btn1", "system": "menu", "trigger": "trigger", "grip": "grip"},
}

_font = ImageFont.truetype(FONT_FILE, FS)


def text_w(s):
    return _font.getlength(s)


def to_canvas(p, hand):
    x, y = p
    return (W - (LX + x), TY + y) if hand == "right" else (LX + x, TY + y)


def ellipse_pts(cx, cy, rx, ry, rot, n=240):
    r = math.radians(rot)
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x, y = rx * math.cos(t), ry * math.sin(t)
        out.append((cx + x * math.cos(r) - y * math.sin(r), cy + x * math.sin(r) + y * math.cos(r)))
    return out


def hull(pts):
    pts = sorted(set(pts))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def poly(pts):
    return "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"


def ell(e, **attrs):
    a = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in attrs.items())
    return (f'<ellipse cx="{e["cx"]}" cy="{e["cy"]}" rx="{e["rx"]}" ry="{e["ry"]}" '
            f'transform="rotate({e["rot"]} {e["cx"]} {e["cy"]})" {a}/>')


def controller_shape():
    """Line drawing of the left controller, local coordinates."""
    head = poly(hull(ellipse_pts(**FACE) + ellipse_pts(**UNDER)))
    sx, sy = STICK
    s = []
    s.append(f'<path d="{TRIGGER}" fill="{SHADE}"/>')
    s.append(f'<path d="{HANDLE}" fill="{BODY}"/>')
    s.append(f'<path d="{GRIP}" fill="{SHADE}"/>')
    s.append(f'<path d="{head}" fill="#dde1e7"/>')
    s.append(ell(FACE, fill="#f7f8fa"))
    # thumbstick: well, column, cap
    s.append(f'<ellipse cx="{sx}" cy="{sy}" rx="50" ry="36" fill="{SHADE}"/>')
    s.append(f'<path d="M {sx-20},{sy} L {sx-20},{sy-20} L {sx+20},{sy-20} L {sx+20},{sy} Z" fill="{BODY}"/>')
    s.append(f'<ellipse cx="{sx}" cy="{sy-24}" rx="38" ry="27" fill="#f7f8fa"/>')
    s.append(f'<ellipse cx="{sx}" cy="{sy-24}" rx="24" ry="16" fill="none" stroke-width="2.5"/>')
    for (bx, by), r in ((BTN_Y, 25), (BTN_X, 25), (BTN_MENU, 17)):
        s.append(f'<ellipse cx="{bx}" cy="{by}" rx="{r}" ry="{r*0.78:.1f}" fill="{INK}"/>')
    return f'<g stroke="{INK}" stroke-width="4" stroke-linejoin="round">{"".join(s)}</g>'


def button_glyphs(hand):
    """Letters on the buttons, drawn unmirrored."""
    out = []
    letters = (("Y", BTN_Y), ("X", BTN_X)) if hand == "left" else (("B", BTN_Y), ("A", BTN_X))
    for ch, p in letters:
        x, y = to_canvas(p, hand)
        out.append(f'<text x="{x:.1f}" y="{y+9:.1f}" font-size="27" fill="#fff" text-anchor="middle">{ch}</text>')
    x, y = to_canvas(BTN_MENU, hand)
    if hand == "left":   # menu: three bars
        for dy in (-5, 0, 5):
            out.append(f'<line x1="{x-7:.1f}" y1="{y+dy:.1f}" x2="{x+7:.1f}" y2="{y+dy:.1f}" stroke="#fff" stroke-width="2"/>')
    else:                # system button: a ring
        out.append(f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="7.5" ry="5.5" fill="none" stroke="#fff" stroke-width="2.4"/>')
    return "".join(out)


def outline_extent(hand):
    """Outermost x of the controller for each canvas row (for hugging labels)."""
    pts = hull(ellipse_pts(**FACE) + ellipse_pts(**UNDER))
    return [to_canvas(p, hand) for p in pts]


def lines_of(v):
    return [v] if isinstance(v, str) else list(v)


def layout(spec):
    """Return label blocks: dict(lines, x, y, anchor, align)."""
    blocks = []
    for hand in ("left", "right"):
        hs = spec.get(hand, {})
        if hand == "right" and "system" not in hs:
            hs = dict(hs, system="system menu")
        outer, center = [], []
        for key, slot in KEYS[hand].items():
            if not hs.get(key):
                continue
            item = dict(lines=lines_of(hs[key]), anchor=to_canvas(ANCHORS[slot], hand), slot=slot, hand=hand)
            (center if slot in ("trigger", "grip") else outer).append(item)
        # outer column: stacked top-down in anchor order, text hugging the controller
        outer.sort(key=lambda it: it["anchor"][1] + 0.45 * abs(it["anchor"][0] - CX))
        edge = outline_extent(hand)
        y = 24
        for it in outer:
            h = len(it["lines"]) * LH
            ax, ay = it["anchor"]
            y = max(y, ay - h / 2 - 46)
            mid = y + h / 2
            if hand == "left":
                near = [px for px, py in edge if abs(py - mid) < 30]
                lim = min(near) - 22 if near else ax - 80
                xe = min(ax - 80, lim)
            else:
                near = [px for px, py in edge if abs(py - mid) < 30]
                lim = max(near) + 22 if near else ax + 80
                xe = max(ax + 80, lim)
            it.update(x=xe, y=y, align="end" if hand == "left" else "start")
            blocks.append(it)
            y += h + 26
        for it in center:
            it["align"] = "middle"
        blocks.extend(center)
    # center column: the four trigger/grip labels in rows between the handles
    order = [("left", "trigger"), ("right", "trigger"), ("left", "grip"), ("right", "grip")]
    y = 470
    for hand, slot in order:
        for it in blocks:
            if it["hand"] == hand and it["slot"] == slot:
                it["x"] = CX + (-30 if hand == "left" else 30)
                it["y"] = y
                y += len(it["lines"]) * LH + 30
    return blocks


def seg_hits(p, q, part, pad=7):
    """Does segment p-q pass through the (padded) ellipse part?"""
    (cx, cy), rx, ry = part
    k = rx / ry
    ax, ay, bx, by = p[0] - cx, (p[1] - cy) * k, q[0] - cx, (q[1] - cy) * k
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) or 1)))
    return math.hypot(ax + t * dx, ay + t * dy) < rx + pad


def pick_anchor(b, start):
    """Point on the part's rim with the shortest line that misses every other part."""
    if b["slot"] not in PARTS:
        return b["anchor"]
    parts = {(h, s): ((to_canvas(c, h)), rx, ry) for h in ("left", "right") for s, (c, rx, ry) in PARTS.items()}
    own = parts[(b["hand"], b["slot"])]
    (cx, cy), rx, ry = own
    best = None
    for deg in range(0, 360, 10):
        a = math.radians(deg)
        q = (cx + (rx + 2) * math.cos(a), cy + (ry + 2) * math.sin(a))
        if seg_hits(start, q, own, pad=-4):          # line would run across its own button
            continue
        bad = sum(seg_hits(start, q, pt) for key, pt in parts.items() if key != (b["hand"], b["slot"]))
        cost = bad * 10000 + math.dist(start, q)
        if best is None or cost < best[0]:
            best = (cost, q)
    return best[1]


def label_svg(b):
    out = []
    n = len(b["lines"])
    x, y = b["x"], b["y"]
    widths = [text_w(s) for s in b["lines"]]
    wmax = max(widths)
    ax, ay = b["anchor"]
    if b["align"] == "end":
        sx, sy = x + 10, y + n * LH / 2 - 4
    elif b["align"] == "start":
        sx, sy = x - 10, y + n * LH / 2 - 4
    else:  # centered label below the anchor: start at the top edge
        sx = min(max(ax, x - wmax / 2 + 10), x + wmax / 2 - 10)
        sy = y - 6
    ax, ay = pick_anchor(b, (sx, sy))
    out.append(f'<line x1="{sx:.1f}" y1="{sy:.1f}" x2="{ax:.1f}" y2="{ay:.1f}" class="lead"/>')
    out.append(f'<circle cx="{ax:.1f}" cy="{ay:.1f}" r="5" class="dot"/>')
    for i, s in enumerate(b["lines"]):
        out.append(f'<text x="{x:.1f}" y="{y + (i + 1) * LH - 10:.1f}" text-anchor="{b["align"]}" class="lbl">{html.escape(s)}</text>')
    return "".join(out)


def build_html(spec, bg_path):
    shape = controller_shape()
    blocks = layout(spec)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<style>
 text {{ font-family: 'OS'; font-weight: 700; }}
 .lbl {{ font-size: {FS}px; fill: #fff; paint-order: stroke; stroke: rgba(10,14,22,.55); stroke-width: 6px; stroke-linejoin: round; }}
 .lead {{ stroke: #fff; stroke-width: 3; stroke-linecap: round; filter: drop-shadow(0 0 3px rgba(0,0,0,.6)); }}
 .dot {{ fill: #fff; stroke: {INK}; stroke-width: 2.5; }}
</style>
<g filter="url(#sh)">
 <g transform="translate({LX} {TY})">{shape}</g>
 <g transform="translate({W - LX} {TY}) scale(-1 1)">{shape}</g>
</g>
<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-opacity=".45"/></filter>
{button_glyphs("left")}{button_glyphs("right")}
{"".join(label_svg(b) for b in blocks)}
</svg>"""
    page = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {{ font-family: 'OS'; src: url('file://{FONT_FILE}'); font-weight: 700; }}
html, body {{ margin: 0; width: {W}px; height: {H}px; overflow: hidden; background: #111a28; }}
.bg {{ position: absolute; inset: -40px; background: url('file://{bg_path}') center/cover;
       filter: blur(9px) brightness(.42) saturate(.85); }}
svg {{ position: absolute; inset: 0; }}
</style></head><body><div class="bg"></div>{svg}</body></html>"""
    return page, svg


def find_chrome():
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    for pat in ("~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome",
                "~/.cache/ms-playwright/chromium-*/chrome-linux/chrome"):
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        if hits:
            return hits[-1]
    for name in ("chromium", "chromium-browser", "google-chrome"):
        for d in os.environ.get("PATH", "").split(":"):
            if os.path.exists(os.path.join(d, name)):
                return os.path.join(d, name)
    sys.exit("Chromium not found: set CHROME=/path/to/chrome")


def is_logo(name):
    return name.lower().endswith(".svg") or any(k in name.lower() for k in ("logo", "banner", "splash", "product"))


def header_picture(game):
    """The page's header picture, or its first game picture when the header is a logo."""
    d = os.path.join(ROOT, "images", game["slug"])
    imgs = sorted(f for f in os.listdir(d) if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
    hero = game.get("hero")
    if hero and not is_logo(hero):
        return os.path.join(d, hero)
    shots = [f for f in imgs if not is_logo(f)] or imgs
    return os.path.join(d, shots[0])


def render(game, keep_svg=False):
    spec = game["controls_diagram"]
    bg = os.path.join(ROOT, "images", game["slug"], spec["background"]) if spec.get("background") else header_picture(game)
    page, svg = build_html(spec, bg)
    os.makedirs(OUT_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        hp, png = os.path.join(tmp, "d.html"), os.path.join(tmp, "d.png")
        open(hp, "w").write(page)
        subprocess.run([find_chrome(), "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                        "--allow-file-access-from-files", f"--window-size={W},{H}", "--virtual-time-budget=3000",
                        f"--screenshot={png}", "file://" + hp], check=True, capture_output=True)
        out = os.path.join(OUT_DIR, game["slug"] + ".webp")
        Image.open(png).convert("RGB").save(out, "WEBP", quality=86, method=6)
        if keep_svg:
            open(os.path.join(OUT_DIR, game["slug"] + ".html"), "w").write(page)
    print(out, os.path.getsize(out) // 1024, "KB")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    games = json.load(open(os.path.join(ROOT, "games.json"), encoding="utf-8"))["games"]
    todo = [g for g in games if g.get("controls_diagram") and (not args or g["slug"] in args)]
    if not todo:
        sys.exit("no game with controls_diagram matches")
    for g in todo:
        render(g, keep_svg="--svg" in sys.argv)


if __name__ == "__main__":
    main()
