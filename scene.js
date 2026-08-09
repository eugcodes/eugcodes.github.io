/* A photograph of Garibaldi Lake rendered as coloured text.
 *
 * Every cell carries two colours taken from the photo — the dominant tone
 * as paper, the minority tone as ink — and a glyph whose density encodes
 * how much of the cell the ink covers. Cells on strong image contours use
 * a character whose own shape matches the line through that block (chosen
 * offline against a small atlas), so ridgelines and the shoreline read as
 * drawn strokes. A slow noise field nudges glyph density over time, which
 * keeps the texture re-resolving while the image holds still.
 *
 * The grid data lives in scene-data.js (SCENE), produced by photo2ascii.py.
 */
(() => {
    'use strict';

    const host = document.getElementById('scene');
    if (!host || typeof SCENE === 'undefined') return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reducedMotion = () => motionQuery.matches;

    /* Sparse to dense; no &, <, >, " or backslash, so no escaping needed. */
    const RAMP = " .',:;Il!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW8%B@$";
    const LAST = RAMP.length - 1;

    /* Shape-matched contour glyphs — order fixed by the converter's atlas. */
    const EDGE_CH = ['', '|', '/', '-', '\\', '_', "'", 'L', 'J', '7', 'r', '(', ')', '^', 'v', 'x'];

    const SHIMMER = 0.75;

    /* ── Noise (drives the shimmer only) ─────────── */

    function hash(x, y) {
        let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    const smooth = t => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

    function noise2(x, y, s) {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = smooth(x - ix), fy = smooth(y - iy);
        return lerp(
            lerp(hash(ix, iy + s), hash(ix + 1, iy + s), fx),
            lerp(hash(ix, iy + 1 + s), hash(ix + 1, iy + 1 + s), fx), fy);
    }

    /* ── Scene data ──────────────────────────────── */

    function unb64(s) {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    const S = SCENE;
    S.bgBuf = unb64(S.bg);
    S.fgBuf = unb64(S.fg);
    S.covBuf = unb64(S.cov);
    S.edgeBuf = unb64(S.edge);

    /* Colours are fixed per cell, so the run structure over the
       (paper, ink) pair is computed once; only glyphs change per frame. */
    S.runs = [];
    for (let y = 0; y < S.rows; y++) {
        const row = [];
        const base = y * S.cols;
        let start = 0;
        let key = S.bgBuf[base] << 8 | S.fgBuf[base];
        for (let x = 1; x <= S.cols; x++) {
            const k = x < S.cols ? (S.bgBuf[base + x] << 8 | S.fgBuf[base + x]) : -1;
            if (k !== key) {
                row.push({ x0: start, len: x - start, fg: key & 255, bg: key >> 8 });
                start = x; key = k;
            }
        }
        S.runs.push(row);
    }

    /* ── Rendering ───────────────────────────────── */

    function rowHTML(y, t) {
        const { cols, covBuf, edgeBuf, pal } = S;
        let line = '';
        for (const run of S.runs[y]) {
            let s = '';
            for (let x = run.x0; x < run.x0 + run.len; x++) {
                const e = edgeBuf[y * cols + x];
                if (e) { s += EDGE_CH[e]; continue; }
                let cover = covBuf[y * cols + x] / 255;
                const n = noise2(x * 0.09 + t * 0.11, y * 0.14 - t * 0.05, 7) - 0.5;
                const sweep = 0.5 + 0.5 * Math.sin((x / cols) * 2.4 - t * 0.22);
                cover += n * SHIMMER * 0.55 + (sweep - 0.5) * SHIMMER * 0.25;
                s += RAMP[Math.round(Math.pow(clamp01(cover), 0.85) * LAST)];
            }
            /* The shadow bleeds this run's paper 1px to the right. Any
               sub-pixel sliver left between cells is filled by its
               neighbour instead of showing the page through as a seam. */
            const paper = pal[run.bg];
            line += '<span style="color:' + pal[run.fg] + ';background:' + paper +
                    ';box-shadow:1px 0 0 0 ' + paper + '">' + s + '</span>';
        }
        return line;
    }

    let rowEls = [];

    function buildAll(t) {
        const frag = document.createDocumentFragment();
        rowEls = [];
        for (let y = 0; y < S.rows; y++) {
            const div = document.createElement('div');
            div.innerHTML = rowHTML(y, t);
            frag.appendChild(div);
            rowEls.push(div);
        }
        host.replaceChildren(frag);
    }

    /* ── Sizing: cover the viewport, crop the sides ── */

    let charRatio = 0.6;

    /* Advance width of one character at a given font size and letter-spacing. */
    function measureAdvance(fontSize, spacing) {
        const probe = document.createElement('span');
        probe.textContent = 'MMMMMMMMMMMMMMMMMMMM';
        probe.style.cssText =
            'position:absolute;visibility:hidden;white-space:pre;line-height:1;';
        probe.style.fontFamily = getComputedStyle(host).fontFamily;
        probe.style.fontSize = fontSize + 'px';
        probe.style.letterSpacing = (spacing || 0) + 'px';
        document.body.appendChild(probe);
        const adv = probe.getBoundingClientRect().width / 20;
        probe.remove();
        return adv;
    }

    function size() {
        const doc = document.documentElement;
        const w = doc.clientWidth, h = doc.clientHeight;

        /* Whole-pixel cells. A fractional advance leaves a sub-pixel sliver
           between one cell's background and the next; every row shares the
           same metrics, so those slivers line up and read as white vertical
           seams down the picture. Rounding the cell to a whole pixel — and
           snapping the advance to it with letter-spacing — removes the
           fractional boundary entirely.

           Sizing still behaves like background-size: cover, so on a tall
           screen the grid overflows horizontally and is centre-cropped. */
        let rowH = Math.max(1, Math.ceil(h / S.rows));
        let cellW = Math.max(1, Math.round(rowH * charRatio));
        while (cellW * S.cols < w) {
            rowH += 1;
            cellW = Math.max(1, Math.round(rowH * charRatio));
        }

        const fs = cellW / charRatio;
        /* Browsers quantise the advance (1/64px in Blink), so one pass lands
           slightly short. Measure with the spacing applied and correct. */
        let spacing = cellW - measureAdvance(fs, 0);
        spacing += cellW - measureAdvance(fs, spacing);

        host.style.fontSize = fs.toFixed(4) + 'px';
        host.style.letterSpacing = spacing.toFixed(4) + 'px';
        host.style.setProperty('--row-h', rowH + 'px');
        host.style.left = Math.round((w - cellW * S.cols) / 2) + 'px';
    }

    /* ── Loop: refresh a rotating batch of rows ────── */

    const FRAME = 1000 / 20;
    let t = 0, raf = 0, last = 0, acc = 0, sweepRow = 0;

    function loop(now) {
        raf = requestAnimationFrame(loop);
        if (!last) last = now;
        const dt = Math.min(now - last, 120);
        last = now;
        acc += dt;
        if (acc < FRAME) return;
        acc = 0;
        t += dt / 1000;

        const batch = Math.max(3, Math.ceil(S.rows / 7));
        for (let k = 0; k < batch; k++) {
            const y = (sweepRow + k) % S.rows;
            rowEls[y].innerHTML = rowHTML(y, t);
        }
        sweepRow = (sweepRow + batch) % S.rows;
    }

    function start() {
        if (raf || reducedMotion()) return;
        last = 0;
        raf = requestAnimationFrame(loop);
    }

    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    }

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(size, 150);
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop(); else start();
    });

    motionQuery.addEventListener('change', () => {
        if (reducedMotion()) stop(); else start();
    });

    charRatio = measureAdvance(100) / 100 || 0.6;
    size();
    buildAll(t);
    start();
})();
