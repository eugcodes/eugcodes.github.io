// ============================================================
// Murmuration — A meditative interactive starling simulation
// ============================================================

const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');

// --- State ---
let width, height, dpr;
let mouseX = 0, mouseY = 0, mouseActive = false, mouseStrength = 0;
let birds = [];
let numBirds = 450;
const startTime = performance.now();

// --- Configuration ---
const VISUAL_RANGE   = 65;
const PROTECTED_RANGE = 22;
const MAX_SPEED      = 2.0;
const MIN_SPEED      = 0.8;
const SEPARATION     = 0.05;
const ALIGNMENT      = 0.032;
const COHESION       = 0.004;
const MOUSE_RADIUS   = 250;
const MOUSE_FORCE    = 0.08;
const BOUNDARY_AWARENESS = 220;
const TURN_FACTOR    = 0.15;
const MAX_NEIGHBORS  = 7;
const FOCAL          = 1500;   // perspective focal length (px)
const DEPTH_HALF     = 400;    // half-depth of 3-D volume (px)

// ============================================================
// Spatial Grid — O(n) neighbour look-ups for Boids (3-D)
// ============================================================
const grid = {
    cellSize: VISUAL_RANGE,
    cells: new Map(),

    clear() { this.cells.clear(); },

    _key(cx, cy, cz) {
        return (cx * 73856093 ^ cy * 19349663 ^ cz * 83492791) | 0;
    },

    insert(bird) {
        const cx = (bird.x / this.cellSize) | 0;
        const cy = (bird.y / this.cellSize) | 0;
        const cz = (bird.z / this.cellSize) | 0;
        const k  = this._key(cx, cy, cz);
        let cell = this.cells.get(k);
        if (!cell) { cell = []; this.cells.set(k, cell); }
        cell.push(bird);
    },

    getNeighbors(bird, range) {
        const result = [];
        const cx = (bird.x / this.cellSize) | 0;
        const cy = (bird.y / this.cellSize) | 0;
        const cz = (bird.z / this.cellSize) | 0;
        const r  = Math.ceil(range / this.cellSize);
        const rangeSq = range * range;

        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dz = -r; dz <= r; dz++) {
                    const cell = this.cells.get(this._key(cx+dx, cy+dy, cz+dz));
                    if (!cell) continue;
                    for (let i = 0; i < cell.length; i++) {
                        const other = cell[i];
                        if (other === bird) continue;
                        const distSq =
                            (bird.x - other.x) ** 2 +
                            (bird.y - other.y) ** 2 +
                            (bird.z - other.z) ** 2;
                        if (distSq < rangeSq) {
                            other._distSq = distSq;
                            result.push(other);
                        }
                    }
                }
            }
        }

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
    const cx = width  * 0.5;
    const cy = height * 0.38;

    for (let i = 0; i < numBirds; i++) {
        const rx = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
        const ry = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
        const angle  = Math.random() * Math.PI * 2;
        const angleZ = Math.random() * Math.PI * 2;
        const speed  = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);

        birds.push({
            x:     cx + rx * width  * 0.55,
            y:     cy + ry * height * 0.4,
            z:     (Math.random() - 0.5) * DEPTH_HALF * 1.6,
            vx:    Math.cos(angle)  * speed,
            vy:    Math.sin(angle)  * speed,
            vz:    Math.cos(angleZ) * speed * 0.5,
            size:  1.4 + Math.random() * 1.6,
            alpha: 0.3 + Math.random() * 0.55,
            phase: Math.random() * Math.PI * 2,
            _distSq: 0,
            _w: 1,   // perspective scale, computed each frame
        });
    }
}

// ============================================================
// Sky — inspired by deep cobalt dusk with warm amber horizon
// ============================================================
function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0.00, '#0e2d48');   // deep cobalt
    grad.addColorStop(0.18, '#163d62');
    grad.addColorStop(0.40, '#1e5072');
    grad.addColorStop(0.58, '#2a6070');   // steel-blue mid
    grad.addColorStop(0.67, '#586065');   // muted transition
    grad.addColorStop(0.76, '#937050');   // warm starts
    grad.addColorStop(0.85, '#c87040');   // amber
    grad.addColorStop(0.93, '#df8530');   // bright orange
    grad.addColorStop(1.00, '#b85a14');   // deep orange at base
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
}

// ============================================================
// Boid simulation — full 3-D
// ============================================================
function updateBirds(time) {
    grid.clear();
    for (let i = 0; i < birds.length; i++) grid.insert(birds[i]);

    const t = time * 0.001;
    const windX = Math.sin(t * 0.08) * 0.015;
    const windY = Math.cos(t * 0.06) * 0.008;
    const windZ = Math.sin(t * 0.05 + 1.0) * 0.008;

    // Two quasi-periodic 3-D attractors — irrational frequency ratios
    // prevent repetition and eliminate geometric looping
    const aTime = time * 0.0002;
    const a1x = width  * 0.5  + Math.cos(aTime * 1.0)   * width  * 0.22
                               + Math.cos(aTime * 1.618) * width  * 0.07;
    const a1y = height * 0.38 + Math.sin(aTime * 0.7)   * height * 0.14
                               + Math.sin(aTime * 2.414) * height * 0.04;
    const a1z =                  Math.sin(aTime * 0.9)   * DEPTH_HALF * 0.5
                               + Math.sin(aTime * 1.414) * DEPTH_HALF * 0.2;

    const a2x = width  * 0.5  + Math.cos(aTime * 0.618 + 2.1) * width  * 0.18
                               + Math.cos(aTime * 1.3   + 0.9) * width  * 0.09;
    const a2y = height * 0.42 + Math.sin(aTime * 0.8   + 1.5) * height * 0.11
                               + Math.sin(aTime * 1.732 + 0.3) * height * 0.05;
    const a2z =                  Math.cos(aTime * 0.7   + 1.8) * DEPTH_HALF * 0.5
                               + Math.cos(aTime * 1.1   + 0.5) * DEPTH_HALF * 0.2;

    const targetStrength = mouseActive ? 1 : 0;
    mouseStrength += (targetStrength - mouseStrength) * 0.05;

    for (let i = 0; i < birds.length; i++) {
        const bird = birds[i];
        const neighbors = grid.getNeighbors(bird, VISUAL_RANGE);

        let sepX = 0, sepY = 0, sepZ = 0;
        let alignX = 0, alignY = 0, alignZ = 0;
        let cohX = 0, cohY = 0, cohZ = 0;
        const count = neighbors.length;

        for (let j = 0; j < count; j++) {
            const other = neighbors[j];
            const dx = bird.x - other.x;
            const dy = bird.y - other.y;
            const dz = bird.z - other.z;
            const distSq = other._distSq;

            if (distSq < PROTECTED_RANGE * PROTECTED_RANGE && distSq > 0) {
                const d = Math.sqrt(distSq);
                sepX += dx / d;
                sepY += dy / d;
                sepZ += dz / d;
            }
            alignX += other.vx;  alignY += other.vy;  alignZ += other.vz;
            cohX   += other.x;   cohY   += other.y;   cohZ   += other.z;
        }

        if (count > 0) {
            alignX /= count; alignY /= count; alignZ /= count;
            bird.vx += (alignX - bird.vx) * ALIGNMENT;
            bird.vy += (alignY - bird.vy) * ALIGNMENT;
            bird.vz += (alignZ - bird.vz) * ALIGNMENT;

            cohX /= count; cohY /= count; cohZ /= count;
            bird.vx += (cohX - bird.x) * COHESION;
            bird.vy += (cohY - bird.y) * COHESION;
            bird.vz += (cohZ - bird.z) * COHESION;
        }

        bird.vx += sepX * SEPARATION;
        bird.vy += sepY * SEPARATION;
        bird.vz += sepZ * SEPARATION;

        // Wind
        bird.vx += windX;
        bird.vy += windY;
        bird.vz += windZ;

        // Dual attractor pull — 3-D
        const a1dx = a1x - bird.x, a1dy = a1y - bird.y, a1dz = a1z - bird.z;
        const a1dist = Math.sqrt(a1dx*a1dx + a1dy*a1dy + a1dz*a1dz);
        const a2dx = a2x - bird.x, a2dy = a2y - bird.y, a2dz = a2z - bird.z;
        const a2dist = Math.sqrt(a2dx*a2dx + a2dy*a2dy + a2dz*a2dz);
        if (a1dist > 1) {
            bird.vx += (a1dx / a1dist) * 0.004;
            bird.vy += (a1dy / a1dist) * 0.004;
            bird.vz += (a1dz / a1dist) * 0.004;
        }
        if (a2dist > 1) {
            bird.vx += (a2dx / a2dist) * 0.003;
            bird.vy += (a2dy / a2dist) * 0.003;
            bird.vz += (a2dz / a2dist) * 0.003;
        }

        // Per-bird oscillating wander (each bird's own phase breaks lockstep)
        const bp = bird.phase + t * 0.3;
        bird.vx += Math.sin(bp * 1.3  + 0.5) * 0.03 + (Math.random() - 0.5) * 0.06;
        bird.vy += Math.cos(bp * 1.07 + 1.2) * 0.02 + (Math.random() - 0.5) * 0.06;
        bird.vz += Math.sin(bp * 0.9  + 2.1) * 0.02 + (Math.random() - 0.5) * 0.04;

        // Mouse / touch influence (screen-plane only)
        if (mouseStrength > 0.01) {
            const mdx = mouseX - bird.x;
            const mdy = mouseY - bird.y;
            const mdist = Math.sqrt(mdx*mdx + mdy*mdy);
            if (mdist < MOUSE_RADIUS && mdist > 1) {
                const f = (1 - mdist / MOUSE_RADIUS) * MOUSE_FORCE * mouseStrength;
                if (mdist < MOUSE_RADIUS * 0.25) {
                    bird.vx -= (mdx / mdist) * f * 1.5;
                    bird.vy -= (mdy / mdist) * f * 1.5;
                } else {
                    bird.vx += (mdx / mdist) * f;
                    bird.vy += (mdy / mdist) * f;
                }
            }
        }

        // Graduated XY boundary avoidance (quadratic ramp, starts early)
        const bL = bird.x, bR = width  - bird.x;
        const bT = bird.y, bB = height - bird.y;
        if (bL < BOUNDARY_AWARENESS) bird.vx += TURN_FACTOR * Math.pow(1 - bL / BOUNDARY_AWARENESS, 2);
        if (bR < BOUNDARY_AWARENESS) bird.vx -= TURN_FACTOR * Math.pow(1 - bR / BOUNDARY_AWARENESS, 2);
        if (bT < BOUNDARY_AWARENESS) bird.vy += TURN_FACTOR * Math.pow(1 - bT / BOUNDARY_AWARENESS, 2);
        if (bB < BOUNDARY_AWARENESS) bird.vy -= TURN_FACTOR * 1.5 * Math.pow(1 - bB / BOUNDARY_AWARENESS, 2);

        // Z boundary avoidance (same quadratic ramp)
        const bZN = bird.z + DEPTH_HALF;          // distance from near plane
        const bZF = DEPTH_HALF - bird.z;          // distance from far plane
        if (bZN < BOUNDARY_AWARENESS) bird.vz += TURN_FACTOR * Math.pow(1 - bZN / BOUNDARY_AWARENESS, 2);
        if (bZF < BOUNDARY_AWARENESS) bird.vz -= TURN_FACTOR * Math.pow(1 - bZF / BOUNDARY_AWARENESS, 2);

        // 3-D speed clamp
        const spd = Math.sqrt(bird.vx*bird.vx + bird.vy*bird.vy + bird.vz*bird.vz);
        if (spd > MAX_SPEED) {
            const s = MAX_SPEED / spd;
            bird.vx *= s; bird.vy *= s; bird.vz *= s;
        } else if (spd < MIN_SPEED && spd > 0) {
            const s = MIN_SPEED / spd;
            bird.vx *= s; bird.vy *= s; bird.vz *= s;
        }

        bird.x += bird.vx;
        bird.y += bird.vy;
        bird.z += bird.vz;

        // XY wrap for birds that escape far off-screen
        if (bird.x < -60)        bird.x = width  + 50;
        if (bird.x > width  + 60) bird.x = -50;
        if (bird.y < -60)        bird.y = height * 0.3;
        if (bird.y > height + 20) bird.y = height * 0.3;
        // Hard Z clamp as a safety net (boundary forces handle the rest)
        if (bird.z < -DEPTH_HALF * 1.2) bird.z = -DEPTH_HALF;
        if (bird.z >  DEPTH_HALF * 1.2) bird.z =  DEPTH_HALF;
    }
}

// ============================================================
// Bird rendering — perspective projection + depth sort
// ============================================================
function drawBirds() {
    // Far-to-near sort so closer birds paint over distant ones
    birds.sort((a, b) => b.z - a.z);

    // Compute per-bird perspective scale and bucket into alpha bands
    // based on combined intrinsic alpha × depth haze
    const bands = [[], [], [], []];
    for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        const w = FOCAL / (FOCAL + b.z);   // >1 = closer, <1 = further
        b._w = w;
        // Atmospheric haze: far birds fade out
        const zNorm     = (b.z + DEPTH_HALF) / (DEPTH_HALF * 2); // 0=near, 1=far
        const depthAlpha = 1 - 0.55 * zNorm;
        const eff = b.alpha * depthAlpha;
        bands[Math.min(3, (eff * 4.5) | 0)].push(b);
    }

    // Warm cream — birds catch the last light of the golden hour
    ctx.fillStyle = '#ddd0a8';
    const alphas = [0.20, 0.42, 0.68, 0.92];

    for (let band = 0; band < 4; band++) {
        const bArr = bands[band];
        if (bArr.length === 0) continue;
        ctx.globalAlpha = alphas[band];
        ctx.beginPath();

        for (let i = 0; i < bArr.length; i++) {
            const bird = bArr[i];
            const w  = bird._w;
            // Perspective project around screen centre
            const sx = width  * 0.5 + (bird.x - width  * 0.5) * w;
            const sy = height * 0.5 + (bird.y - height * 0.5) * w;
            // Wing shape oriented by XY velocity; scale with depth
            const angle = Math.atan2(bird.vy, bird.vx);
            const cos = Math.cos(angle), sin = Math.sin(angle);
            const s = bird.size * w;

            ctx.moveTo(sx + cos * s * 2,                     sy + sin * s * 2);
            ctx.lineTo(sx - cos * s     + sin * s * 0.7,     sy - sin * s     - cos * s * 0.7);
            ctx.lineTo(sx - cos * s * 0.2,                   sy - sin * s * 0.2);
            ctx.lineTo(sx - cos * s     - sin * s * 0.7,     sy - sin * s     + cos * s * 0.7);
        }

        ctx.fill();
    }

    ctx.globalAlpha = 1;
}

// ============================================================
// Resize
// ============================================================
function resize() {
    dpr    = Math.min(window.devicePixelRatio || 1, 2);
    width  = window.innerWidth;
    height = window.innerHeight;
    canvas.width  = width  * dpr;
    canvas.height = height * dpr;
    canvas.style.width  = width  + 'px';
    canvas.style.height = height + 'px';
    numBirds = Math.max(150, Math.min(500, Math.floor((width * height) / 3500)));
}

// ============================================================
// Main loop
// ============================================================
function animate(timestamp) {
    const time = timestamp - startTime;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSky();
    updateBirds(time);
    drawBirds();
    requestAnimationFrame(animate);
}

// ============================================================
// Events
// ============================================================
window.addEventListener('resize', resize);

window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX; mouseY = e.clientY; mouseActive = true;
});
window.addEventListener('mouseleave', () => { mouseActive = false; });

window.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    mouseX = t.clientX; mouseY = t.clientY; mouseActive = true;
}, { passive: true });
window.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    mouseX = t.clientX; mouseY = t.clientY; mouseActive = true;
}, { passive: true });
window.addEventListener('touchend', () => { mouseActive = false; });

// ============================================================
// Init
// ============================================================
resize();
createBirds();
requestAnimationFrame(animate);
