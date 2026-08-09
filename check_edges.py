#!/usr/bin/env python3
"""Do the chosen strokes actually lean the way the image's edges run?

Recomputes the edge orientation per cell from the shipped data and
cross-tabulates it against the glyph that was picked.
"""
import base64, collections, json, math, re, sys

src = open(sys.argv[1] if len(sys.argv) > 1 else 'scene-data.js').read()
S = json.loads(re.match(r'const SCENE = (.*);\s*$', src, re.S).group(1))
cols, rows = S['cols'], S['rows']
edge = base64.b64decode(S['edge'])
bgi = base64.b64decode(S['bg'])
pal = [tuple(int(h[i:i+2], 16) for i in (1, 3, 5)) for h in S['pal']]

CH    = ['', '|', '/', '-', '\\', '_', "'", 'L', 'J', '7', 'r', '(', ')', '^', 'v', 'x']
KLASS = ['', 'v', 'd', 'h', 'b', 'h', 'h', 'o', 'o', 'o', 'o', 'v', 'v', 'o', 'o', 'o']

lum = [0.2126 * pal[c][0] + 0.7152 * pal[c][1] + 0.0722 * pal[c][2] for c in bgi]

tab = collections.Counter()
glyph_by_dir = collections.defaultdict(collections.Counter)
for gy in range(1, rows - 1):
    for gx in range(1, cols - 1):
        i = gy * cols + gx
        e = edge[i]
        if not e:
            continue
        gxs = (lum[i-cols+1] + 2*lum[i+1] + lum[i+cols+1]) - (lum[i-cols-1] + 2*lum[i-1] + lum[i+cols-1])
        gys = (lum[i+cols-1] + 2*lum[i+cols] + lum[i+cols+1]) - (lum[i-cols-1] + 2*lum[i-cols] + lum[i-cols+1])
        if math.hypot(gxs, gys) < 40:
            continue
        th = math.degrees(math.atan2(gys, gxs)) % 180.0
        want = 'v' if (th < 22.5 or th >= 157.5) else 'd' if th < 67.5 else 'h' if th < 112.5 else 'b'
        got = KLASS[e]
        tab[(want, got)] += 1
        glyph_by_dir[want][CH[e]] += 1

directional = sum(v for (w, g), v in tab.items() if g != 'o')
agree = sum(v for (w, g), v in tab.items() if g != 'o' and g == w)
corners = sum(v for (w, g), v in tab.items() if g == 'o')
total = directional + corners

print(f'edge cells sampled: {total}')
print(f'  directional strokes: {directional}  ({100*directional/total:.0f}%)')
print(f'    leaning correctly: {agree}/{directional} = {100*agree/max(1,directional):.1f}%')
print(f'  corner/omni glyphs : {corners}  ({100*corners/total:.0f}%)')
print()
for d, label in (('b', 'downslope \\'), ('d', 'upslope /'), ('h', 'horizontal'), ('v', 'vertical')):
    c = glyph_by_dir[d]
    if c:
        print(f'  edges running {label:12s}: {"".join(f"{g}x{n} " for g, n in c.most_common(6))}')
