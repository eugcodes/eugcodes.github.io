import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// ════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════

const MAX_BIRDS = 15000;

const state = {
    boids: {
        count: 5000,
        speed: 0.6,
        cohesion: 0.9,
        alignment: 3.5,
        separation: 1.2,
        perceptionRadius: 6.5,
    },
    environment: {
        sunElevation: 2,
        sunAzimuth: 180,
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
        { key: 'perceptionRadius', label: 'Perception Radius', min: 1, max: 15, step: 0.5, desc: 'How far each bird can see. Real starlings interact with their nearest 6\u20137 neighbours regardless of distance.' },
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

// Mouse interaction
const mouse = { x: 0, y: 0, worldX: 0, worldY: 80, worldZ: 0, active: false };
const raycaster = new THREE.Raycaster();
const mousePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const mouseNDC = new THREE.Vector2();
const mouseWorld = new THREE.Vector3();

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
        preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.5;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(
        55,
        window.innerWidth / window.innerHeight,
        1,
        5000
    );
    camera.position.set(0, 40, 220);
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
            // Next change in 3-10 seconds (irregular timing)
            attr.nextChange = t + 3 + Math.random() * 7;
        }
        // Move toward target at varying rates
        const lerp = 0.015;
        attr.x += (attr.tx - attr.x) * lerp;
        attr.y += (attr.ty - attr.y) * lerp;
        attr.z += (attr.tz - attr.z) * lerp;
    }
}

function simulateBoids(dt) {
    const count = state.boids.count;
    const { speed, cohesion, alignment, separation, perceptionRadius } = state.boids;
    const percRadSq = perceptionRadius * perceptionRadius;
    const sepDist = perceptionRadius * 0.4;
    const sepDistSq = sepDist * sepDist;
    const maxSpeed = speed * 1.8;
    const minSpeed = speed * 0.4;

    // Rebuild spatial grid
    grid.cellSize = perceptionRadius;
    grid.clear();
    for (let i = 0; i < count; i++) {
        grid.insert(i, posX[i], posY[i], posZ[i]);
    }

    // Temp accumulators
    let sepX, sepY, sepZ, sepCount;
    let aliX, aliY, aliZ;
    let cohX, cohY, cohZ;
    let neighborCount;

    for (let i = 0; i < count; i++) {
        const px = posX[i], py = posY[i], pz = posZ[i];
        const candidates = grid.query(px, py, pz);

        sepX = sepY = sepZ = 0;
        sepCount = 0;
        aliX = aliY = aliZ = 0;
        cohX = cohY = cohZ = 0;
        neighborCount = 0;

        for (let c = 0, clen = candidates.length; c < clen; c++) {
            const j = candidates[c];
            if (j === i) continue;

            const dx = posX[j] - px;
            const dy = posY[j] - py;
            const dz = posZ[j] - pz;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq < percRadSq && distSq > 0.001) {
                neighborCount++;
                // Alignment
                aliX += velX[j];
                aliY += velY[j];
                aliZ += velZ[j];
                // Cohesion
                cohX += posX[j];
                cohY += posY[j];
                cohZ += posZ[j];

                // Separation (stronger when closer)
                if (distSq < sepDistSq) {
                    const inv = 1.0 / Math.sqrt(distSq);
                    sepX -= dx * inv;
                    sepY -= dy * inv;
                    sepZ -= dz * inv;
                    sepCount++;
                }
            }
        }

        let ax = 0, ay = 0, az = 0;

        if (neighborCount > 0) {
            const invN = 1.0 / neighborCount;

            // Alignment: steer toward average velocity
            aliX *= invN; aliY *= invN; aliZ *= invN;
            ax += (aliX - velX[i]) * alignment * 0.1;
            ay += (aliY - velY[i]) * alignment * 0.1;
            az += (aliZ - velZ[i]) * alignment * 0.1;

            // Cohesion: steer toward center of mass
            cohX *= invN; cohY *= invN; cohZ *= invN;
            ax += (cohX - px) * cohesion * 0.02;
            ay += (cohY - py) * cohesion * 0.02;
            az += (cohZ - pz) * cohesion * 0.02;
        }

        // Separation
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

        // Mouse interaction
        if (mouse.active) {
            const mdx = px - mouse.worldX;
            const mdy = py - mouse.worldY;
            const mdz = pz - mouse.worldZ;
            const mdist = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz) + 0.1;
            if (mdist < 30) {
                const mstrength = (1 - mdist / 30) * 0.8;
                ax += (mdx / mdist) * mstrength;
                ay += (mdy / mdist) * mstrength;
                az += (mdz / mdist) * mstrength;
            }
        }

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
// Audio System
// ════════════════════════════════════════════════════════════

const audio = {
    ctx: null,
    gain: null,
    enabled: false,

    init() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();

        // Brown noise for wind
        const bufferSize = this.ctx.sampleRate * 4;
        const buffer = this.ctx.createBuffer(2, bufferSize, this.ctx.sampleRate);

        for (let ch = 0; ch < 2; ch++) {
            const data = buffer.getChannelData(ch);
            let last = 0;
            for (let i = 0; i < bufferSize; i++) {
                const white = Math.random() * 2 - 1;
                data[i] = (last + 0.02 * white) / 1.02;
                last = data[i];
                data[i] *= 3.5;
            }
        }

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 250;
        filter.Q.value = 0.3;

        // Subtle modulation
        const lfo = this.ctx.createOscillator();
        const lfoGain = this.ctx.createGain();
        lfo.frequency.value = 0.15;
        lfoGain.gain.value = 80;
        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);
        lfo.start();

        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0;

        source.connect(filter);
        filter.connect(this.gain);
        this.gain.connect(this.ctx.destination);
        source.start();
    },

    toggle() {
        if (!this.ctx) this.init();
        this.enabled = !this.enabled;
        this.gain.gain.linearRampToValueAtTime(
            this.enabled ? 0.25 : 0,
            this.ctx.currentTime + 0.8
        );
        if (this.ctx.state === 'suspended') this.ctx.resume();
    },
};

// ════════════════════════════════════════════════════════════
// Mouse / Touch Interaction
// ════════════════════════════════════════════════════════════

function updateMouseWorld() {
    raycaster.setFromCamera(mouseNDC, camera);
    // Intersect with plane at flock center
    mousePlane.normal.copy(camera.getWorldDirection(new THREE.Vector3()));
    mousePlane.constant = -mousePlane.normal.dot(
        new THREE.Vector3(BOUNDS_CENTER[0], BOUNDS_CENTER[1], BOUNDS_CENTER[2])
    );
    raycaster.ray.intersectPlane(mousePlane, mouseWorld);
    if (mouseWorld) {
        mouse.worldX = mouseWorld.x;
        mouse.worldY = mouseWorld.y;
        mouse.worldZ = mouseWorld.z;
    }
}

function onMouseMove(e) {
    mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
    mouse.active = true;
    updateMouseWorld();
}

function onMouseLeave() {
    mouse.active = false;
}

function onTouchMove(e) {
    if (e.touches.length > 0) {
        const t = e.touches[0];
        mouseNDC.x = (t.clientX / window.innerWidth) * 2 - 1;
        mouseNDC.y = -(t.clientY / window.innerHeight) * 2 + 1;
        mouse.active = true;
        updateMouseWorld();
    }
}

function onTouchEnd() {
    mouse.active = false;
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
    const btnScreenshot = document.getElementById('btn-screenshot');
    const btnAudio = document.getElementById('btn-audio');

    // Settings toggle
    btnSettings.addEventListener('click', () => {
        panel.classList.toggle('open');
        btnSettings.classList.toggle('active');
    });
    btnClose.addEventListener('click', () => {
        panel.classList.remove('open');
        btnSettings.classList.remove('active');
    });

    // Tabs
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
            document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
        });
    });

    // Screenshot
    btnScreenshot.addEventListener('click', () => {
        renderer.render(scene, camera);
        const dataURL = renderer.domElement.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = 'starlings.png';
        link.href = dataURL;
        link.click();
    });

    // Audio
    btnAudio.addEventListener('click', () => {
        audio.toggle();
        btnAudio.querySelector('.audio-off').classList.toggle('hidden', audio.enabled);
        btnAudio.querySelector('.audio-on').classList.toggle('hidden', !audio.enabled);
        btnAudio.classList.toggle('active', audio.enabled);
    });

    // Mouse / Touch
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);

    // Resize
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
    initSky();
    initBirds();
    initializeBoids();
    setupUI();
    animate();
}

init();
