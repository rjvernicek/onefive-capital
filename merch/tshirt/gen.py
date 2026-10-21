import sys, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

FD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
OUT = sys.argv[1]
GREEN = "#41715C"   # street-blade green, sampled from the reference sign
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

def cap_height(font, size):
    f = fonts[font]
    pen = BoundsPen(f.getGlyphSet())
    f.getGlyphSet()["H"].draw(pen)
    return pen.bounds[3] / f["head"].unitsPerEm * size

def arrow(cx, cy, length, size, direction):
    """Short block-band arrow; (cx, cy) is its centre."""
    t, hl = size * 0.14, size * 0.5
    s = 1 if direction > 0 else -1
    tail, tip = cx - s * length / 2, cx + s * length / 2
    base = tip - s * hl
    return (f'<path d="M{tail:.2f},{cy-t/2:.2f} L{base:.2f},{cy-t/2:.2f} L{base:.2f},{cy-hl*0.62:.2f} '
            f'L{tip:.2f},{cy:.2f} L{base:.2f},{cy+hl*0.62:.2f} L{base:.2f},{cy+t/2:.2f} '
            f'L{tail:.2f},{cy+t/2:.2f} Z" fill="{WHITE}"/>')

def liberty_bell(x, y, w):
    """White Liberty Bell hung from its yoke, drawn in a 100x110 box at (x, y)."""
    k = w / 100
    return (f'<g transform="translate({x:.2f},{y:.2f}) scale({k:.4f})" fill="{WHITE}">'
            f'<path d="M4,10 C8,2 14,4 18,8 L82,8 C86,4 92,2 96,10 C92,12 90,18 86,20 '
            f'L14,20 C10,18 8,12 4,10 Z"/>'
            f'<rect x="43" y="20" width="14" height="10" rx="2"/>'
            f'<path d="M24,46 C24,26 76,26 76,46 L78,76 C80,90 90,95 98,102 L2,102 '
            f'C10,95 20,90 22,76 Z"/>'
            f'<rect x="0" y="101" width="100" height="8" rx="3"/>'
            f'<path d="M54,40 L49,56 L56,70 L50,86 L54,102" fill="none" stroke="{GREEN}" '
            f'stroke-width="3.5" stroke-linejoin="bevel"/></g>')

def blade(W, H, name, kind, block_l, dirn, block_r):
    # Outline: raised centre tab with chamfered shoulders, flat bottom.
    sh, cl, cr = H * 0.225, W * 0.235, W * 0.795
    parts = [f'<path d="M0,{sh:.2f} L{cl:.2f},0 L{cr:.2f},0 L{W},{sh:.2f} L{W},{H} L0,{H} Z" '
             f'fill="{GREEN}"/>']
    # block-number band:  <-  1000  E  1100  ->
    bc, by = cap_height("b", 1), H * 0.155
    bs = H * 0.17 / bc
    mid = W * 0.5
    base = by + H * 0.085
    # direction letter runs ~1.4x the numbers, centred on them
    d, wd = text_path(dirn, "b", bs * 1.42, mid, by + H * 0.17 * 1.42 / 2, "middle")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    gap = bs * 0.45
    d, wl = text_path(block_l, "b", bs, mid - wd / 2 - gap, base, "end")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    d, wr = text_path(block_r, "b", bs, mid + wd / 2 + gap, base, "start")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    alen = H * 0.21
    parts.append(arrow(mid - wd / 2 - gap - wl - gap - alen / 2, by, alen, H * 0.17, -1))
    parts.append(arrow(mid + wd / 2 + gap + wr + gap + alen / 2, by, alen, H * 0.17, 1))
    # Liberty Bell at the left of the name row
    bw = W * 0.105
    baseline = H * 0.91
    parts.append(liberty_bell(W * 0.018, baseline - 109 * bw / 100, bw))
    # street-type suffix, right-aligned
    right = W * 0.975
    if kind:
        ks = H * 0.235 / bc
        d, wk = text_path(kind, "b", ks, right, baseline, "end", tracking=0.04)
        parts.append(f'<path d="{d}" fill="{WHITE}"/>')
        right -= wk + W * 0.035
    # street name, as large as fits between bell and suffix
    left = W * 0.018 + bw + W * 0.02
    ns = H * 0.46 / bc
    _, tw = text_path(name, "b", ns, 0, 0)
    ns = min(ns, ns * (right - left) / tw)
    d, _ = text_path(name, "b", ns, (left + right) / 2, baseline, "middle")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    return "\n  ".join(parts)

def svg(w, h, body, bg=None):
    bgr = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
            f'width="{w/100}in" height="{h/100}in">\n  {bgr}{body}\n</svg>\n')

# ---- FRONT: 11in x 3.1in print (100 units / inch) ----
FW, FH = 1100, 311
front = blade(FW, FH, "ONEFIVE", "ST", "1400", "N", "1500")
open(f"{OUT}/front-street-sign.svg", "w").write(svg(FW, FH, front))
front = blade(FW, FH, "ONEFIVE", "", "1400", "N", "1500")
open(f"{OUT}/front-street-sign-no-st.svg", "w").write(svg(FW, FH, front))

# ---- BACK YOKE: 3.5in wide wordmark, centred below collar ----
YW, YH = 400, 80
d, wd = text_path("ONEFIVE", "xb", 54, YW / 2, 52, "middle", tracking=0.08)
yoke = f'<path d="{d}" fill="{GREEN}"/>'
d2, _ = text_path("PHILADELPHIA", "b", 15, YW / 2, 76, "middle", tracking=0.42)
yoke += f'\n  <path d="{d2}" fill="{GREEN}"/>'
open(f"{OUT}/back-yoke-onefive.svg", "w").write(svg(YW, YH, yoke))
print("ok")
