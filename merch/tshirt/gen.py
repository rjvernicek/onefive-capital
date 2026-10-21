import sys, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

FD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
OUT = sys.argv[1]
GREEN = "#00704A"   # Philly street-blade green
WHITE = "#FFFFFF"

fonts = {k: TTFont(os.path.join(FD, f)) for k, f in
         {"b": "Overpass-Bold.ttf", "xb": "Overpass-XB.ttf"}.items()}

def text_path(s, font, size, x, y, anchor="start", tracking=0):
    """Outline text: returns (svg path d, width). y is baseline."""
    f = fonts[font]
    upm = f["head"].unitsPerEm
    cmap = f.getBestCmap(); gs = f.getGlyphSet(); hmtx = f["hmtx"]
    sc = size / upm
    names = [cmap[ord(c)] for c in s]
    width = sum(hmtx[n][0] for n in names) * sc + tracking * size * (len(s) - 1)
    if anchor == "middle": x -= width / 2
    elif anchor == "end": x -= width
    pen = SVGPathPen(gs)
    cx = x
    for n in names:
        tp = TransformPen(pen, (sc, 0, 0, -sc, cx, y))
        gs[n].draw(tp)
        cx += hmtx[n][0] * sc + tracking * size
    return pen.getCommands(), width

def arrow(x, y, length, size, direction):
    """Long-shaft arrow as on the city's block-number band; y is the centre line."""
    t, hl = size * 0.09, size * 0.42
    s = 1 if direction > 0 else -1
    tip = x + s * length
    base = tip - s * hl
    return (f'<path d="M{x},{y-t/2} L{base},{y-t/2} L{base},{y-hl*0.55} L{tip},{y} '
            f'L{base},{y+hl*0.55} L{base},{y+t/2} L{x},{y+t/2} Z" fill="{WHITE}"/>')

def liberty_bell(cx, cy, size):
    """Liberty Bell mark, drawn in a 100-unit box centred on (cx, cy)."""
    k = size / 100
    tf = f'transform="translate({cx-50*k:.2f},{cy-50*k:.2f}) scale({k:.4f})"'
    return (f'<g {tf}><rect x="41" y="2" width="18" height="9" rx="2" fill="{WHITE}"/>'
            f'<path d="M32,22 C32,6 68,6 68,22 L70,58 C72,72 84,76 90,82 L10,82 '
            f'C16,76 28,72 30,58 Z" fill="{WHITE}"/>'
            f'<rect x="8" y="82" width="84" height="6" rx="2" fill="{WHITE}"/>'
            f'<circle cx="50" cy="95" r="5" fill="{WHITE}"/>'
            f'<path d="M55,26 L51,40 L57,52 L52,66 L56,82" fill="none" stroke="{GREEN}" '
            f'stroke-width="3.5" stroke-linejoin="bevel"/></g>')

def blade(x, y, w, h, num, suffix, kind, block_l, dirn, block_r):
    r, inset = h * 0.07, h * 0.04
    sw = h * 0.022
    parts = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r:.2f}" fill="{GREEN}"/>',
             f'<rect x="{x+inset:.2f}" y="{y+inset:.2f}" width="{w-2*inset:.2f}" height="{h-2*inset:.2f}" '
             f'rx="{r-inset*0.6:.2f}" fill="none" stroke="{WHITE}" stroke-width="{sw:.2f}"/>']
    # Liberty Bell, top-left corner
    parts.append(liberty_bell(x + h * 0.25, y + h * 0.27, h * 0.27))
    # block-number band:  <-- 1500  S  1600 -->
    bs, by = h * 0.15, y + h * 0.3
    mid = x + w / 2
    d, wd = text_path(dirn, "b", bs * 1.25, mid, by + bs * 0.45, "middle")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    gap = bs * 0.5
    d, wl = text_path(block_l, "b", bs, mid - wd / 2 - gap, by + bs * 0.36, "end")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    d, wr = text_path(block_r, "b", bs, mid + wd / 2 + gap, by + bs * 0.36, "start")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    alen = h * 0.42
    lx = mid - wd / 2 - gap - wl - gap * 0.6
    rx = mid + wd / 2 + gap + wr + gap * 0.6
    parts.append(arrow(lx, by, alen, bs, -1))
    parts.append(arrow(rx, by, alen, bs, 1))
    # street name:  15TH ST  (raised, smaller suffix)
    ns, base = h * 0.5, y + h * 0.86
    ss = ns * 0.5
    _, w1 = text_path(num, "b", ns, 0, 0)
    _, w2 = text_path(suffix, "b", ss, 0, 0)
    _, w3 = text_path(kind, "b", ns, 0, 0)
    sp = ns * 0.3
    total = w1 + ns * 0.04 + w2 + sp + w3
    cx = mid - total / 2
    for txt, size, yy, adv in ((num, ns, base, w1 + ns * 0.04),
                               (suffix, ss, base - ns * 0.36, w2 + sp),
                               (kind, ns, base, w3)):
        d, _ = text_path(txt, "b", size, cx, yy)
        parts.append(f'<path d="{d}" fill="{WHITE}"/>')
        cx += adv
    return "\n  ".join(parts)

def svg(w, h, body, bg=None):
    bgr = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
            f'width="{w/100}in" height="{h/100}in">\n  {bgr}{body}\n</svg>\n')

# ---- FRONT: 11in x 4in print (100 units / inch) ----
FW, FH = 1100, 400
front = blade(0, 0, FW, FH, "15", "TH", "ST", "1500", "S", "1600")
open(f"{OUT}/front-street-sign.svg", "w").write(svg(FW, FH, front))

# ---- BACK YOKE: 3.5in wide wordmark, centred below collar ----
YW, YH = 400, 80
d, wd = text_path("ONEFIVE", "xb", 54, YW / 2, 52, "middle", tracking=0.08)
yoke = f'<path d="{d}" fill="{GREEN}"/>'
d2, _ = text_path("PHILADELPHIA", "b", 15, YW / 2, 76, "middle", tracking=0.42)
yoke += f'\n  <path d="{d2}" fill="{GREEN}"/>'
open(f"{OUT}/back-yoke-onefive.svg", "w").write(svg(YW, YH, yoke))
print("ok")
