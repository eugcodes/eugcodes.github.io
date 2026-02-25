// ============================================================
// Murmuration — A meditative interactive starling simulation
// ============================================================

const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');

// --- State ---
let width, height, dpr;
let mouseX = 0, mouseY = 0, mouseActive = false, mouseStrength = 0;
let birds = [];
let treeCache = null;
let groundCache = null;
let numBirds = 450;
const startTime = performance.now();

// --- Configuration ---
const VISUAL_RANGE = 65;
const PROTECTED_RANGE = 22;
const MAX_SPEED = 3.5;
const MIN_SPEED = 1.5;
const SEPARATION = 0.05;
const ALIGNMENT = 0.045;
const COHESION = 0.004;
const MOUSE_RADIUS = 250;
const MOUSE_FORCE = 0.08;
const BOUNDARY_MARGIN = 80;
const TURN_FACTOR = 0.15;
const MAX_NEIGHBORS = 7;

// --- Seeded PRNG (Mulberry32) ---
function seededRandom(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ============================================================
// Spatial Grid — O(n) neighbour look-ups for Boids
// ============================================================
const grid = {
    cellSize: VISUAL_RANGE,
    cells: new Map(),

    clear() {
        this.cells.clear();
    },

    _key(cx, cy) {
        return cx * 73856093 ^ cy * 19349663;
    },

    insert(bird) {
        const cx = (bird.x / this.cellSize) | 0;
        const cy = (bird.y / this.cellSize) | 0;
        const k = this._key(cx, cy);
        let cell = this.cells.get(k);
        if (!cell) {
            cell = [];
            this.cells.set(k, cell);
        }
        cell.push(bird);
    },

    getNeighbors(bird, range) {
        const result = [];
        const cx = (bird.x / this.cellSize) | 0;
        const cy = (bird.y / this.cellSize) | 0;
        const r = Math.ceil(range / this.cellSize);
        const rangeSq = range * range;

        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                const cell = this.cells.get(this._key(cx + dx, cy + dy));
                if (!cell) continue;
                for (let i = 0; i < cell.length; i++) {
                    const other = cell[i];
                    if (other === bird) continue;
                    const distSq =
                        (bird.x - other.x) ** 2 + (bird.y - other.y) ** 2;
                    if (distSq < rangeSq) {
                        other._distSq = distSq;
                        result.push(other);
                    }
                }
            }
        }

        // Topological rule: keep only the nearest MAX_NEIGHBORS
        if (result.length > MAX_NEIGHBORS) {
            result.sort((a, b) => a._distSq - b._distSq);
            result.length = MAX_NEIGHBORS;
        }
        return result;
    },
};

// ============================================================
// Bird creation
// ============================================================
function createBirds() {
    birds = [];
    const cx = width * 0.5;
    const cy = height * 0.35;

    for (let i = 0; i < numBirds; i++) {
        // Approximate Gaussian via sum-of-uniforms
        const rx = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
        const ry = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
        const angle = Math.random() * Math.PI * 2;
        const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);

        birds.push({
            x: cx + rx * width * 0.55,
            y: cy + ry * height * 0.4,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: 1.4 + Math.random() * 1.6,
            alpha: 0.3 + Math.random() * 0.55,
            _distSq: 0,
        });
    }
}

// ============================================================
// Procedural tree generation (recursive branching)
// ============================================================
function buildBranch(tctx, x, y, angle, length, depth, rng) {
    if (depth <= 0 || length < 1.5) return;

    const endX = x + Math.cos(angle) * length;
    const endY = y + Math.sin(angle) * length;

    tctx.beginPath();
    tctx.moveTo(x, y);
    tctx.lineTo(endX, endY);
    tctx.lineWidth = Math.max(0.5, depth * 0.7);
    tctx.stroke();

    const numBranches = depth > 5 ? (rng() > 0.6 ? 3 : 2) : 2;
    const spread = 0.3 + rng() * 0.25;
    const shrink = 0.62 + rng() * 0.16;

    for (let i = 0; i < numBranches; i++) {
        const ba =
            angle +
            (i - (numBranches - 1) / 2) * spread +
            (rng() - 0.5) * 0.15;
        buildBranch(tctx, endX, endY, ba, length * shrink, depth - 1, rng);
    }
}

function generateScenery() {
    // ----- Trees (offscreen canvas) -----
    const treeOff = document.createElement('canvas');
    treeOff.width = width * dpr;
    treeOff.height = height * dpr;
    const tctx = treeOff.getContext('2d');
    tctx.scale(dpr, dpr);
    tctx.strokeStyle = '#080605';
    tctx.lineCap = 'round';

    const treeDefs = [
        { x: 0.06, y: 0.88, scale: 0.95, seed: 101 },
        { x: 0.15, y: 0.90, scale: 0.55, seed: 202 },
        { x: 0.23, y: 0.895, scale: 0.72, seed: 303 },
        { x: 0.74, y: 0.87, scale: 1.0, seed: 404 },
        { x: 0.84, y: 0.895, scale: 0.52, seed: 505 },
        { x: 0.93, y: 0.88, scale: 0.78, seed: 606 },
    ];

    for (const td of treeDefs) {
        const rng = seededRandom(td.seed);
        const trunkLen = height * 0.11 * td.scale;
        buildBranch(
            tctx,
            width * td.x,
            height * td.y,
            -Math.PI / 2 + (rng() - 0.5) * 0.08,
            trunkLen,
            9,
            rng
        );
    }

    treeCache = treeOff;

    // ----- Rolling-hill ground (offscreen canvas) -----
    const groundOff = document.createElement('canvas');
    groundOff.width = width * dpr;
    groundOff.height = height * dpr;
    const gctx = groundOff.getContext('2d');
    gctx.scale(dpr, dpr);
    gctx.fillStyle = '#080605';
    gctx.beginPath();
    gctx.moveTo(0, height);

    for (let x = 0; x <= width; x += 2) {
        const y =
            height * 0.88 +
            Math.sin(x * 0.003 + 0.5) * height * 0.015 +
            Math.sin(x * 0.0008 + 2.0) * height * 0.01 +
            Math.sin(x * 0.006) * height * 0.005;
        gctx.lineTo(x, y);
    }

    gctx.lineTo(width, height);
    gctx.closePath();
    gctx.fill();
    groundCache = groundOff;
}

// ============================================================
// Sky / Sunset
// ============================================================
function drawSky(time) {
    const breathe = Math.sin(time * 0.00005) * 0.03;

    // Gradient sky
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0.0, '#0d1b2a');
    grad.addColorStop(0.25, '#1b2838');
    grad.addColorStop(0.45, '#3d2645');
    grad.addColorStop(0.60, '#6b3a5a');
    grad.addColorStop(0.73, '#a8624a');
    grad.addColorStop(0.83, '#d4944d');
    grad.addColorStop(0.90, '#e8a95d');
    grad.addColorStop(1.0, '#b07040');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Sun position (barely drifts)
    const sunX = width * 0.35;
    const sunY = height * 0.82 + Math.sin(time * 0.00003) * height * 0.01;
    const sunR = Math.min(width, height) * 0.065;

    // Wide atmospheric glow
    const glow = ctx.createRadialGradient(
        sunX, sunY, sunR * 0.3,
        sunX, sunY, sunR * 7
    );
    glow.addColorStop(0, `rgba(255,210,140,${(0.35 + breathe).toFixed(3)})`);
    glow.addColorStop(0.15, `rgba(255,180,100,${(0.15 + breathe).toFixed(3)})`);
    glow.addColorStop(0.4, 'rgba(255,140,70,0.05)');
    glow.addColorStop(1, 'rgba(255,100,50,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    // Sun disc
    const disc = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
    disc.addColorStop(0, 'rgba(255,240,200,0.95)');
    disc.addColorStop(0.5, 'rgba(255,210,150,0.85)');
    disc.addColorStop(0.85, 'rgba(255,180,110,0.5)');
    disc.addColorStop(1, 'rgba(255,150,80,0)');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR * 1.3, 0, Math.PI * 2);
    ctx.fill();
}

// ============================================================
// Boid simulation
// ============================================================
function updateBirds(time) {
    grid.clear();
    for (let i = 0; i < birds.length; i++) grid.insert(birds[i]);

    // Slowly drifting wind
    const t = time * 0.001;
    const windX = Math.sin(t * 0.08) * 0.015;
    const windY = Math.cos(t * 0.06) * 0.008;

    // Slowly orbiting global attractor keeps flock centered and sweeping
    const aTime = time * 0.0003;
    const attractX = width * 0.5 + Math.cos(aTime) * width * 0.2;
    const attractY = height * 0.35 + Math.sin(aTime * 0.7) * height * 0.12;

    // Smooth mouse influence
    const targetStrength = mouseActive ? 1 : 0;
    mouseStrength += (targetStrength - mouseStrength) * 0.05;

    const treeLineY = height * 0.78;

    for (let i = 0; i < birds.length; i++) {
        const bird = birds[i];
        const neighbors = grid.getNeighbors(bird, VISUAL_RANGE);

        let sepX = 0, sepY = 0;
        let alignX = 0, alignY = 0;
        let cohX = 0, cohY = 0;
        const count = neighbors.length;

        for (let j = 0; j < count; j++) {
            const other = neighbors[j];
            const dx = bird.x - other.x;
            const dy = bird.y - other.y;
            const distSq = other._distSq;

            // Separation
            if (distSq < PROTECTED_RANGE * PROTECTED_RANGE && distSq > 0) {
                const d = Math.sqrt(distSq);
                sepX += dx / d;
                sepY += dy / d;
            }
            alignX += other.vx;
            alignY += other.vy;
            cohX += other.x;
            cohY += other.y;
        }

        if (count > 0) {
            alignX /= count;
            alignY /= count;
            bird.vx += (alignX - bird.vx) * ALIGNMENT;
            bird.vy += (alignY - bird.vy) * ALIGNMENT;

            cohX /= count;
            cohY /= count;
            bird.vx += (cohX - bird.x) * COHESION;
            bird.vy += (cohY - bird.y) * COHESION;
        }

        bird.vx += sepX * SEPARATION;
        bird.vy += sepY * SEPARATION;

        // Wind
        bird.vx += windX;
        bird.vy += windY;

        // Gentle global attractor (sweeping arcs)
        const adx = attractX - bird.x;
        const ady = attractY - bird.y;
        const adist = Math.sqrt(adx * adx + ady * ady);
        if (adist > 1) {
            bird.vx += (adx / adist) * 0.005;
            bird.vy += (ady / adist) * 0.005;
        }

        // Subtle wander
        bird.vx += (Math.random() - 0.5) * 0.08;
        bird.vy += (Math.random() - 0.5) * 0.08;

        // Mouse / touch influence
        if (mouseStrength > 0.01) {
            const mdx = mouseX - bird.x;
            const mdy = mouseY - bird.y;
            const mdist = Math.sqrt(mdx * mdx + mdy * mdy);

            if (mdist < MOUSE_RADIUS && mdist > 1) {
                const f =
                    (1 - mdist / MOUSE_RADIUS) * MOUSE_FORCE * mouseStrength;
                if (mdist < MOUSE_RADIUS * 0.25) {
                    // Very close → gently deflect
                    bird.vx -= (mdx / mdist) * f * 1.5;
                    bird.vy -= (mdy / mdist) * f * 1.5;
                } else {
                    // Farther → gently attract
                    bird.vx += (mdx / mdist) * f;
                    bird.vy += (mdy / mdist) * f;
                }
            }
        }

        // Soft boundary avoidance
        if (bird.x < BOUNDARY_MARGIN) bird.vx += TURN_FACTOR;
        if (bird.x > width - BOUNDARY_MARGIN) bird.vx -= TURN_FACTOR;
        if (bird.y < BOUNDARY_MARGIN) bird.vy += TURN_FACTOR;
        if (bird.y > treeLineY) bird.vy -= TURN_FACTOR * 1.5;

        // Speed clamp
        const speed = Math.sqrt(bird.vx * bird.vx + bird.vy * bird.vy);
        if (speed > MAX_SPEED) {
            bird.vx = (bird.vx / speed) * MAX_SPEED;
            bird.vy = (bird.vy / speed) * MAX_SPEED;
        } else if (speed < MIN_SPEED && speed > 0) {
            bird.vx = (bird.vx / speed) * MIN_SPEED;
            bird.vy = (bird.vy / speed) * MIN_SPEED;
        }

        bird.x += bird.vx;
        bird.y += bird.vy;

        // Wrap far-out-of-bounds birds
        if (bird.x < -60) bird.x = width + 50;
        if (bird.x > width + 60) bird.x = -50;
        if (bird.y < -60) bird.y = height * 0.3;
        if (bird.y > height + 20) bird.y = height * 0.3;
    }
}

// ============================================================
// Bird rendering (batched by opacity band)
// ============================================================
function drawBirds() {
    const bands = [[], [], [], []];

    for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        const idx = Math.min(3, (b.alpha * 4) | 0);
        bands[idx].push(b);
    }

    const alphas = [0.25, 0.45, 0.65, 0.85];
    ctx.fillStyle = '#151010';

    for (let b = 0; b < 4; b++) {
        const band = bands[b];
        if (band.length === 0) continue;

        ctx.globalAlpha = alphas[b];
        ctx.beginPath();

        for (let i = 0; i < band.length; i++) {
            const bird = band[i];
            const angle = Math.atan2(bird.vy, bird.vx);
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const s = bird.size;

            // Bird silhouette: swept V-shape
            ctx.moveTo(
                bird.x + cos * s * 2,
                bird.y + sin * s * 2
            );
            ctx.lineTo(
                bird.x - cos * s + sin * s * 0.7,
                bird.y - sin * s - cos * s * 0.7
            );
            ctx.lineTo(
                bird.x - cos * s * 0.2,
                bird.y - sin * s * 0.2
            );
            ctx.lineTo(
                bird.x - cos * s - sin * s * 0.7,
                bird.y - sin * s + cos * s * 0.7
            );
        }

        ctx.fill();
    }

    ctx.globalAlpha = 1;
}

// ============================================================
// Resize
// ============================================================
function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    // Scale bird count to screen area (min 150, max 500)
    numBirds = Math.max(150, Math.min(500, Math.floor((width * height) / 3500)));

    generateScenery();
}

// ============================================================
// Main loop
// ============================================================
function animate(timestamp) {
    const time = timestamp - startTime;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawSky(time);

    if (groundCache) ctx.drawImage(groundCache, 0, 0, width, height);
    if (treeCache) ctx.drawImage(treeCache, 0, 0, width, height);

    updateBirds(time);
    drawBirds();

    requestAnimationFrame(animate);
}

// ============================================================
// Events
// ============================================================
window.addEventListener('resize', resize);

// Desktop
window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    mouseActive = true;
});
window.addEventListener('mouseleave', () => {
    mouseActive = false;
});

// Mobile / tablet
window.addEventListener(
    'touchstart',
    (e) => {
        const t = e.touches[0];
        mouseX = t.clientX;
        mouseY = t.clientY;
        mouseActive = true;
    },
    { passive: true }
);
window.addEventListener(
    'touchmove',
    (e) => {
        const t = e.touches[0];
        mouseX = t.clientX;
        mouseY = t.clientY;
        mouseActive = true;
    },
    { passive: true }
);
window.addEventListener('touchend', () => {
    mouseActive = false;
});

// ============================================================
// Init
// ============================================================
resize();
createBirds();
requestAnimationFrame(animate);
