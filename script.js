import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// ════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════

const MAX_BIRDS = 15000;

const state = {
    boids: {
        count: 7500,
        speed: 0.5,
        cohesion: 1.0,
        alignment: 2.1,
        separation: 0.4,
        perceptionRadius: 4.0,
    },
    environment: {
        sunElevation: 2,
        sunAzimuth: 197,
        turbidity: 5.2,
        rayleigh: 2.2,
        mieCoefficient: 0,
        mieDirectionalG: 0,
    },
};

const settingsConfig = {
    boids: [
        { key: 'count', label: 'Bird Count', min: 100, max: 15000, step: 100, desc: 'Number of birds in the flock. Real starling murmurations range from hundreds to over a million.' },
        { key: 'speed', label: 'Flight Speed', min: 0.1, max: 5, step: 0.1, desc: 'Base cruising speed of each bird. Lower values produce calmer, more meditative flocking.' },
        { key: 'cohesion', label: 'Cohesion', min: 0, max: 3, step: 0.1, desc: 'How strongly birds steer toward the centre of nearby neighbours. Higher values create tighter clusters.' },
        { key: 'alignment', label: 'Alignment', min: 0, max: 5, step: 0.1, desc: 'How strongly birds match the direction of their neighbours. This is the dominant force in real starling flocks.' },
        { key: 'separation', label: 'Separation', min: 0, max: 3, step: 0.1, desc: 'How strongly birds avoid crowding nearby neighbours. Prevents collisions and maintains personal space.' },
        { key: 'perceptionRadius', label: 'Perception Radius', min: 1, max: 15, step: 0.5, desc: 'Maximum visual range. Within this range each bird locks on to its 7 nearest neighbours — the topological interaction observed in real starling flocks (Ballerini et al. 2008).' },
    ],
    environment: [
        { key: 'sunElevation', label: 'Sun Elevation', min: 0, max: 90, step: 1, desc: 'Angle of the sun above the horizon in degrees. Low values produce sunset/sunrise colours.' },
        { key: 'sunAzimuth', label: 'Sun Azimuth', min: 0, max: 360, step: 1, desc: 'Compass direction of the sun. 0\u00b0 is north, 90\u00b0 east, 180\u00b0 south, 270\u00b0 west.' },
        { key: 'turbidity', label: 'Sky Turbidity', min: 1, max: 20, step: 0.1, desc: 'Atmospheric haziness. Low values give a clear blue sky; high values simulate dust, humidity, or smog.' },
        { key: 'rayleigh', label: 'Sky Rayleigh', min: 0, max: 4, step: 0.1, desc: 'Rayleigh scattering coefficient. Controls the blue tint of the sky; higher values intensify the blue.' },
    ],
};

// ════════════════════════════════════════════════════════════
// Simulation Data (pre-allocated)
// ════════════════════════════════════════════════════════════

const posX = new Float32Array(MAX_BIRDS);
const posY = new Float32Array(MAX_BIRDS);
const posZ = new Float32Array(MAX_BIRDS);
const velX = new Float32Array(MAX_BIRDS);
const velY = new Float32Array(MAX_BIRDS);
const velZ = new Float32Array(MAX_BIRDS);

// ════════════════════════════════════════════════════════════
// Spatial Grid
// ════════════════════════════════════════════════════════════

class SpatialGrid {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.cells = new Map();
    }

    clear() {
        this.cells.clear();
    }

    _key(cx, cy, cz) {
        return ((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) >>> 0;
    }

    insert(idx, x, y, z) {
        const cs = this.cellSize;
        const k = this._key(
            Math.floor(x / cs),
            Math.floor(y / cs),
            Math.floor(z / cs)
        );
        let cell = this.cells.get(k);
        if (!cell) {
            cell = [];
            this.cells.set(k, cell);
        }
        cell.push(idx);
    }

    query(x, y, z) {
        const cs = this.cellSize;
        const cx = Math.floor(x / cs);
        const cy = Math.floor(y / cs);
        const cz = Math.floor(z / cs);
        const result = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const cell = this.cells.get(this._key(cx + dx, cy + dy, cz + dz));
                    if (cell) {
                        for (let i = 0, len = cell.length; i < len; i++) {
                            result.push(cell[i]);
                        }
                    }
                }
            }
        }
        return result;
    }
}

let grid = new SpatialGrid(state.boids.perceptionRadius);

// ════════════════════════════════════════════════════════════
// Three.js Globals
// ════════════════════════════════════════════════════════════

let renderer, scene, camera, sky, sun;
let birdMesh, birdMaterial;
let clock;
let shaderTimeUniform = { value: 0 };

// Stochastic attractors — random-walk targets that change direction
// unpredictably, producing the irregular directional shifts observed
// in real starling murmurations (Cavagna et al. 2010, 2015).
const attractors = [
    { x: 0, y: 80, z: 0, tx: 0, ty: 80, tz: 0, nextChange: 0 },
    { x: 0, y: 80, z: 0, tx: 0, ty: 80, tz: 0, nextChange: 3 },
    { x: 0, y: 80, z: 0, tx: 0, ty: 80, tz: 0, nextChange: 6 },
];

// ════════════════════════════════════════════════════════════
// Bird Geometry
// ════════════════════════════════════════════════════════════

function createBirdGeometry() {
    const geo = new THREE.BufferGeometry();
    // Simple bird silhouette: V-shape facing -Z
    const v = new Float32Array([
        // Left wing
        0.0, 0.0, -0.5,       // beak
        -1.0, 0.06, 0.15,     // left wingtip
        0.0, 0.0, 0.3,        // tail

        // Right wing
        0.0, 0.0, -0.5,       // beak
        0.0, 0.0, 0.3,        // tail
        1.0, 0.06, 0.15,      // right wingtip
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
    geo.computeVertexNormals();
    return geo;
}

// ════════════════════════════════════════════════════════════
// Initialization
// ════════════════════════════════════════════════════════════

function initRenderer() {
    const canvas = document.getElementById('canvas');
    renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(
        55,
        window.innerWidth / window.innerHeight,
        1,
        5000
    );
    // Position set properly by updateCameraFromState() after init
    camera.position.set(0, 55, 145);
    camera.lookAt(0, 80, 0);

    clock = new THREE.Clock();
}

function initSky() {
    sky = new Sky();
    sky.scale.setScalar(4500);
    scene.add(sky);

    sun = new THREE.Vector3();
    updateSky();
}

function updateSky() {
    const env = state.environment;
    const uniforms = sky.material.uniforms;

    uniforms['turbidity'].value = env.turbidity;
    uniforms['rayleigh'].value = env.rayleigh;
    uniforms['mieCoefficient'].value = env.mieCoefficient;
    uniforms['mieDirectionalG'].value = env.mieDirectionalG;

    const phi = THREE.MathUtils.degToRad(90 - env.sunElevation);
    const theta = THREE.MathUtils.degToRad(env.sunAzimuth);

    sun.setFromSphericalCoords(1, phi, theta);
    uniforms['sunPosition'].value.copy(sun);
}

function initBirds() {
    const geo = createBirdGeometry();

    birdMaterial = new THREE.MeshBasicMaterial({
        color: 0x1a1a20,
        side: THREE.DoubleSide,
    });

    // Add subtle wing flap via vertex shader injection
    birdMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = shaderTimeUniform;
        shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `
            vec3 transformed = vec3(position);
            float iid = float(gl_InstanceID);
            float flapFreq = 6.0 + sin(iid * 1.37) * 2.5;
            float flapPhase = iid * 2.17;
            float flap = sin(uTime * flapFreq + flapPhase) * 0.12;
            if (abs(position.x) > 0.3) {
                transformed.y += flap * abs(position.x);
            }
            `
        );
    };

    birdMesh = new THREE.InstancedMesh(geo, birdMaterial, MAX_BIRDS);
    birdMesh.count = state.boids.count;
    birdMesh.frustumCulled = false;
    scene.add(birdMesh);
}

// ════════════════════════════════════════════════════════════
// Boid Simulation
// ════════════════════════════════════════════════════════════

const BOUNDS_CENTER = [0, 80, 0];
const BOUNDS_RADIUS = 70;
const K_NEIGHBORS = 7; // Topological interaction (Ballerini et al. 2008)
// Pre-allocated scratch arrays for K-nearest search
const _kDist = new Float32Array(K_NEIGHBORS);
const _kIdx = new Int32Array(K_NEIGHBORS);

function initializeBoids(startIdx = 0) {
    const count = state.boids.count;
    for (let i = startIdx; i < count; i++) {
        // Scatter birds in a sphere
        const r = BOUNDS_RADIUS * 0.6 * Math.cbrt(Math.random());
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);

        posX[i] = BOUNDS_CENTER[0] + r * Math.sin(phi) * Math.cos(theta);
        posY[i] = BOUNDS_CENTER[1] + r * Math.sin(phi) * Math.sin(theta);
        posZ[i] = BOUNDS_CENTER[2] + r * Math.cos(phi);

        // Random initial velocity
        const speed = state.boids.speed * (0.5 + Math.random() * 0.5);
        const vt = Math.random() * Math.PI * 2;
        const vp = Math.acos(2 * Math.random() - 1);
        velX[i] = speed * Math.sin(vp) * Math.cos(vt);
        velY[i] = speed * Math.sin(vp) * Math.sin(vt);
        velZ[i] = speed * Math.cos(vp);
    }
}

function updateAttractors(t) {
    const r = BOUNDS_RADIUS * 0.5;
    for (const attr of attractors) {
        if (t > attr.nextChange) {
            // Pick a new random target within bounds
            attr.tx = BOUNDS_CENTER[0] + (Math.random() - 0.5) * 2 * r;
            attr.ty = BOUNDS_CENTER[1] + (Math.random() - 0.5) * r;
            attr.tz = BOUNDS_CENTER[2] + (Math.random() - 0.5) * 2 * r;
            // Next change in 2-6 seconds (irregular timing)
            attr.nextChange = t + 2 + Math.random() * 4;
        }
        // Move toward target
        const lerp = 0.025;
        attr.x += (attr.tx - attr.x) * lerp;
        attr.y += (attr.ty - attr.y) * lerp;
        attr.z += (attr.tz - attr.z) * lerp;
    }
}

function simulateBoids(dt) {
    const count = state.boids.count;
    const { speed, cohesion, alignment, separation, perceptionRadius } = state.boids;
    const percRadSq = perceptionRadius * perceptionRadius;
    const sepDist = perceptionRadius * 0.35;
    const sepDistSq = sepDist * sepDist;
    const maxSpeed = speed * 1.8;
    const minSpeed = speed * 0.4;

    // Rebuild spatial grid
    grid.cellSize = perceptionRadius;
    grid.clear();
    for (let i = 0; i < count; i++) {
        grid.insert(i, posX[i], posY[i], posZ[i]);
    }

    for (let i = 0; i < count; i++) {
        const px = posX[i], py = posY[i], pz = posZ[i];
        const candidates = grid.query(px, py, pz);

        // ── Topological neighbour selection ──────────────────────
        // Instead of interacting with every bird within a fixed
        // radius (metric model), each bird locks on to its K nearest
        // neighbours. This reproduces the scale-free correlations
        // observed in real starling flocks (Ballerini et al. 2008).
        let kCount = 0;
        for (let c = 0, clen = candidates.length; c < clen; c++) {
            const j = candidates[c];
            if (j === i) continue;

            const dx = posX[j] - px;
            const dy = posY[j] - py;
            const dz = posZ[j] - pz;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq > percRadSq || distSq < 0.001) continue;

            if (kCount < K_NEIGHBORS) {
                _kDist[kCount] = distSq;
                _kIdx[kCount] = j;
                kCount++;
            } else {
                let maxK = 0;
                for (let k = 1; k < K_NEIGHBORS; k++) {
                    if (_kDist[k] > _kDist[maxK]) maxK = k;
                }
                if (distSq < _kDist[maxK]) {
                    _kDist[maxK] = distSq;
                    _kIdx[maxK] = j;
                }
            }
        }

        // ── Compute flocking forces from K nearest ──────────────
        let sepX = 0, sepY = 0, sepZ = 0, sepCount = 0;
        let aliX = 0, aliY = 0, aliZ = 0;
        let cohX = 0, cohY = 0, cohZ = 0;

        for (let k = 0; k < kCount; k++) {
            const j = _kIdx[k];
            const dSq = _kDist[k];

            aliX += velX[j];
            aliY += velY[j];
            aliZ += velZ[j];

            cohX += posX[j];
            cohY += posY[j];
            cohZ += posZ[j];

            if (dSq < sepDistSq) {
                const dx = posX[j] - px;
                const dy = posY[j] - py;
                const dz = posZ[j] - pz;
                const inv = 1.0 / Math.sqrt(dSq);
                sepX -= dx * inv;
                sepY -= dy * inv;
                sepZ -= dz * inv;
                sepCount++;
            }
        }

        let ax = 0, ay = 0, az = 0;

        if (kCount > 0) {
            const invN = 1.0 / kCount;

            aliX *= invN; aliY *= invN; aliZ *= invN;
            ax += (aliX - velX[i]) * alignment * 0.1;
            ay += (aliY - velY[i]) * alignment * 0.1;
            az += (aliZ - velZ[i]) * alignment * 0.1;

            cohX *= invN; cohY *= invN; cohZ *= invN;
            ax += (cohX - px) * cohesion * 0.02;
            ay += (cohY - py) * cohesion * 0.02;
            az += (cohZ - pz) * cohesion * 0.02;
        }

        if (sepCount > 0) {
            ax += sepX * separation * 0.8;
            ay += sepY * separation * 0.8;
            az += sepZ * separation * 0.8;
        }

        // Attractor forces (gentle pull toward wandering points)
        for (let a = 0; a < attractors.length; a++) {
            const attr = attractors[a];
            const adx = attr.x - px;
            const ady = attr.y - py;
            const adz = attr.z - pz;
            const adist = Math.sqrt(adx * adx + ady * ady + adz * adz) + 0.01;
            const astrength = 0.015;
            ax += (adx / adist) * astrength;
            ay += (ady / adist) * astrength;
            az += (adz / adist) * astrength;
        }

        // Soft boundary
        const bcx = px - BOUNDS_CENTER[0];
        const bcy = py - BOUNDS_CENTER[1];
        const bcz = pz - BOUNDS_CENTER[2];
        const bdist = Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz);
        if (bdist > BOUNDS_RADIUS * 0.7) {
            const strength = Math.pow((bdist - BOUNDS_RADIUS * 0.7) / (BOUNDS_RADIUS * 0.3), 2) * 0.5;
            ax -= (bcx / bdist) * strength;
            ay -= (bcy / bdist) * strength;
            az -= (bcz / bdist) * strength;
        }

        // Angular momentum damping — prevents stable circular orbits
        // by damping the tangential velocity component relative to the
        // flock centre in all three dimensions.
        const rx = px - BOUNDS_CENTER[0];
        const ry = py - BOUNDS_CENTER[1];
        const rz = pz - BOUNDS_CENTER[2];
        const rDist = Math.sqrt(rx * rx + ry * ry + rz * rz) + 0.01;
        const rInv = 1.0 / rDist;
        const vDotR = (velX[i] * rx + velY[i] * ry + velZ[i] * rz) * rInv;
        const dampStr = 0.012;
        ax -= (velX[i] - vDotR * rx * rInv) * dampStr;
        ay -= (velY[i] - vDotR * ry * rInv) * dampStr;
        az -= (velZ[i] - vDotR * rz * rInv) * dampStr;

        // Small noise for organic feel
        ax += (Math.random() - 0.5) * 0.02;
        ay += (Math.random() - 0.5) * 0.02;
        az += (Math.random() - 0.5) * 0.02;

        // Apply acceleration
        velX[i] += ax * dt * 60;
        velY[i] += ay * dt * 60;
        velZ[i] += az * dt * 60;

        // Clamp speed
        const spd = Math.sqrt(velX[i] * velX[i] + velY[i] * velY[i] + velZ[i] * velZ[i]);
        if (spd > maxSpeed) {
            const scale = maxSpeed / spd;
            velX[i] *= scale;
            velY[i] *= scale;
            velZ[i] *= scale;
        } else if (spd < minSpeed && spd > 0.001) {
            const scale = minSpeed / spd;
            velX[i] *= scale;
            velY[i] *= scale;
            velZ[i] *= scale;
        }

        // Update position
        posX[i] += velX[i] * dt * 60;
        posY[i] += velY[i] * dt * 60;
        posZ[i] += velZ[i] * dt * 60;
    }
}

// ════════════════════════════════════════════════════════════
// Update Bird Mesh
// ════════════════════════════════════════════════════════════

const _dummy = new THREE.Object3D();
const BIRD_SCALE = 0.35;

function updateBirdMesh() {
    const count = state.boids.count;
    for (let i = 0; i < count; i++) {
        _dummy.position.set(posX[i], posY[i], posZ[i]);
        _dummy.lookAt(
            posX[i] + velX[i],
            posY[i] + velY[i],
            posZ[i] + velZ[i]
        );
        _dummy.scale.setScalar(BIRD_SCALE);
        _dummy.updateMatrix();
        birdMesh.setMatrixAt(i, _dummy.matrix);
    }
    birdMesh.instanceMatrix.needsUpdate = true;
}

// ════════════════════════════════════════════════════════════
// Camera Controls (zoom, pan)
// ════════════════════════════════════════════════════════════

const cameraState = {
    isDragging: false,
    lastX: 0,
    lastY: 0,
    // Spherical coordinates relative to lookAt target
    theta: 0,     // horizontal angle
    phi: Math.PI / 2 + 0.17, // slightly below flock, looking up (as in real life)
    radius: 150,
    targetX: BOUNDS_CENTER[0],
    targetY: BOUNDS_CENTER[1],
    targetZ: BOUNDS_CENTER[2],
};

function updateCameraFromState() {
    const s = cameraState;
    camera.position.x = s.targetX + s.radius * Math.sin(s.phi) * Math.sin(s.theta);
    camera.position.y = s.targetY + s.radius * Math.cos(s.phi);
    camera.position.z = s.targetZ + s.radius * Math.sin(s.phi) * Math.cos(s.theta);
    camera.lookAt(s.targetX, s.targetY, s.targetZ);
}

function setupCameraControls() {
    const canvas = renderer.domElement;

    // Mouse drag to orbit
    canvas.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.settings-panel, .settings-btn')) return;
        cameraState.isDragging = true;
        cameraState.lastX = e.clientX;
        cameraState.lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!cameraState.isDragging) return;
        const dx = e.clientX - cameraState.lastX;
        const dy = e.clientY - cameraState.lastY;
        cameraState.lastX = e.clientX;
        cameraState.lastY = e.clientY;

        cameraState.theta += dx * 0.004;
        cameraState.phi = Math.max(0.2, Math.min(Math.PI - 0.2, cameraState.phi + dy * 0.004));
        updateCameraFromState();
    });

    canvas.addEventListener('pointerup', (e) => {
        cameraState.isDragging = false;
        canvas.releasePointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointercancel', (e) => {
        cameraState.isDragging = false;
    });

    // Scroll wheel / trackpad pinch to zoom
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        // macOS trackpad pinch fires wheel events with ctrlKey === true;
        // deltaY values are much smaller, so we use a higher multiplier.
        const scale = e.ctrlKey ? 3.0 : 0.15;
        cameraState.radius = Math.max(40, Math.min(400, cameraState.radius + e.deltaY * scale));
        updateCameraFromState();
    }, { passive: false });

    // Pinch to zoom (touch)
    let lastPinchDist = 0;
    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            lastPinchDist = Math.sqrt(dx * dx + dy * dy);
        }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const delta = lastPinchDist - dist;
            cameraState.radius = Math.max(40, Math.min(400, cameraState.radius + delta * 0.5));
            lastPinchDist = dist;
            updateCameraFromState();
        }
    }, { passive: true });
}

// ════════════════════════════════════════════════════════════
// UI Setup
// ════════════════════════════════════════════════════════════

function buildSettingsUI() {
    for (const [category, settings] of Object.entries(settingsConfig)) {
        const container = document.getElementById(`tab-${category}`);
        for (const s of settings) {
            const val = state[category][s.key];
            const div = document.createElement('div');
            div.className = 'setting';
            div.innerHTML = `
                <div class="setting-header">
                    <span class="setting-label">${s.label}</span>
                    <span class="setting-value" id="val-${category}-${s.key}">${formatValue(val, s)}</span>
                </div>
                ${s.desc ? `<p class="setting-desc">${s.desc}</p>` : ''}
                <input type="range"
                    id="slider-${category}-${s.key}"
                    min="${s.min}" max="${s.max}" step="${s.step}"
                    value="${val}">
            `;
            container.appendChild(div);

            const slider = div.querySelector('input');
            const display = div.querySelector('.setting-value');
            slider.addEventListener('input', () => {
                const v = parseFloat(slider.value);
                state[category][s.key] = v;
                display.textContent = formatValue(v, s);
                onSettingChange(category, s.key, v);
            });
        }
    }
}

function formatValue(v, s) {
    if (s.step >= 1) return Math.round(v).toString();
    if (s.step >= 0.1) return v.toFixed(1);
    if (s.step >= 0.01) return v.toFixed(2);
    return v.toFixed(3);
}

function onSettingChange(category, key, value) {
    if (category === 'environment') {
        updateSky();
    }
    if (category === 'boids' && key === 'count') {
        const oldCount = birdMesh.count;
        const newCount = Math.min(value, MAX_BIRDS);
        if (newCount > oldCount) {
            initializeBoids(oldCount);
        }
        birdMesh.count = newCount;
        state.boids.count = newCount;
    }
    if (category === 'boids' && key === 'perceptionRadius') {
        grid = new SpatialGrid(value);
    }
}

function setupUI() {
    buildSettingsUI();

    const panel = document.getElementById('settings-panel');
    const btnSettings = document.getElementById('btn-settings');
    const btnClose = document.getElementById('btn-close-settings');

    btnSettings.addEventListener('click', () => {
        panel.classList.toggle('open');
        btnSettings.classList.toggle('active');
    });
    btnClose.addEventListener('click', () => {
        panel.classList.remove('open');
        btnSettings.classList.remove('active');
    });

    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
            document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
        });
    });

    window.addEventListener('resize', onResize);
}

function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}

// ════════════════════════════════════════════════════════════
// Animation Loop
// ════════════════════════════════════════════════════════════

function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.05); // Cap delta
    const elapsed = clock.elapsedTime;

    shaderTimeUniform.value = elapsed;

    updateAttractors(elapsed);
    simulateBoids(dt);
    updateBirdMesh();

    renderer.render(scene, camera);
}

// ════════════════════════════════════════════════════════════
// Start
// ════════════════════════════════════════════════════════════

function init() {
    initRenderer();

    // On phones in portrait mode the default sun azimuth (197°) falls
    // near the left edge of the narrow horizontal FOV.  Reposition the
    // sun so it appears 1/5 of the viewport width from the left.
    if (window.innerWidth < window.innerHeight && window.innerWidth <= 768) {
        const aspect = window.innerWidth / window.innerHeight;
        const halfVFov = THREE.MathUtils.degToRad(55 / 2);
        const halfHFov = Math.atan(Math.tan(halfVFov) * aspect);
        // 1/5 from left in NDC is x = -0.6 (left = -1, right = 1)
        const angle = Math.atan(0.6 * Math.tan(halfHFov));
        state.environment.sunAzimuth = 180 + THREE.MathUtils.radToDeg(angle);
    }

    initSky();
    initBirds();
    initializeBoids();
    setupCameraControls();
    updateCameraFromState();
    setupUI();
    animate();
}

init();
