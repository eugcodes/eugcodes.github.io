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
            line += '<span style="color:' + pal[run.fg] +
                    ';background:' + pal[run.bg] + '">' + s + '</span>';
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

    function measureCharRatio() {
        const probe = document.createElement('span');
        probe.textContent = 'MMMMMMMMMM';
        probe.style.cssText =
            'position:absolute;visibility:hidden;white-space:pre;font-size:100px;line-height:1;';
        probe.style.fontFamily = getComputedStyle(host).fontFamily;
        document.body.appendChild(probe);
        const w = probe.getBoundingClientRect().width / 10 / 100;
        probe.remove();
        return w > 0.1 ? w : 0.6;
    }

    function size() {
        const doc = document.documentElement;
        const w = doc.clientWidth, h = doc.clientHeight;
        /* Like background-size: cover — on tall screens the grid overflows
           horizontally and is centre-cropped, so the type stays legible. */
        const fs = Math.max(w / (S.cols * charRatio), h / S.rows);
        const artW = S.cols * charRatio * fs;
        host.style.fontSize = fs.toFixed(3) + 'px';
        host.style.left = ((w - artW) / 2).toFixed(1) + 'px';
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

    charRatio = measureCharRatio();
    size();
    buildAll(t);
    start();
})();
