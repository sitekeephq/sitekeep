"""Generate SiteKeep brand SVGs (mark E + "SiteKeep" wordmark outlined from Liberation Sans Bold)."""
import sys, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

repo, out = sys.argv[1], sys.argv[2]
font = TTFont(os.path.join(repo, "apps/server/assets/fonts/LiberationSans-Bold.ttf"))
gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
CAP = font["OS/2"].sCapHeight or 1409

C = {
    "light": dict(site="#1F3A5F", keep="#D9861C", top=("#2E5A8A", "#1F3A5F", "#162B47"), bg=None),
    "dark": dict(site="#FFFFFF", keep="#F2A33A", top=("#4A7DB8", "#2E5A8A", "#1F3A5F"), bg="#14243A"),
}
LOWER = [("#9AA5B1", "#7D8995"), ("#F2A33A", "#D9861C"), ("#3B9A6B", "#2E7D55")]  # WIP, Shared, Published


def slab(t, left, right, top=None, h=10):
    s = ""
    if top:
        s += f'<polygon points="50,{t} 90,{t+20} 50,{t+40} 10,{t+20}" fill="{top}"/>'
    s += f'<polygon points="10,{t+20} 50,{t+40} 50,{t+40+h} 10,{t+20+h}" fill="{left}"/>'
    s += f'<polygon points="50,{t+40} 90,{t+20} 90,{t+20+h} 50,{t+40+h}" fill="{right}"/>'
    return s


def mark(mode="light", mono=None):
    """100x100 icon: four ISO 19650 state slabs, archive on top with a keyhole."""
    if mono:
        body = "".join(slab(t, mono, mono) for t in (50, 36, 22))
        body += f'<polygon points="50,2 90,22 50,42 10,22" fill="{mono}"/>' + slab(2, mono, mono)
        hole = "#FFFFFF" if mono != "#FFFFFF" else "#14243A"
    else:
        body = "".join(slab(t, l, r) for t, (l, r) in zip((50, 36, 22), LOWER))
        tp, l, r = C[mode]["top"]
        body += slab(2, l, r, top=tp)
        hole = "#FFFFFF"
    body += f'<circle cx="50" cy="19" r="5" fill="{hole}"/><polygon points="47,21 53,21 55,30 45,30" fill="{hole}"/>'
    return body


def favicon():
    """Simplified for 16-32 px: three thick slabs, no keyhole."""
    return (slab(44, "#F2A33A", "#D9861C", h=16) + slab(24, "#3B9A6B", "#2E7D55", h=16)
            + slab(4, "#1F3A5F", "#162B47", top="#2E5A8A", h=16))


def word(text, x, baseline, cap_px, color):
    s = cap_px / CAP
    parts, cx = [], 0
    for ch in text:
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[g].draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(f'<path transform="translate({x + cx*s:.2f},{baseline}) scale({s:.5f},{-s:.5f})" d="{d}"/>')
        cx += hmtx[g][0]
    return f'<g fill="{color}">{"".join(parts)}</g>', cx * s


def wordmark(x, baseline, cap, mode, mono=None):
    a, wa = word("Site", x, baseline, cap, mono or C[mode]["site"])
    b, wb = word("Keep", x + wa + cap * 0.04, baseline, cap, mono or C[mode]["keep"])
    return a + b, wa + wb + cap * 0.04


def svg(w, h, body, title, bg=None):
    rect = f'<rect width="{w:.0f}" height="{h}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h}" role="img">'
            f"<title>{title}</title>{rect}{body}</svg>\n")


def write(name, content):
    with open(os.path.join(out, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


os.makedirs(out, exist_ok=True)
write("sitekeep-mark.svg", svg(100, 100, mark(), "SiteKeep"))
write("sitekeep-mark-dark.svg", svg(100, 100, mark("dark"), "SiteKeep", C["dark"]["bg"]))
write("sitekeep-favicon.svg", svg(100, 100, favicon(), "SiteKeep"))

for mode, suffix in (("light", ""), ("dark", "-dark")):
    wm, ww = wordmark(118, 70, 42, mode)
    write(f"sitekeep-logo-horizontal{suffix}.svg",
          svg(118 + ww + 6, 100, mark(mode) + wm, "SiteKeep", C[mode]["bg"]))
    wm, ww = wordmark(0, 0, 30, mode)
    W = max(ww, 100) + 20
    wm, _ = wordmark((W - ww) / 2, 148, 30, mode)
    write(f"sitekeep-logo-stacked{suffix}.svg",
          svg(W, 160, f'<g transform="translate({(W-100)/2:.1f},6)">{mark(mode)}</g>' + wm, "SiteKeep", C[mode]["bg"]))

for color, suffix in (("#1F3A5F", "navy"), ("#FFFFFF", "white"), ("#000000", "black")):
    wm, ww = wordmark(118, 70, 42, None, mono=color)
    bg = "#14243A" if color == "#FFFFFF" else None
    write(f"sitekeep-logo-mono-{suffix}.svg", svg(118 + ww + 6, 100, mark(mono=color) + wm, "SiteKeep", bg))
print("ok", sorted(os.listdir(out)))
