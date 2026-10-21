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

def sign_shape(x, y, w, h, cut):
    # Elongated hexagon: pointed ends, like the city's six-sided blades.
    return (f"M{x+cut},{y} L{x+w-cut},{y} L{x+w},{y+h/2} L{x+w-cut},{y+h} "
            f"L{x+cut},{y+h} L{x},{y+h/2} Z")

def blade(x, y, w, h, name, block, dirn):
    cut = h * 0.16
    inset = h * 0.06
    parts = [f'<path d="{sign_shape(x, y, w, h, cut)}" fill="{GREEN}"/>']
    # thin white keyline
    ix, iy, iw, ih = x + inset, y + inset, w - 2 * inset, h - 2 * inset
    parts.append(f'<path d="{sign_shape(ix, iy, iw, ih, cut - inset * 0.45)}" fill="none" '
                 f'stroke="{WHITE}" stroke-width="{h*0.022:.2f}" stroke-linejoin="miter"/>')
    # block number + direction, stacked at the left end
    bx = x + cut + h * 0.3
    d, _ = text_path(block, "b", h * 0.19, bx, y + h * 0.45, "middle")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    d, _ = text_path(dirn, "b", h * 0.19, bx, y + h * 0.72, "middle")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    # divider
    dx = bx + h * 0.36
    parts.append(f'<rect x="{dx:.2f}" y="{y+h*0.22:.2f}" width="{h*0.018:.2f}" height="{h*0.56:.2f}" fill="{WHITE}"/>')
    # street name, sized to fit and centred in the remaining field
    left, right = dx + h * 0.14, x + w - cut - h * 0.14
    size = h * 0.56
    _, tw = text_path(name, "b", size, 0, 0)
    size = min(size, size * (right - left) / tw)
    d, _ = text_path(name, "b", size, (left + right) / 2, y + h / 2 + size * 0.36, "middle")
    parts.append(f'<path d="{d}" fill="{WHITE}"/>')
    return "\n  ".join(parts)

def svg(w, h, body, bg=None):
    bgr = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
            f'width="{w/100}in" height="{h/100}in">\n  {bgr}{body}\n</svg>\n')

# ---- FRONT: 12in x 3.6in print (100 units / inch) ----
FW, FH = 1200, 360
front = blade(10, 10, FW - 20, FH - 20, "OneFive St", "1500", "S")
open(f"{OUT}/front-street-sign.svg", "w").write(svg(FW, FH, front))

# ---- BACK YOKE: 3.5in wide wordmark, centred below collar ----
YW, YH = 400, 80
d, wd = text_path("ONEFIVE", "xb", 54, YW / 2, 52, "middle", tracking=0.08)
yoke = f'<path d="{d}" fill="{GREEN}"/>'
d2, _ = text_path("PHILADELPHIA", "b", 15, YW / 2, 76, "middle", tracking=0.42)
yoke += f'\n  <path d="{d2}" fill="{GREEN}"/>'
open(f"{OUT}/back-yoke-onefive.svg", "w").write(svg(YW, YH, yoke))
print("ok")
