#!/usr/bin/env python3
"""Convert photographs into the character-grid data behind index.html.

sips (macOS) does the JPEG decode and downscale; everything after that is
here, so the crop, the lens-flare repair and the grid sampling stay under
our control. No dependencies beyond the standard library.

The live site's scene-data.js was produced with:

    python3 -c "
    import json, photo2ascii as pa
    s = pa.build('IMG_0752.jpeg', 320, 108, 0.45, [], 'glacier', 'Garibaldi Lake', contrast=0.75)
    open('scene-data.js', 'w').write('const SCENE = ' + json.dumps(s, separators=(',', ':')) + ';')"

build() arguments: photo path, grid cols, grid rows (cols * 9/16 * 0.6 for a
16:9 crop at a 0.6 character aspect), crop_top (0 = keep the top of the
photo, 1 = the bottom), a list of green lens-flare centres to heal as
(x, y, radius) in original-photo pixels, a name and label, contrast
(palette bend around mid-grey; below 1.0 soft, above punchy), and variety.

variety trades a little per-cell accuracy for a more organic texture: at 0
each contour cell takes the single best-fitting glyph, which lays down long
identical runs down a slope and reads mechanical; higher values sample among
near-equal candidates and penalise repeating the neighbour, so the same line
is drawn with varying characters. 0.6 removes every run of 4+ while costing
under a point of orientation accuracy.

If the edge-glyph ATLAS order changes, EDGE_CH in scene.js must change with
it — the two lists are index-matched.

check_edges.py verifies the edge pass: it recomputes each cell's orientation
from the shipped data and reports how often the chosen stroke leans the same
way. Run it after touching the ATLAS or the penalties below.
"""

import base64
import json
import os
import struct
import subprocess
import sys
import zlib

SCRATCH = os.path.dirname(os.path.abspath(__file__))


# ── PNG decode ──────────────────────────────────────────────────────────

def decode_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    pos, idat, pal = 8, [], None
    width = height = depth = ctype = None

    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos + 4])
        ctag = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctag == b'IHDR':
            width, height, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', chunk)
            assert depth == 8, f'expected 8-bit, got {depth}'
            assert interlace == 0, 'interlaced PNG not supported'
        elif ctag == b'PLTE':
            pal = chunk
        elif ctag == b'IDAT':
            idat.append(chunk)
        elif ctag == b'IEND':
            break
        pos += 12 + length

    raw = zlib.decompress(b''.join(idat))
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    stride = width * channels

    out = bytearray(height * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line

    # Normalise to flat RGB
    rgb = bytearray(width * height * 3)
    for i in range(width * height):
        if ctype == 2:
            rgb[i * 3:i * 3 + 3] = out[i * 3:i * 3 + 3]
        elif ctype == 6:
            rgb[i * 3:i * 3 + 3] = out[i * 4:i * 4 + 3]
        elif ctype == 3:
            v = out[i]
            rgb[i * 3:i * 3 + 3] = pal[v * 3:v * 3 + 3]
        else:
            v = out[i * channels]
            rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v
    return width, height, rgb


# ── Lens flare repair ───────────────────────────────────────────────────

def heal_green_dot(w, h, px, cx, cy, radius):
    """Replace the camera's green flare by interpolating across each scan
    line it touches. The sky behind it is a smooth gradient, so a straight
    left-to-right blend is indistinguishable from the real thing."""
    hits = []
    for y in range(max(0, cy - radius), min(h, cy + radius + 1)):
        for x in range(max(0, cx - radius), min(w, cx + radius + 1)):
            i = (y * w + x) * 3
            r, g, b = px[i], px[i + 1], px[i + 2]
            if g > r + 12 and g > b + 12:
                hits.append((x, y))
    if not hits:
        return 0

    # Grow the mask a little so the soft halo goes too.
    mask = set()
    for (x, y) in hits:
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                if 0 <= x + dx < w and 0 <= y + dy < h:
                    mask.add((x + dx, y + dy))

    rows = {}
    for (x, y) in mask:
        rows.setdefault(y, []).append(x)
    for y, xs in rows.items():
        x0, x1 = min(xs) - 1, max(xs) + 1
        if x0 < 0 or x1 >= w:
            continue
        i0, i1 = (y * w + x0) * 3, (y * w + x1) * 3
        span = x1 - x0
        for x in range(x0 + 1, x1):
            t = (x - x0) / span
            i = (y * w + x) * 3
            for c in range(3):
                px[i + c] = int(px[i0 + c] * (1 - t) + px[i1 + c] * t)
    return len(mask)


# ── Grid sampling ───────────────────────────────────────────────────────

def build(path, cols, rows, crop_top, flares, out_name, label, contrast=1.0,
          variety=0.7):
    tmp = os.path.join(SCRATCH, '_resize.png')
    subprocess.run(['sips', '-Z', '1100', path, '--out', tmp,
                    '--setProperty', 'format', 'png'],
                   check=True, capture_output=True)
    w, h, px = decode_png(tmp)

    for (fx, fy, fr) in flares:
        # Flare coordinates are given against the original 4032-wide frame.
        scale = w / 4032
        sx, sy = int(fx * scale), int(fy * scale)
        n = heal_green_dot(w, h, px, sx, sy, max(6, int(fr * scale)))
        print(f'  healed {n} px around ({sx},{sy})')

    # Crop a 16:9 window, positioned by crop_top (0 = top, 1 = bottom).
    cw = w
    ch = int(round(w * 9 / 16))
    if ch > h:
        ch = h
        cw = int(round(h * 16 / 9))
    ox = (w - cw) // 2
    oy = int(round((h - ch) * crop_top))

    # Per cell: split the pixels into a dominant colour (paper) and a
    # minority colour (ink). The glyph drawn on top encodes how much of
    # the cell the ink covers, so detail survives in both polarities —
    # dark trees on bright sky and bright snow on dark rock alike.
    # Whole-frame luminance, reused by the sub-cell edge pass below.
    lumimg = bytearray(w * h)
    for i in range(w * h):
        j = i * 3
        lumimg[i] = int(0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2])

    bg_col, fg_col = [], []
    cov = bytearray(cols * rows)
    meanL = [0.0] * (cols * rows)

    def satboost(c, k=0.35):
        g = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        return tuple(max(0, min(255, int(v + (v - g) * k))) for v in c)
    for gy in range(rows):
        y0 = oy + int(gy * ch / rows)
        y1 = max(y0 + 1, oy + int((gy + 1) * ch / rows))
        for gx in range(cols):
            x0 = ox + int(gx * cw / cols)
            x1 = max(x0 + 1, ox + int((gx + 1) * cw / cols))
            pix = []
            for y in range(y0, y1):
                base = y * w
                for x in range(x0, x1):
                    i = (base + x) * 3
                    r, g, b = px[i], px[i + 1], px[i + 2]
                    pix.append((0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b))
            mean = sum(p[0] for p in pix) / len(pix)
            meanL[gy * cols + gx] = mean
            dark = [p for p in pix if p[0] < mean]
            brt = [p for p in pix if p[0] >= mean]
            if not dark or not brt:
                c = tuple(sum(p[k] for p in pix) // len(pix) for k in (1, 2, 3))
                bg_col.append(c); fg_col.append(c); cov[gy * cols + gx] = 0
                continue

            def avg(group):
                return tuple(int(sum(p[k] for p in group) / len(group)) for k in (1, 2, 3))

            dmean = sum(p[0] for p in dark) / len(dark)
            bmean = sum(p[0] for p in brt) / len(brt)
            # Ink is whichever side is the minority; paper is the majority.
            if len(dark) <= len(brt):
                ink, paper, frac = avg(dark), avg(brt), len(dark) / len(pix)
            else:
                ink, paper, frac = avg(brt), avg(dark), len(brt) / len(pix)
            # The text must stay visible even in flat sky, or the render
            # collapses into a pixelated photo. Guarantee the ink a minimum
            # tonal separation from the paper, and every cell some glyph.
            if bmean - dmean < 18:
                plum = 0.2126 * paper[0] + 0.7152 * paper[1] + 0.0722 * paper[2]
                k = 0.80 if plum > 96 else 1.35
                ink = tuple(min(255, int(c * k)) for c in paper)
            else:
                # Real cluster colour: push its saturation so the letters
                # visibly carry the image's hues, not just its tones.
                ink = satboost(ink)
            sep = min(1.0, 0.45 + (bmean - dmean) / 56.0)
            cover = max(0.34, min(1.0, frac * 2.0) * sep)
            bg_col.append(paper)
            fg_col.append(ink)
            cov[gy * cols + gx] = int(cover * 255)

    # Edge pass. Sobel over the cell luminances decides WHETHER a cell is
    # an edge; the glyph is then chosen by matching the cell's own 3x3 ink
    # distribution against a small atlas of character shapes, so a corner
    # gets an 'L', a bend gets a '(' and a low horizon line gets a '_'.
    # The atlas order must match EDGE_CH in the renderer.
    import math
    ATLAS = [
        ('|',  [0, 1, 0, 0, 1, 0, 0, 1, 0], 'v'),
        ('/',  [0, 0, 1, 0, 1, 0, 1, 0, 0], 'd'),
        ('-',  [0, 0, 0, 1, 1, 1, 0, 0, 0], 'h'),
        ('\\', [1, 0, 0, 0, 1, 0, 0, 0, 1], 'b'),
        ('_',  [0, 0, 0, 0, 0, 0, 1, 1, 1], 'h'),
        ("'",  [0, 1, 0, 0, 0, 0, 0, 0, 0], 'h'),
        ('L',  [1, 0, 0, 1, 0, 0, 1, 1, 1], 'o'),
        ('J',  [0, 0, 1, 0, 0, 1, 1, 1, 0], 'o'),
        ('7',  [1, 1, 1, 0, 0, 1, 0, 1, 0], 'o'),
        ('r',  [1, 1, 0, 1, 0, 0, 1, 0, 0], 'o'),
        ('(',  [0, 1, 0, 1, 0, 0, 0, 1, 0], 'v'),
        (')',  [0, 1, 0, 0, 0, 1, 0, 1, 0], 'v'),
        ('^',  [0, 1, 0, 1, 0, 1, 0, 0, 0], 'o'),
        ('v',  [0, 0, 0, 1, 0, 1, 0, 1, 0], 'o'),
        ('x',  [1, 0, 1, 0, 1, 0, 1, 0, 1], 'o'),
    ]
    DIR_FALLBACK = {'h': 3, 'v': 1, 'd': 2, 'b': 4}   # 1-based atlas index

    edge = bytearray(cols * rows)
    chosen = [None] * (cols * rows)      # glyph char per cell, for run-breaking
    runlen = [0] * (cols * rows)         # how long the run reaching this cell is
    EDGE_THR = 130.0

    # Already-decided neighbours, in raster order: left, up-left, up, up-right.
    # A run follows the contour, so a diagonal ridge repeats into the cell
    # above-left or above-right, never the one to the left. Checking only
    # along the row leaves diagonal runs completely unbroken.
    NEIGH = ((-1, 0), (-1, -1), (0, -1), (1, -1))

    def run_before(gx, gy, glyph):
        """Longest run of `glyph` arriving at this cell from any direction."""
        if glyph is None:
            return 0
        longest = 0
        for dx, dy in NEIGH:
            nx, ny = gx + dx, gy + dy
            if 0 <= nx < cols and 0 <= ny < rows:
                ni = ny * cols + nx
                if chosen[ni] == glyph and runlen[ni] > longest:
                    longest = runlen[ni]
        return longest

    def draw(x, y):
        """Deterministic 0..1 per cell, so builds stay reproducible."""
        h = (x * 0x27D4EB2D + y * 0x165667B1) & 0xFFFFFFFF
        h ^= h >> 15
        h = (h * 0x2545F491) & 0xFFFFFFFF
        return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0

    for gy in range(1, rows - 1):
        for gx in range(1, cols - 1):
            i = gy * cols + gx
            gxs = (meanL[i - cols + 1] + 2 * meanL[i + 1] + meanL[i + cols + 1]) \
                - (meanL[i - cols - 1] + 2 * meanL[i - 1] + meanL[i + cols - 1])
            gys = (meanL[i + cols - 1] + 2 * meanL[i + cols] + meanL[i + cols + 1]) \
                - (meanL[i - cols - 1] + 2 * meanL[i - cols] + meanL[i - cols + 1])
            mag = math.hypot(gxs, gys)
            if mag < EDGE_THR:
                continue
            theta = math.degrees(math.atan2(gys, gxs)) % 180.0
            if theta < 22.5 or theta >= 157.5:
                oclass = 'v'         # horizontal gradient -> vertical stroke
            elif theta < 67.5:
                oclass = 'd'
            elif theta < 112.5:
                oclass = 'h'
            else:
                oclass = 'b'

            # Where does the boundary actually RUN inside this cell? Bin the
            # sub-cell gradient magnitude into 3x3. This must come from the
            # edge itself, not from which side the ink fills: a filled top
            # half matches a glyph with a full top row (like '7') no matter
            # which way the slope runs, which picked strokes that leaned the
            # wrong way.
            bx0, bx1 = ox + int(gx * cw / cols), max(1, ox + int((gx + 1) * cw / cols))
            by0, by1 = oy + int(gy * ch / rows), max(1, oy + int((gy + 1) * ch / rows))
            acc = [0.0] * 9
            cnt = [0] * 9
            for yy in range(max(1, by0), min(h - 1, max(by0 + 1, by1))):
                rw = yy * w
                bi = min(2, (yy - by0) * 3 // max(1, by1 - by0)) * 3
                for xx in range(max(1, bx0), min(w - 1, max(bx0 + 1, bx1))):
                    g = (abs(lumimg[rw + xx + 1] - lumimg[rw + xx - 1]) +
                         abs(lumimg[rw + w + xx] - lumimg[rw - w + xx]))
                    k = bi + min(2, (xx - bx0) * 3 // max(1, bx1 - bx0))
                    acc[k] += g
                    cnt[k] += 1
            t = [acc[k] / cnt[k] if cnt[k] else 0.0 for k in range(9)]

            mn, mx = min(t), max(t)
            if mx - mn < 10.0:
                # Too flat to shape-match. Any stroke of the right
                # orientation will do, which is exactly where variety helps:
                # picking the canonical one every time laid down long
                # identical runs along soft boundaries.
                scored = [[0.0 if a_idx + 1 == DIR_FALLBACK[oclass] else 0.06,
                           a_idx + 1, glyph]
                          for a_idx, (glyph, _, ac) in enumerate(ATLAS)
                          if ac == oclass]
                scored.append([0.10, 0, None])
            else:
                t = [(v - mn) / (mx - mn) for v in t]
                scored = []
                for a_idx, (glyph, am, ac) in enumerate(ATLAS):
                    ssd = sum((t[k] - am[k]) ** 2 for k in range(9)) / 9.0
                    # Two separate costs. A corner glyph has more ink than a
                    # stroke, so it fits any diffuse gradient blob unless it
                    # is made to pay — left cheap, corners win on smooth
                    # slopes and you get a '7' where the ridge simply
                    # descends. And the Sobel orientation is reliable, so a
                    # stroke leaning the wrong way has to be a decisively
                    # better fit to win.
                    if ac == 'o':
                        ssd += 0.15
                    elif ac != oclass:
                        ssd += 0.32
                    scored.append([ssd, a_idx + 1, glyph])

                # Letting an edge cell fall back to the density texture is
                # itself a candidate — a contour that dissolves here and
                # there reads as drawn rather than traced.
                floor = min(s[0] for s in scored)
                scored.append([floor + 0.16 - 0.10 * variety, 0, None])

            # Break up runs: the same glyph repeated cell after cell down a
            # slope looks mechanical, and a slightly worse-fitting neighbour
            # costs little. Raster order means left and above are settled.
            if variety > 0:
                for s in scored:
                    if s[2] is None:
                        continue
                    # Scale with the run already laid down, so a repeat gets
                    # harder the longer the contour has been drawn with it.
                    rl = run_before(gx, gy, s[2])
                    if rl:
                        s[0] += 0.085 * variety * min(rl, 6)

            best = min(s[0] for s in scored)
            if variety <= 0:
                pick = min(scored, key=lambda s: s[0])
            else:
                # Sample among the near-equal candidates, weighted by fit.
                tol = 0.015 + 0.075 * variety
                temp = 0.012 + 0.05 * variety
                cands = [s for s in scored if s[0] <= best + tol]
                wts = [math.exp(-(s[0] - best) / temp) for s in cands]
                r = draw(gx, gy) * sum(wts)
                acc = 0.0
                pick = cands[-1]
                for s, wt in zip(cands, wts):
                    acc += wt
                    if r <= acc:
                        pick = s
                        break

            edge[i] = pick[1]
            chosen[i] = pick[2]
            runlen[i] = run_before(gx, gy, pick[2]) + 1 if pick[2] is not None else 0
    n_edges = sum(1 for e in edge if e)
    from collections import Counter
    top = Counter(ATLAS[e - 1][0] for e in edge if e).most_common(6)
    print(f'  edges: {n_edges} cells, top glyphs {top}')

    # Shared palette for both layers, most common quantised colours first.
    def q(c):
        return (c[0] >> 2 << 2, c[1] >> 2 << 2, c[2] >> 2 << 2)

    freq = {}
    for c in bg_col + fg_col:
        k = q(c)
        freq[k] = freq.get(k, 0) + 1
    pal = [k for k, _ in sorted(freq.items(), key=lambda kv: -kv[1])[:250]]

    cache = {}
    def nearest(c):
        k = q(c)
        if k in cache:
            return cache[k]
        best, bd = 0, 1 << 30
        for i, p in enumerate(pal):
            d = (p[0] - k[0]) ** 2 + (p[1] - k[1]) ** 2 + (p[2] - k[2]) ** 2
            if d < bd:
                best, bd = i, d
        cache[k] = best
        return best

    # Dither before the palette snap: smooth gradients would otherwise band
    # at 250 colours. The jitter must come from a hash, NOT a linear formula
    # — an ordered pattern like (7x+13y) mod 5 is constant along diagonal
    # lines and paints visible stripes across flat water and sky.
    def cell_hash(x, y):
        h = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
        h ^= h >> 13
        h = (h * 1274126177) & 0xFFFFFFFF
        return (h ^ (h >> 16)) & 0xFFFFFFFF

    def dithered(colours):
        out = bytearray()
        for i, c in enumerate(colours):
            gx, gy = i % cols, i // cols
            j = (cell_hash(gx, gy) % 7 - 3) * 2
            out.append(nearest((c[0] + j, c[1] + j, c[2] + j)))
        return out

    scene = {
        'name': out_name,
        'label': label,
        'cols': cols,
        'rows': rows,
        # Contrast bends the palette around mid-grey — below 1.0 is soft
        # and hazy, above is deep and punchy. Same formula the picker used.
        'pal': ['#%02x%02x%02x' % tuple(
            max(0, min(255, round((c - 128) * contrast + 128))) for c in p
        ) for p in pal],
        'bg': base64.b64encode(bytes(dithered(bg_col))).decode(),
        'fg': base64.b64encode(bytes(dithered(fg_col))).decode(),
        'cov': base64.b64encode(bytes(cov)).decode(),
        'edge': base64.b64encode(bytes(edge)).decode(),
    }
    os.remove(tmp)
    kb = (len(scene['bg']) + len(scene['fg']) + len(scene['cov'])) // 1024
    print(f'  {cols}x{rows}, {len(pal)} colours, {kb} KB payload')
    return scene


SOURCES = [
    # file, crop_top, green-flare centres (original-frame px), name, label
    ('IMG_0636.jpeg', 0.52, [(3208, 1309, 40)], 'ridges', 'Sunrise over the ridges'),
    ('IMG_0631.jpeg', 1.00, [(1428, 1044, 40)], 'cloudsea', 'Sun above the cloud sea'),
    ('IMG_0752.jpeg', 0.45, [], 'glacier', 'Glacier and turquoise lake'),
    ('IMG_0750.jpeg', 0.55, [], 'lake', 'Cumulus over the lake'),
]

if __name__ == '__main__':
    src_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 210
    rows = int(round(cols * 0.5625 * 0.6))
    scenes = []
    for fn, ct, flares, name, label in SOURCES:
        print(f'{fn} -> {name}')
        scenes.append(build(os.path.join(src_dir, fn), cols, rows, ct, flares, name, label))
    out = os.path.join(SCRATCH, 'scenes.json')
    json.dump(scenes, open(out, 'w'), separators=(',', ':'))
    print(f'\nwrote {out} ({os.path.getsize(out) // 1024} KB)')
