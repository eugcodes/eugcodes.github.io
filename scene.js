/* Animated ASCII landscape: layered ridges, drifting mist, a reflecting lake.
   Every cell carries both an ink and a paper colour, so the picture is built
   from opaque tones rather than glyphs blended against the page backdrop. */
(() => {
    'use strict';

    const pre = document.getElementById('scene');
    if (!pre) return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reducedMotion = () => motionQuery.matches;

    /* ── Noise ───────────────────────────────────── */

    function hash(x, y) {
        let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    const smooth = t => t * t * (3 - 2 * t);

    function noise1(x, seed) {
        const i = Math.floor(x), f = smooth(x - i);
        return hash(i, seed) * (1 - f) + hash(i + 1, seed) * f;
    }

    function noise2(x, y, seed) {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = smooth(x - ix), fy = smooth(y - iy);
        const a = hash(ix, iy + seed), b = hash(ix + 1, iy + seed);
        const c = hash(ix, iy + 1 + seed), d = hash(ix + 1, iy + 1 + seed);
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }

    function fbm2(x, y, seed, oct) {
        let v = 0, amp = 0.5, f = 1, norm = 0;
        for (let i = 0; i < oct; i++) {
            v += noise2(x * f, y * f, seed + i * 31) * amp;
            norm += amp;
            amp *= 0.5;
            f *= 2;
        }
        return v / norm;
    }

    /* Ridged multifractal — squaring each octave sharpens the crests. */
    function ridged(s, seed, oct) {
        let v = 0, amp = 0.5, f = 1, norm = 0;
        for (let i = 0; i < oct; i++) {
            const n = 1 - Math.abs(noise1(s * f, seed + i * 17) * 2 - 1);
            v += n * n * amp;
            norm += amp;
            amp *= 0.48;
            f *= 2.1;
        }
        return v / norm;
    }

    /* ── Colour ──────────────────────────────────── */

    const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;
    const lerp = (a, b, t) => a + (b - a) * t;

    function mix(c1, c2, t) {
        return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
    }

    const pack = c => (clamp255(c[0]) << 16) | (clamp255(c[1]) << 8) | clamp255(c[2]);
    const unpack = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

    const cssCache = new Map();
    function cssOf(c) {
        let s = cssCache.get(c);
        if (s === undefined) {
            s = '#' + (c | 0x1000000).toString(16).slice(1);
            cssCache.set(c, s);
        }
        return s;
    }

    /* Dusk: desaturated slate overhead easing into a dusty rose horizon. */
    const SKY_TOP = [34, 42, 55];
    const SKY_MID = [70, 80, 94];
    const SKY_LOW = [150, 138, 133];
    const GLOW = [208, 172, 147];
    const STAR = [203, 211, 219];
    const MIST_INK = [188, 198, 207];
    const HAZE = [104, 108, 118];
    const MOON = [236, 228, 214];
    const MOON_GLOW = [214, 184, 158];
    const WATER = [46, 58, 70];
    const DEEP = [17, 21, 28];
    const GLINT = [136, 154, 168];

    /* Far to near: crests drop, tone darkens, drift quickens. */
    const RIDGES = [
        { seed: 11, feat: 5.0, drift: 0.0016, base: 0.100, amp: 0.150, col: [73, 82, 96], haze: 0.30 },
        { seed: 53, feat: 7.0, drift: 0.0037, base: 0.058, amp: 0.098, col: [47, 55, 67], haze: 0.22 },
        { seed: 97, feat: 10.0, drift: 0.0072, base: 0.020, amp: 0.052, col: [25, 30, 38], haze: 0 }
    ];

    const MIST = [
        { y: 0.505, thick: 0.048, speed: 0.011, scale: 6.0, thr: 0.58, seed: 5, alpha: 0.24 },
        { y: 0.578, thick: 0.036, speed: 0.019, scale: 8.0, thr: 0.56, seed: 61, alpha: 0.30 },
        { y: 0.636, thick: 0.026, speed: 0.030, scale: 11.0, thr: 0.54, seed: 83, alpha: 0.36 }
    ];

    /* ── Grid ────────────────────────────────────── */

    let cols = 0, rows = 0, hz = 0, aspect = 1;
    let chars = [], fg = new Int32Array(0), bg = new Int32Array(0);
    let stars = [];
    let charRatio = 0.6;

    function measureCharRatio() {
        const probe = document.createElement('span');
        probe.textContent = 'MMMMMMMMMM';
        probe.style.cssText =
            'position:absolute;visibility:hidden;white-space:pre;font-size:100px;line-height:1;';
        probe.style.fontFamily = getComputedStyle(pre).fontFamily;
        document.body.appendChild(probe);
        const w = probe.getBoundingClientRect().width / 10 / 100;
        probe.remove();
        return w > 0.1 ? w : 0.6;
    }

    function resize() {
        const w = window.innerWidth, h = window.innerHeight;
        /* Hold the cell at a roughly constant size so the art has the same
           grain on a phone as on a desktop, but cap the column count so an
           ultrawide display does not blow up the per-frame cost. Integer
           sizes keep rows on whole pixels, so cell backgrounds tile without
           hairline seams. */
        let fontSize = w < 500 ? 8 : w < 900 ? 11 : 15;
        if (w / (fontSize * charRatio) > 220) {
            fontSize = Math.ceil(w / (220 * charRatio));
        }

        pre.style.fontSize = fontSize + 'px';

        cols = Math.max(20, Math.ceil(w / (fontSize * charRatio)) + 1);
        rows = Math.max(12, Math.ceil(h / fontSize) + 1);
        hz = Math.round(rows * 0.63);
        aspect = w / h;

        const n = cols * rows;
        chars = new Array(n).fill(' ');
        fg = new Int32Array(n);
        bg = new Int32Array(n);

        stars = [];
        const count = Math.round(cols * rows * 0.0055);
        for (let i = 0; i < count; i++) {
            stars.push({
                x: 1 + Math.floor(hash(i, 7001) * (cols - 2)),
                y: Math.floor(hash(i, 7002) * hz * 0.70),
                phase: hash(i, 7003) * 6.283,
                rate: 0.22 + hash(i, 7004) * 0.45
            });
        }
    }

    const octaves = () => (cols > 130 ? 4 : 3);

    /* ── Sky ─────────────────────────────────────── */

    function skyColor(v, t) {
        /* A slow tidal drift between a cooler and a warmer dusk. */
        const warmth = 0.5 + 0.5 * Math.sin(t * 0.021);
        const low = mix(SKY_LOW, [128, 128, 142], 1 - warmth);
        return v < 0.60
            ? mix(SKY_TOP, SKY_MID, smooth(v / 0.60))
            : mix(SKY_MID, low, smooth((v - 0.60) / 0.40));
    }

    function drawSky(t) {
        const glowX = moonX(t);
        const spread = cols * 0.34;
        for (let y = 0; y <= hz; y++) {
            const v = hz > 0 ? y / hz : 0;
            const base = skyColor(v, t);
            const gy = Math.exp(-Math.pow((1 - v) / 0.55, 2));
            const row = y * cols;
            for (let x = 0; x < cols; x++) {
                const gx = Math.exp(-Math.pow((x - glowX) / spread, 2));
                chars[row + x] = ' ';
                bg[row + x] = pack(mix(base, GLOW, gy * gx * 0.42));
            }
        }
    }

    /* The moon rides inside the sky glow, and the lake picks it back up. */
    function moonX(t) {
        return (0.5 + 0.40 * Math.sin(t * 0.0125)) * cols;
    }

    function drawMoon(t) {
        const mx = moonX(t);
        const my = hz * 0.40;
        const R = Math.max(2.2, rows * 0.048);
        const reach = R * 3.6;
        const y0 = Math.max(0, Math.floor(my - reach));
        const y1 = Math.min(hz, Math.ceil(my + reach));

        for (let y = y0; y <= y1; y++) {
            const dy = y - my;
            const row = y * cols;
            for (let x = 0; x < cols; x++) {
                /* Scale x by the cell ratio so the disc is round, not oval. */
                const dx = (x - mx) * charRatio;
                const dist = Math.sqrt(dx * dx + dy * dy) / R;
                if (dist > 3.6) continue;
                const i = row + x;

                const halo = Math.exp(-Math.pow((dist - 0.9) / 1.25, 2));
                let c = mix(unpack(bg[i]), MOON_GLOW, Math.min(0.58, halo * 0.58));

                /* Soft edge on the disc itself, so it is not a blocky square. */
                const core = 1 - smooth(Math.min(1, Math.max(0, (dist - 0.68) / 0.46)));
                if (core > 0.01) {
                    c = mix(c, mix(MOON, MOON_GLOW, dist * 0.4), core);
                    chars[i] = ' ';
                }
                bg[i] = pack(c);
            }
        }
    }

    function drawStars(t) {
        for (let i = 0; i < stars.length; i++) {
            const s = stars[i];
            if (s.y > hz) continue;
            const tw = 0.5 + 0.5 * Math.sin(t * s.rate + s.phase);
            const fade = 1 - s.y / (hz * 0.70 + 1);
            const k = tw * (0.30 + 0.70 * fade);
            const idx = s.y * cols + s.x;
            chars[idx] = k > 0.88 ? '*' : k > 0.45 ? '·' : '.';
            fg[idx] = pack(mix(unpack(bg[idx]), STAR, 0.35 + k * 0.55));
        }
    }

    /* ── Ridges ──────────────────────────────────── */

    function drawRidges(t) {
        const oct = octaves();
        const last = RIDGES.length - 1;
        const horizon = skyColor(1, t);

        for (let r = 0; r < RIDGES.length; r++) {
            const R = RIDGES[r];
            /* Distant ridges haze out into a cool veil lit by the horizon;
               the nearest one falls away into shadow instead. */
            const target = R.haze > 0 ? mix(HAZE, horizon, 0.35) : DEEP;
            const strength = R.haze > 0 ? R.haze : 0.34;

            for (let x = 0; x < cols; x++) {
                const s = (x / cols + t * R.drift) * R.feat;
                const h = (R.base + R.amp * ridged(s, R.seed, oct)) * rows;
                const crest = hz - h;
                const top = Math.floor(crest);
                const fill = 1 - (crest - top);
                const span = hz - crest + 1;

                /* A half block gives the crest sub-cell precision. */
                if (top >= 0 && top < rows && fill > 0.30 && fill <= 0.72) {
                    const i = top * cols + x;
                    chars[i] = '▄';
                    fg[i] = pack(R.col);
                }

                const from = fill > 0.72 ? top : top + 1;
                for (let y = Math.max(0, from); y <= hz; y++) {
                    const i = y * cols + x;
                    const dz = (y - crest) / span;
                    let c = mix(R.col, target, dz * strength);
                    chars[i] = ' ';
                    /* Sparse grain so the slopes are not perfectly flat. */
                    if (r === last && fbm2(x * 0.10, y * 0.26, R.seed, 2) > 0.60) {
                        chars[i] = '░';
                        fg[i] = pack(mix(c, horizon, 0.16));
                    }
                    bg[i] = pack(c);
                }
            }
        }
    }

    /* ── Water ───────────────────────────────────── */

    function drawWater(t) {
        const depth = rows - hz;
        if (depth <= 1) return;
        const glintPos = 0.36 + 0.20 * Math.sin(t * 0.055);
        const horizon = skyColor(1, t);

        /* Mean tone of each mirrored row. Blending toward it lets the
           reflection dissolve from a sharp image at the shore into a soft
           tonal wash further out, instead of a field of wobbled debris. */
        const mean = [];
        for (let d = 1; d <= depth; d++) {
            const sr = hz - d;
            if (sr < 0) { mean.push(skyColor(0, t)); continue; }
            let r = 0, g = 0, b = 0;
            const row = sr * cols;
            for (let x = 0; x < cols; x++) {
                const c = bg[row + x];
                r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255;
            }
            mean.push([r / cols, g / cols, b / cols]);
        }

        for (let y = hz + 1; y < rows; y++) {
            const d = y - hz;
            const dn = d / depth;
            /* The mirror is near-true at the shore and loosens with distance. */
            const amp = 0.15 + dn * dn * 3.4;
            const swell = Math.sin(d * 0.55 + t * 0.5) * 0.55 + Math.sin(d * 0.23 - t * 0.31) * 0.45;
            const jitter = noise2(d * 0.35, t * 0.22, 313) - 0.5;
            const off = Math.round(swell * amp + jitter * amp * 1.3);

            const srcRow = hz - d;
            const refl = Math.exp(-dn * 1.7);
            /* A bright lip right at the waterline snaps the shoreline into place. */
            const lip = Math.exp(-Math.pow(d / 1.6, 2));
            const row = y * cols;
            const wash = mean[d - 1];
            const blur = Math.min(0.88, 0.42 + dn * 0.70);
            const swarm = Math.exp(-Math.pow((dn - 0.5) / 0.34, 2));
            const ripThr = 0.54 + (1 - swarm) * 0.20;

            for (let x = 0; x < cols; x++) {
                let sc;
                if (srcRow >= 0) {
                    let sx = x + off;
                    if (sx < 0) sx = 0; else if (sx >= cols) sx = cols - 1;
                    sc = mix(unpack(bg[srcRow * cols + sx]), wash, blur);
                } else {
                    sc = skyColor(0, t);
                }

                let c = mix(mix(sc, WATER, 0.26 + (1 - refl) * 0.34), DEEP, dn * 0.74);
                if (lip > 0.02) {
                    /* Break the shoreline shimmer along its length so it does
                       not read as a ruled line. */
                    const v = 0.45 + 0.55 * noise2((x / cols) * 14 + t * 0.05, d * 0.7, 211);
                    c = mix(c, mix(horizon, MOON_GLOW, 0.35), lip * v * 0.34);
                }

                const i = row + x;
                bg[i] = pack(c);
                chars[i] = ' ';

                /* Ripples gather in the middle of the lake and fall quiet at
                   both the far shore and the near edge. */
                const p = fbm2(
                    (x / cols) * 9.0 * aspect + t * 0.030,
                    dn * 7.5 - t * 0.14,
                    409, 2
                );
                if (p > ripThr) {
                    const k = (p - ripThr) / (1 - ripThr);
                    chars[i] = k > 0.5 ? '≈' : '~';
                    const g = Math.exp(-Math.pow((dn - glintPos) / 0.13, 2));
                    fg[i] = pack(mix(c, GLINT, 0.16 + k * 0.18 + g * 0.34));
                }
            }
        }
    }

    /* ── Mist ────────────────────────────────────── */

    function drawMist(t) {
        const oct = octaves() - 1;
        for (let m = 0; m < MIST.length; m++) {
            const M = MIST[m];
            const cy = M.y * rows, th = M.thick * rows;
            const y0 = Math.max(0, Math.floor(cy - th * 2.2));
            const y1 = Math.min(rows - 1, Math.ceil(cy + th * 2.2));
            for (let y = y0; y <= y1; y++) {
                const env = Math.exp(-Math.pow((y - cy) / th, 2));
                if (env < 0.05) continue;
                const row = y * cols;
                for (let x = 0; x < cols; x++) {
                    const n = fbm2(
                        (x / cols + t * M.speed) * M.scale,
                        (y / rows) * M.scale * 3.0,
                        M.seed, oct
                    );
                    if (n <= M.thr) continue;
                    const k = ((n - M.thr) / (1 - M.thr)) * env;
                    if (k < 0.05) continue;
                    const i = row + x;
                    const veil = mix(unpack(bg[i]), MIST_INK, Math.min(0.38, k * M.alpha * 1.3));
                    bg[i] = pack(veil);
                    if (k > 0.52) {
                        chars[i] = k > 0.74 ? '░' : '·';
                        fg[i] = pack(mix(veil, MIST_INK, 0.42));
                    }
                }
            }
        }
    }

    /* ── Birds ───────────────────────────────────── */

    let flock = null, nextFlock = 16;

    function updateBirds(t, dt) {
        if (!flock && t > nextFlock) {
            const k = Math.floor(t);
            const dir = hash(k, 55) > 0.5 ? 1 : -1;
            const n = 3 + Math.floor(hash(k, 56) * 3);
            const birds = [];
            for (let i = 0; i < n; i++) {
                birds.push({
                    ox: -i * (2.2 + hash(i, 57) * 1.6) * dir,
                    oy: (hash(i, 58) - 0.5) * 3.2,
                    ph: hash(i, 59) * 6.283
                });
            }
            flock = {
                x: dir > 0 ? -8 : cols + 8,
                y: hz * (0.34 + hash(k, 60) * 0.24),
                dir,
                speed: 2.4 + hash(k, 61) * 1.6,
                birds
            };
        }
        if (!flock) return;

        flock.x += flock.dir * flock.speed * dt;
        if (flock.dir > 0 ? flock.x > cols + 14 : flock.x < -14) {
            flock = null;
            nextFlock = t + 50 + hash(Math.floor(t), 62) * 80;
            return;
        }

        for (let i = 0; i < flock.birds.length; i++) {
            const b = flock.birds[i];
            const x = Math.round(flock.x + b.ox);
            const y = Math.round(flock.y + b.oy + Math.sin(t * 0.5 + b.ph) * 1.1);
            if (x < 0 || x >= cols || y < 0 || y >= hz) continue;
            const p = Math.sin(t * 5 + b.ph);
            const j = y * cols + x;
            chars[j] = p > 0.35 ? '^' : p < -0.35 ? 'v' : '-';
            fg[j] = pack(mix(unpack(bg[j]), [30, 36, 45], 0.78));
        }
    }

    /* ── Paint ───────────────────────────────────── */

    const out = [];

    function paint() {
        out.length = 0;
        for (let y = 0; y < rows; y++) {
            const base = y * cols;
            let row = '', run = '', runFg = -1, runBg = -1;
            for (let x = 0; x < cols; x++) {
                const ch = chars[base + x];
                /* Quantising to 64 levels per channel lengthens the colour
                   runs without banding the gradients into visible blocks.
                   A blank cell has no ink, so it merges on paper alone. */
                const b = bg[base + x] & 0xFCFCFC;
                const f = ch === ' ' ? runFg : (fg[base + x] & 0xFCFCFC);
                if (b !== runBg || f !== runFg) {
                    if (run) row += '<span style="color:' + cssOf(runFg) + ';background:' + cssOf(runBg) + '">' + run + '</span>';
                    run = '';
                    runFg = f;
                    runBg = b;
                }
                run += ch;
            }
            if (run) row += '<span style="color:' + cssOf(runFg) + ';background:' + cssOf(runBg) + '">' + run + '</span>';
            out.push(row);
        }
        pre.innerHTML = out.join('\n');
    }

    function render(t, dt) {
        drawSky(t);
        drawMoon(t);
        drawStars(t);
        drawRidges(t);
        drawWater(t);
        drawMist(t);
        updateBirds(t, dt);
        paint();
    }

    /* ── Loop ────────────────────────────────────── */

    const FRAME = 1000 / 20;
    let t = 40, last = 0, acc = 0, raf = 0;

    function loop(now) {
        raf = requestAnimationFrame(loop);
        if (!last) last = now;
        const dt = Math.min(now - last, 120);
        last = now;
        acc += dt;
        if (acc < FRAME) return;
        acc = 0;
        /* Scene time advances only while drawing, so a hidden tab never jumps. */
        t += dt / 1000;
        render(t, dt / 1000);
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
        resizeTimer = setTimeout(() => {
            resize();
            render(t, 0);
        }, 150);
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop(); else start();
    });

    motionQuery.addEventListener('change', () => {
        if (reducedMotion()) { stop(); render(t, 0); } else start();
    });

    charRatio = measureCharRatio();
    resize();
    render(t, 0);
    start();
})();
