# The stomp logo: a footprint made of PCB pads (the big toe square, as pin 1 is),
# and "stomp" in IBM Plex Mono SemiBold, outlined so it renders the same anywhere.
#
#   python3 -I make.py FONT OUTDIR
#
# FONT is IBM Plex Mono SemiBold (SIL Open Font License), for example
# fonts/complete/woff/IBMPlexMono-SemiBold.woff from the npm package @ibm/plex-mono.
# It needs fontTools (pip install fonttools). Writes the four SVGs in this folder and
# sheet.html, a page that shows them.
import math, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FONT, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

COPPER = '#c8862a'          # on light grounds
COPPER_LIGHT = '#e0a24d'    # on dark grounds
INK = '#17201c'
INK_LIGHT = '#e3ebe6'
MASK = '#1d4a35'            # solder-mask green, for the icon

f2 = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')

def rot(px, py, cx, cy, deg):
    a = math.radians(deg)
    x, y = px - cx, py - cy
    return (cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a))

# The mark, in its own units: the sole an obround pad, the toes on a circle round its top
SOLE_W, SOLE_L, TILT, GAP = 36, 56, -10, 5
ANGLES = (-112, -83, -58, -36, -15)
SIZES = (8.3, 6.6, 5.7, 4.9, 4.1)

def mark_parts():
    cx, cy = 48, 63
    r = SOLE_W / 2
    h = SOLE_L / 2 - r
    pts = [rot(cx + dx, cy + dy, cx, cy, TILT) for dx, dy in [(-r, -h), (r, -h), (r, h), (-r, h)]]
    (x1, y1), (x2, y2), (x3, y3), (x4, y4) = pts
    sole = (f'M{f2(x1)} {f2(y1)}A{f2(r)} {f2(r)} 0 0 1 {f2(x2)} {f2(y2)}'
            f'L{f2(x3)} {f2(y3)}A{f2(r)} {f2(r)} 0 0 1 {f2(x4)} {f2(y4)}Z')
    top = rot(cx, cy - h, cx, cy, TILT)
    toes = []
    for i, (ang, s) in enumerate(zip(ANGLES, SIZES)):
        d = r + GAP + s
        x = top[0] + d * math.cos(math.radians(ang))
        y = top[1] + d * math.sin(math.radians(ang))
        toes.append((i, x, y, s))
    return sole, top, (cx, cy, r, h), toes

def mark_body(fill):
    sole, top, (cx, cy, r, h), toes = mark_parts()
    out = [f'<path fill="{fill}" d="{sole}"/>']
    for i, x, y, s in toes:
        if i == 0:   # pin 1: the square pad
            w, hh = 2 * s, 2.16 * s
            out.append(f'<rect fill="{fill}" x="{f2(x - w / 2)}" y="{f2(y - hh / 2)}" width="{f2(w)}" height="{f2(hh)}" rx="3" transform="rotate({TILT} {f2(x)} {f2(y)})"/>')
        else:
            out.append(f'<circle fill="{fill}" cx="{f2(x)}" cy="{f2(y)}" r="{f2(s)}"/>')
    return ''.join(out)

def mark_bounds():
    sole, top, (cx, cy, r, h), toes = mark_parts()
    x0, y0, x1, y1 = 1e9, 1e9, -1e9, -1e9
    # the sole: its two cap circles
    for c in (rot(cx, cy - h, cx, cy, TILT), rot(cx, cy + h, cx, cy, TILT)):
        x0, y0, x1, y1 = min(x0, c[0] - r), min(y0, c[1] - r), max(x1, c[0] + r), max(y1, c[1] + r)
    for i, x, y, s in toes:
        e = s * (1.25 if i == 0 else 1)
        x0, y0, x1, y1 = min(x0, x - e), min(y0, y - e), max(x1, x + e), max(y1, y + e)
    return x0, y0, x1, y1

# The wordmark: glyph outlines from the font
font = TTFont(FONT)
upm = font['head'].unitsPerEm
gs = font.getGlyphSet()
cmap = font.getBestCmap()

def word_path(text, size, x0, baseline, tracking=-0.04):
    """The text's outline, size px per em, starting at x0 on the baseline. Returns (d, width)."""
    k = size / upm
    pen = SVGPathPen(gs, ntos=lambda v: f2(v))
    x = x0
    for ch in text:
        g = cmap[ord(ch)]
        tp = TransformPen(pen, (k, 0, 0, -k, x, baseline))
        gs[g].draw(tp)
        x += font['hmtx'][g][0] * k + tracking * size
    return pen.getCommands(), x - x0 - tracking * size

def lockup(mark_fill, ink, size=48):
    """The mark and the word side by side, the mark as tall as the word's ascender to descender."""
    mx0, my0, mx1, my1 = mark_bounds()
    H = size * 0.98                            # ascender to descender, about
    s = H / (my1 - my0)
    mw = (mx1 - mx0) * s
    gap = size * 0.28
    d, ww = word_path('stomp', size, mw + gap, size * 0.74)    # the baseline, 0.74 em down
    m = f'<g transform="translate({f2(-mx0 * s)} {f2(-my0 * s)}) scale({f2(s)})">{mark_body(mark_fill)}</g>'
    return mw + gap + ww, H, m + f'<path fill="{ink}" d="{d}"/>'

def svg(w, h, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f2(w)} {f2(h)}" width="{f2(w)}" height="{f2(h)}" role="img" aria-label="stomp">'
            f'<title>stomp</title>{body}</svg>\n')

files = {}
W, H, body = lockup(COPPER, INK)
files['stomp-logo.svg'] = svg(W, H, body)
W, H, body = lockup(COPPER_LIGHT, INK_LIGHT)
files['stomp-logo-dark.svg'] = svg(W, H, body)

# the mark alone, square, centered
mx0, my0, mx1, my1 = mark_bounds()
side = max(mx1 - mx0, my1 - my0)
def square_mark(fill, size, inset, bg=None, rx=0):
    s = (size - 2 * inset) / side
    ox = inset + ((side - (mx1 - mx0)) / 2 - mx0) * s
    oy = inset + ((side - (my1 - my0)) / 2 - my0) * s
    back = f'<rect width="{size}" height="{size}" rx="{rx}" fill="{bg}"/>' if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="stomp">'
            f'<title>stomp</title>{back}<g transform="translate({f2(ox)} {f2(oy)}) scale({f2(s)})">{mark_body(fill)}</g></svg>\n')
files['stomp-mark.svg'] = square_mark(COPPER, 128, 4)
files['stomp-icon.svg'] = square_mark(COPPER_LIGHT, 128, 22, bg=MASK, rx=28)

for name, text in files.items():
    open(os.path.join(OUT, name), 'w').write(text)
    print(name, len(text), 'bytes')

# a review sheet
def tile(svgtext, bg, w=None):
    st = f'width:{w}px;height:auto' if w else ''
    return f'<div class="t" style="background:{bg}"><div style="{st}">{svgtext}</div></div>'
sheet = f'''<html><body style="margin:0;padding:20px;background:#eef1ec;font:13px sans-serif">
<style>.t{{padding:28px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin:0 12px 12px 0;vertical-align:top}} svg{{display:block}} .t div svg{{width:100%;height:auto}}</style>
{tile(files['stomp-logo.svg'], '#ffffff', 360)}{tile(files['stomp-logo-dark.svg'], '#0e1916', 360)}<br>
{tile(files['stomp-mark.svg'], '#ffffff', 128)}{tile(files['stomp-icon.svg'], '#ffffff', 128)}{tile(files['stomp-icon.svg'], '#ffffff', 64)}{tile(files['stomp-icon.svg'], '#ffffff', 32)}{tile(files['stomp-icon.svg'], '#ffffff', 16)}<br>
{tile(files['stomp-logo.svg'], '#e6ebe5', 130)}{tile(files['stomp-logo-dark.svg'], '#08100e', 130)}
</body></html>'''
open(os.path.join(OUT, 'sheet.html'), 'w').write(sheet)
