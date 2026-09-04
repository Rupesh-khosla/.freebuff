/* ============ HALYCON ORBIT — 3D experience ============
   Three.js + GSAP ScrollTrigger. One fixed WebGL canvas behind the whole page:
   the speaker idles, orbits, and "breathes" as you scroll the story. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (REDUCED) document.documentElement.classList.add('reduced');
const gsapWin = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
if (ScrollTrigger) gsapWin.registerPlugin(ScrollTrigger);

/* ---------- Loader (fake calibration while first frame boots) ---------- */
const loader = document.getElementById('loader');
const loaderFill = document.getElementById('loaderFill');
const loaderStatus = document.getElementById('loaderStatus');
function finishLoader() {
  if (!loader || loader.classList.contains('done')) return;
  gsapWin.to(loaderFill, { width: '100%', duration: 0.25, ease: 'power1.out', onComplete: () => {
    loaderStatus.textContent = 'soundspace ready';
    loader.classList.add('done');
    if (typeof heroPlay === 'function') heroPlay();
    setTimeout(() => loader.remove(), 900);
  }});
}
const statuses = ['calibrating soundspace', 'mapping the room', 'voicing drivers'];
let si = 0;
const statusTimer = setInterval(() => {
  if (si < statuses.length && loaderStatus) loaderStatus.textContent = statuses[si++];
  else clearInterval(statusTimer);
}, 420);

/* ---------- Canvas + renderer ---------- */
const canvas = document.getElementById('bg3d');
let renderer, scene, camera, composer, bloomPass, vignettePass, group, stars, clouds, dust, meteors, milky, clock;
// NOTE: never probe canvas.getContext() before creating the renderer — the first
// getContext call fixes the context attributes for the canvas, so a bare default
// probe here would permanently disable preserveDrawingBuffer (and everything else
// requested later). WebGL absence is caught by boot()'s try/catch instead.
function initScene() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070708);   // darker void = subject pops
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  camera.position.set(0, 0.25, 7.4);
  clock = new THREE.Clock();

  buildScene();            // lights, speaker, glow, particles
  layoutForViewport();     // size renderer + position speaker per screen size
  buildPost();             // bloom composer (targets sized to the real viewport)
  window.addEventListener('resize', onResize);
  animate();
  return true;
}

/* ---------- Procedural "Orbit" planet — a rotating 4K Earth ---------- */
function buildScene() {
  // No scene lights: the planet and clouds shade themselves against a single
  // fixed sun direction in the fragment shader, giving a real day/night
  // terminator that stays fixed in space while the planet spins beneath it.
  const sunDir = new THREE.Vector3(-3.0, 2.5, 0.4).normalize();

  // Depth cue: distant dust melts into the void
  scene.fog = new THREE.Fog(0x070708, 9.5, 14);

  group = new THREE.Group();
  group.rotation.z = 0.41;   // real axial tilt — 23.4°, like Earth itself
  scene.add(group);

  // 4K earth (turban/webgl-earth) + a 4K night-lights layer (three-globe):
  // day map, ocean mask, cloud shell, city lights.
  const texLoader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const earthMap = texLoader.load('https://raw.githubusercontent.com/turban/webgl-earth/master/images/2_no_clouds_4k.jpg');
  const waterMap = texLoader.load('https://raw.githubusercontent.com/turban/webgl-earth/master/images/water_4k.png');
  const cloudsMap = texLoader.load('https://raw.githubusercontent.com/turban/webgl-earth/master/images/fair_clouds_4k.png');
  const nightMap = texLoader.load('https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg');
  [earthMap, cloudsMap, nightMap].forEach((t) => { t.colorSpace = THREE.SRGBColorSpace; });
  [earthMap, waterMap, cloudsMap, nightMap].forEach((t) => { t.anisotropy = aniso; });

  // Day/night terminator shader — one fixed sun, a soft twilight band:
  //  - day side: 4K day map sun-lit, with moonlit ocean glints
  //  - night side: deep-navy base + glowing 4K city lights
  //  - the two cross through a wide warm twilight band, never a hard cut
  const terminatorVS = [
    'varying vec2 vUv;',
    'varying vec3 vN;',
    'varying vec3 vWp;',
    'void main(){',
    '  vUv = uv;',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vWp = wp.xyz;',
    '  vN = normalize(mat3(modelMatrix) * normal);',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');
  const dayNightFS = [
    'uniform sampler2D dayMap;',
    'uniform sampler2D nightMap;',
    'uniform sampler2D waterMap;',
    'uniform vec3 sunDir;',
    'varying vec2 vUv;',
    'varying vec3 vN;',
    'varying vec3 vWp;',
    'void main(){',
    '  vec3 n = normalize(vN);',
    '  vec3 s = normalize(sunDir);',
    '  float ndl = dot(n, s);',
    '  // Soft day-night terminator — a wide twilight band, not a hard cut',
    '  float day = smoothstep(-0.14, 0.34, ndl);',
    '  vec3 dayTex = pow(texture2D(dayMap, vUv).rgb, vec3(2.2));',
    '  vec3 nightTex = pow(texture2D(nightMap, vUv).rgb, vec3(2.2));',
    '  vec3 water = texture2D(waterMap, vUv).rgb;',
    '  // Sun-lit continents on the day side',
    '  vec3 dayCol = dayTex * (0.32 + 0.95 * max(ndl, 0.0));',
    '  // Deep-navy night base + glowing city lights',
    '  vec3 nightCol = nightTex * 1.55 + dayTex * 0.055;',
    '  vec3 col = mix(nightCol, dayCol, day);',
    '  // Warm atmospheric scatter ringing the terminator',
    '  float tw = exp(-pow(ndl / 0.16, 2.0));',
    '  col += vec3(1.0, 0.5, 0.22) * 0.5 * tw;',
    '  // Moonlit glint on oceans (lit hemisphere only)',
    '  vec3 v = normalize(cameraPosition - vWp);',
    '  vec3 h = normalize(s + v);',
    '  float spec = pow(max(dot(n, h), 0.0), 48.0) * water.r * day;',
    '  col += vec3(0.55, 0.72, 1.0) * spec * 0.4;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 128, 64),
    new THREE.ShaderMaterial({
      uniforms: { dayMap: { value: earthMap }, nightMap: { value: nightMap }, waterMap: { value: waterMap }, sunDir: { value: sunDir } },
      vertexShader: terminatorVS,
      fragmentShader: dayNightFS
    })
  );
  group.add(earth);

  // Clouds — shaded by the same sun: bright where it hits, faint silhouettes
  // over the night side so the city lights stay clear.
  const cloudFS = [
    'uniform sampler2D cloudMap;',
    'uniform vec3 sunDir;',
    'uniform float opacity;',
    'varying vec2 vUv;',
    'varying vec3 vN;',
    'void main(){',
    '  vec3 n = normalize(vN);',
    '  float ndl = dot(n, normalize(sunDir));',
    '  float day = smoothstep(-0.14, 0.34, ndl);',
    '  vec3 c = pow(texture2D(cloudMap, vUv).rgb, vec3(2.2));',
    '  vec3 col = c * (0.10 + 1.05 * max(ndl, 0.0));',
    '  float tw = exp(-pow(ndl / 0.16, 2.0));',
    '  col += vec3(1.0, 0.55, 0.3) * tw * 0.25;',
    '  gl_FragColor = vec4(col, opacity * (0.10 + 0.90 * day));',
    '}'
  ].join('\n');
  clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.012, 96, 48),
    new THREE.ShaderMaterial({
      uniforms: { cloudMap: { value: cloudsMap }, sunDir: { value: sunDir }, opacity: { value: 0.45 } },
      vertexShader: terminatorVS,
      fragmentShader: cloudFS,
      transparent: true, depthWrite: false
    })
  );
  group.add(clouds);

  // Atmosphere — fresnel glow shell (additive, back-side) so the planet shows
  // that thin rim of light a real atmosphere has against space.
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.06, 64, 32),
    new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vNormal; void main(){ vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying vec3 vNormal; void main(){ float intensity = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.4); gl_FragColor = vec4(0.32, 0.55, 0.95, 1.0) * intensity; }',
      blending: THREE.AdditiveBlending, side: THREE.BackSide, transparent: true, depthWrite: false
    })
  );
  group.add(atmosphere);

  // Atmosphere: slow dust motes drifting through the light
  dust = dustField();
  scene.add(dust);

  // Starfield — a deep-sky dome around the scene: 770 points in three size
  // classes (dim dust-dots, mid stars, a few bright ones), so the void reads
  // as space instead of empty black.
  stars = starField();
  scene.add(stars);
  // Shooting stars — slow streaks crossing the upper sky, layered over the field
  meteors = meteorField();
  scene.add(meteors);
  // Milky Way — a faint diagonal galactic band behind everything: a procedural
  // haze shell with noise-variegated lanes, dim enough to never fight the planet
  milky = milkyWay();
  scene.add(milky);
}

/* ---------- Starfield: 770 points in three brightness classes ---------- */
function starField() {
  const classes = [
    // Bright stars sit on the near shell, dim dust on the far shell — so depth
    // parallax has real geometry to work with instead of one interleaved band.
    { n: 1200, rmin: 37, rmax: 45, size: 0.22, opacity: 0.55, color: 0xffffff },   // far, dim
    { n: 500,  rmin: 28, rmax: 36, size: 0.4,  opacity: 0.8,  color: 0xffe6c8 },   // mid
    { n: 200,  rmin: 20, rmax: 27, size: 0.8,  opacity: 1.0,  color: 0xdceaff }    // near, bright
  ];
  const stars = new THREE.Group();
  classes.forEach((cl) => {
    const pos = new Float32Array(cl.n * 3);
    for (let i = 0; i < cl.n; i++) {
      const u = Math.random() * 2 - 1;         // uniform on a sphere shell
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      const r = cl.rmin + Math.random() * (cl.rmax - cl.rmin);
      pos[i * 3] = s * Math.cos(th) * r;
      pos[i * 3 + 1] = u * r;
      pos[i * 3 + 2] = s * Math.sin(th) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      map: dotTexture(), size: cl.size, transparent: true, opacity: cl.opacity,
      depthWrite: false, blending: THREE.AdditiveBlending, color: cl.color, fog: false
    });
    stars.add(new THREE.Points(g, m));
  });
  return stars;
}
// Mouse-parallax gain per class — index matches the children order above (dim, mid,
// bright). Far/dim stars barely stir, mid is the reference, near/bright lead the cursor.
const PARALLAX_GAIN = [0.35, 1.0, 1.75];
// The Milky Way band is the faintest deep-field layer — it leans with the mouse at
// a slow mid-background pace so the whole sky tilts together without racing the stars.
const MILKY_GAIN = 0.65;

/* ---------- Milky Way: a faint diagonal band of haze across the sky ---------- */
const MILKY_N = new THREE.Vector3(Math.sin(0.58), Math.cos(0.58), 0).normalize();   // tilts the band across the view
function milkyWay() {
  // Haze: one BackSide shell whose glow is brightest near the band plane, then
  // variegated by fbm lanes/knots so it reads as galactic dust, not fog.
  const hazeVS = [
    'varying vec3 vN;',
    'void main(){',
    '  vN = normalize(mat3(modelMatrix) * normal);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');
  const hazeFS = [
    'uniform vec3 bandN;',
    'uniform float strength;',
    'varying vec3 vN;',
    'float hash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.11, 0.23, 0.37)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
    'float noise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(hash(i + vec3(0.0,0.0,0.0)), hash(i + vec3(1.0,0.0,0.0)), f.x),',
    '                 mix(hash(i + vec3(0.0,1.0,0.0)), hash(i + vec3(1.0,1.0,0.0)), f.x), f.y),',
    '             mix(mix(hash(i + vec3(0.0,0.0,1.0)), hash(i + vec3(1.0,0.0,1.0)), f.x),',
    '                 mix(hash(i + vec3(0.0,1.0,1.0)), hash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z); }',
    'float fbm(vec3 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }',
    'void main(){',
    '  vec3 n = normalize(vN);',
    '  float d = dot(n, normalize(bandN));',
    '  float band = exp(-(d * d) / (0.12 * 0.12));',
    '  // variegation: broad patchiness, darker dust lanes, and tiny bright knots',
    '  float w1 = fbm(n * 2.1);',
    '  float w2 = fbm(n * 7.0 + 3.1);',
    '  float lanes = 0.5 + 0.95 * w1 - 0.55 * smoothstep(0.52, 0.88, w2);',
    '  float knots = smoothstep(0.58, 0.92, fbm(n * 22.0 + 7.7));',
    '  float core = exp(-(d * d) / (0.05 * 0.05));   // warmer tint toward the spine',
    '  vec3 col = mix(vec3(0.58, 0.68, 0.98), vec3(1.0, 0.88, 0.68), clamp(core * 2.2 + 0.06, 0.0, 1.0));',
    '  col *= band * (lanes * 0.85 + knots * 1.1);',
    '  gl_FragColor = vec4(col * strength, 1.0);',
    '}'
  ].join('\n');
  const haze = new THREE.Mesh(
    new THREE.SphereGeometry(30, 96, 48),
    new THREE.ShaderMaterial({
      uniforms: { bandN: { value: MILKY_N }, strength: { value: 0.045 } },
      vertexShader: hazeVS,
      fragmentShader: hazeFS,
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    })
  );
  // Grain: a light sprinkle of tiny resolved points hugging the same band
  const g = new THREE.BufferGeometry();
  const GN = 1500;
  const pos = new Float32Array(GN * 3);
  for (let i = 0; i < GN; i++) {
    let done = false;
    for (let tries = 0; tries < 60 && !done; tries++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      const d = new THREE.Vector3(s * Math.cos(th), u, s * Math.sin(th));
      if (Math.abs(d.dot(MILKY_N)) > 0.085) continue;
      const r = 26 + Math.random() * 14;
      pos[i * 3] = d.x * r; pos[i * 3 + 1] = d.y * r; pos[i * 3 + 2] = d.z * r;
      done = true;
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const grain = new THREE.Points(g, new THREE.PointsMaterial({
    map: dotTexture(), size: 0.16, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending, color: 0xfff1dc, fog: false
  }));
  const grp = new THREE.Group();
  grp.add(haze, grain);
  return grp;
}

/* ---------- Shooting stars: slow streaking meteors across the sky ---------- */
const METEOR_SLOTS = 4;    // concurrent meteors (shared vertex pool)
const METEOR_SEGS = 48;    // trail segments per meteor — dense enough to read as a solid streak
const meteorPool = [];
let meteorTimer = 1.6;     // first meteor shortly after boot
let doubleTimer = 90 + Math.random() * 60;   // first tandem pair after ~1.5–2.5 min
function meteorField() {
  const pos = new Float32Array(METEOR_SLOTS * METEOR_SEGS * 3); // zeros: invisible until lit
  const col = new Float32Array(METEOR_SLOTS * METEOR_SEGS * 3);
  for (let k = 0; k < METEOR_SLOTS; k++) {
    meteorPool.push({ active: false, age: 0, dur: 0, speed: 0, len: 0, head: new THREE.Vector3(), dir: new THREE.Vector3() });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    map: dotTexture(), size: 0.15, vertexColors: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;   // positions animate on the CPU every frame
  return pts;
}

function spawnMeteor() {
  const slot = meteorPool.find((s) => !s.active);
  if (!slot) return null;
  slot.active = true; slot.age = 0;
  slot.dur = 4.2 + Math.random() * 2.4;          // slow, unhurried flight
  slot.speed = 0.9 + Math.random() * 0.5;
  slot.len = 1.5 + Math.random() * 0.7;          // streak length (world units)
  // Start in the upper sky, screen-left of the planet and safely inside frame
  slot.head.set(-9.5 + Math.random() * 8, 2.4 + Math.random() * 3.2, -15.5 + Math.random() * 6);
  // Drift gently rightward and slightly down across the frame
  slot.dir.set(0.92 + Math.random() * 0.5, -(0.16 + Math.random() * 0.28), (Math.random() - 0.5) * 0.5).normalize();
  return slot;
}

/* Tandem pair — a rare event: a parallel second meteor beside the first,
   offset sideways (and slightly behind along the path) so they read as a
   pair racing across the sky together rather than two random singles. */
function spawnMeteorPair() {
  const a = spawnMeteor();
  if (!a) return;
  const b = meteorPool.find((s) => !s.active);
  if (!b) return;                       // no free slot — the pair degrades to a single
  const perp = new THREE.Vector3(-a.dir.y, a.dir.x, 0).normalize();  // screen-lateral
  const py = Math.max(0.35, Math.abs(perp.y));
  let off = 1.0 + Math.random() * 0.8;                     // lateral gap
  off = Math.max(0.55, Math.min(off, (6.1 - a.head.y) / py, (a.head.y - 1.2) / py));
  const sgn = Math.random() < 0.5 ? 1 : -1;
  b.active = true; b.age = 0;
  b.dur = a.dur * (0.9 + Math.random() * 0.2);
  b.speed = a.speed * (0.94 + Math.random() * 0.12);       // nearly matching pace
  b.len = a.len * (0.9 + Math.random() * 0.2);
  b.dir.copy(a.dir);
  b.head.copy(a.head)
    .addScaledVector(perp, off * sgn)                       // ride beside
    .addScaledVector(a.dir, -(0.3 + Math.random() * 0.9));  // slight stagger along path
}

function meteorSmooth(a, b, x) {
  x = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

function updateMeteors(dt) {
  if (!meteors) return;
  if (!REDUCED) {
    meteorTimer -= dt;
    if (meteorTimer <= 0) {
      // One at a time is calmest; occasionally allow a second while one flies
      if (!meteorPool.some((s) => s.active) || Math.random() < 0.3) spawnMeteor();
      meteorTimer = 4.5 + Math.random() * 7;
    }
    doubleTimer -= dt;
    if (doubleTimer <= 0) {
      spawnMeteorPair();
      doubleTimer = 170 + Math.random() * 160;   // rare treat: one pair every ~3–5.5 min
    }
  }
  const pa = meteors.geometry.attributes.position;
  const ca = meteors.geometry.attributes.color;
  const P = pa.array, C = ca.array;
  let alive = false;
  meteorPool.forEach((slot, k) => {
    const o = k * METEOR_SEGS;
    if (!slot.active) return;
    alive = true;
    slot.age += dt;
    const life = slot.age / slot.dur;
    slot.head.addScaledVector(slot.dir, slot.speed * dt);
    if (life >= 1) { slot.active = false; return; }
    const trail = slot.len * Math.min(slot.age / 0.8, 1);   // streak grows in quickly
    const sp = trail / (METEOR_SEGS - 1);
    let env = Math.min(slot.age / 0.5, 1);                  // quick fade-in
    env *= 1 - meteorSmooth(0.62, 1, life);                 // long cinematic fade-out
    for (let i = 0; i < METEOR_SEGS; i++) {
      const j = o + i, back = i * sp;
      P[j * 3]     = slot.head.x - slot.dir.x * back;
      P[j * 3 + 1] = slot.head.y - slot.dir.y * back;
      P[j * 3 + 2] = slot.head.z - slot.dir.z * back;
      const f = 1 - i / (METEOR_SEGS - 1);                 // head → tail taper
      const a = env * (0.22 + 0.78 * Math.pow(f, 1.35));   // hot head, soft floor so the body never drops out
      C[j * 3]     = a * 2.6;                              // warm-white head
      C[j * 3 + 1] = a * 2.2;
      C[j * 3 + 2] = a * 1.7;
    }
  });
  if (alive) { pa.needsUpdate = true; ca.needsUpdate = true; }
}

/* ---------- Procedural texture: soft particle sprite ---------- */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function dustField() {
  const N = 110;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 1.6 + Math.random() * 2.6;
    const a = Math.random() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 3.2;
    pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    map: dotTexture(), size: 0.035, transparent: true, opacity: 0.4,
    depthWrite: false, blending: THREE.AdditiveBlending, color: 0xd9b48f, fog: false
  });
  return new THREE.Points(g, m);
}

/* ---------- Soft radial glow sprite (canvas texture) ---------- */

/* ---------- Bloom post-processing (the "premium glow") ---------- */
function buildPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // Bloom tuned selective: high threshold keeps only the warm emissive/copper
  // highlights glowing instead of washing the whole frame
  // Bloom ~40% of the old punch, and a HIGHER threshold so only the true
  // highlight points (core, specular glints) bloom — midtones stay clean.
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.6, 0.88);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  // Soft vignette — focuses the eye on the product, stops the void from floating
  vignettePass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, intensity: { value: 0.5 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float intensity;
      varying vec2 vUv;
      void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        float d = distance(vUv, vec2(0.5));
        c.rgb *= 1.0 - smoothstep(0.32, 0.98, d) * intensity;
        gl_FragColor = c;
      }`
  });
  composer.addPass(vignettePass);
}

/* ---------- Layout: where the speaker sits ---------- */
function layoutForViewport() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  if (composer) composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const portrait = w < h;
  group.scale.setScalar(portrait ? Math.min(w / 640, 0.9) : 1);
  // Desktop: product right, copy left. Portrait: keep the product right-of-center
  // too, so its glow never sits directly behind the left-aligned headline.
  group.position.x = portrait ? Math.min(1.9, w / 420) : Math.min(2.1, w / 760);
  group.position.y = portrait ? 0.6 : -0.15;
  camera.position.z = portrait ? 8.6 : 7.4;
}
function onResize() { layoutForViewport(); }

/* ---------- Interaction + scroll state ----------
   One smoothed virtual pointer feeds the camera parallax AND the depth-aware
   star shells. Its target (tx/ty) comes from whichever source is newest: mouse
   movement, a finger dragging the sky, device tilt (gyroscope), or — on touch
   screens only — a slow ambient figure-8 when the device is idle, so the depth
   never sits dead on a phone that has no pointer at all. */
const pointer = { x: 0, y: 0, tx: 0, ty: 0, src: 'idle', last: -1e9 };
const TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
function setPointerTarget(cx, cy) {
  pointer.tx = (cx / window.innerWidth) * 2 - 1;
  pointer.ty = (cy / window.innerHeight) * 2 - 1;
}
function markInput(src) { pointer.src = src; pointer.last = performance.now(); }
window.addEventListener('pointermove', (e) => {
  setPointerTarget(e.clientX, e.clientY);
  markInput(e.pointerType === 'touch' ? 'touch' : 'mouse');
}, { passive: true });
// Lifting a finger ends a drag — the idle sway may resume a few seconds later.
['pointerup', 'pointercancel'].forEach((ev) =>
  window.addEventListener(ev, (e) => { if (e.pointerType === 'touch') pointer.last = performance.now(); }, { passive: true })
);

/* Device tilt — the phone/tablet gyroscope becomes the pointer. iOS requires an
   explicit permission grant from a user gesture, so we arm it on the first tap
   or click; everywhere else the listener just starts (a desktop with no sensors
   simply never fires). Tilt is measured relative to how the device was held at
   arm time, so the resting position is always neutral. */
let gyroLive = false;
function enableGyro() {
  if (gyroLive || typeof DeviceOrientationEvent === 'undefined') return;
  let neutral = null;
  const onOrient = (e) => {
    if (e.beta == null || e.gamma == null) return;
    if (neutral === null) neutral = { b: e.beta, g: e.gamma || 0 };
    // ~40–45° of tilt maps to the full pointer range, clamped for safety.
    pointer.tx = Math.max(-1, Math.min(1, ((e.gamma || 0) - neutral.g) / 40));
    pointer.ty = Math.max(-1, Math.min(1, (e.beta - neutral.b) / 45));
    markInput('gyro');
  };
  const start = () => { window.addEventListener('deviceorientation', onOrient); gyroLive = true; };
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then((s) => { if (s === 'granted') start(); })
      .catch(() => {});
  } else {
    start();
  }
}
const armGyro = () => { enableGyro(); window.removeEventListener('touchstart', armGyro); window.removeEventListener('click', armGyro); };
window.addEventListener('touchstart', armGyro, { passive: true });
window.addEventListener('click', armGyro, { passive: true });

function pageProgress() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

/* ---------- Render loop ---------- */
let idleRot = REDUCED ? 0.6 : 0;
let starDrift = 0;      // accumulated starfield drift (never resets — the sky crawls forever)
let driftScale = 0;     // 0 while the boot loader covers the page → eases to 1 once it fades
const PX = 0.04, PY = 0.02;   // mouse parallax: max dome tilt (rad) toward the cursor
const SKY_SURGE = 0.55;       // extra sky-stream rate per unit of scroll speed — momentum while moving
const SKY_BANK = 0.10;        // pitch bank per unit of scroll speed — the drift direction tilts with travel
let scrollVel = 0, lastP = 0; // smoothed scroll velocity (p-units/sec)
let elapsed = 0;
let firstFrame = false;
function animate() {
  requestAnimationFrame(animate);
  if (!group) return;
  const dt = clock.getDelta();
  elapsed += dt; const t = elapsed;
  if (!REDUCED) idleRot += dt * 0.06;   // slow majestic planetary spin

  // Ambient idle sway (touch screens only): a phone has no mouse, so once the
  // last real input has faded the virtual pointer eases through a slow figure-8
  // and the parallax depth keeps breathing. A finger, tilt, or mouse overrides
  // it the moment it acts. Skipped entirely for reduced-motion users.
  if (TOUCH && !REDUCED && pointer.src !== 'mouse' && t - pointer.last * 1e-3 > 3.5) {
    pointer.tx = Math.sin(t * 0.21) * 0.55;
    pointer.ty = Math.cos(t * 0.13) * 0.36;
  }

  pointer.x += (pointer.tx - pointer.x) * 0.05;
  pointer.y += (pointer.ty - pointer.y) * 0.05;

  const p = pageProgress();
  // Scroll velocity (p-units/sec, per-frame clamped so nav-anchor jumps can't
  // spike it) — drives the sky's drift surge and bank below.
  const inst = Math.max(-1.2, Math.min(1.2, (p - lastP) / Math.max(dt, 1e-4)));
  lastP = p;
  scrollVel += (inst - scrollVel) * Math.min(1, dt * 5);   // ~200ms smoothing

  // Scroll choreography: spin the planet, drift the camera
  group.rotation.y = idleRot + p * Math.PI * 2.5;
  group.position.x += (baseX() - group.position.x) * 0.06;
  const sway = Math.sin(p * Math.PI * 2) * 0.28;
  camera.position.x = (pointer.x * 0.35) + sway * (REDUCED ? 0 : 1);
  camera.position.y = 0.25 + Math.sin(p * Math.PI) * 0.55 + pointer.y * 0.2;
  // Cloud layer drifts over the planet at its own pace
  clouds.rotation.y += dt * 0.02;

  // Gentle pulse on the post glow — keeps the scene alive without flaring
  bloomPass.strength = 0.22 + Math.sin(t * 1.1) * 0.04;

  // Dust motes drift through the space
  dust.rotation.y += dt * 0.03;
  dust.position.y = Math.sin(t * 0.25) * 0.12;

  // Starfield — a slow steady drift, a depth-aware mouse parallax (each shell
  // leans toward the cursor at its own rate, so the sky reads as layered), and a
  // scroll counter-spin — the planet wheels 2.5 turns over the page (p·2.5π), so
  // the dome wheels back the other way (p·KS) and scrolling reads as motion
  // through space. All of it is dropped entirely for reduced-motion users.
  if (!REDUCED) {
    // The sky holds still while the boot loader is up, then eases into its crawl
    // as the loader fades and the hero entrance plays — the reveal feels calm
    // instead of dropping onto an already-moving starfield.
    const loaderUp = loader && !loader.classList.contains('done');
    driftScale += ((loaderUp ? 0 : 1) - driftScale) * Math.min(1, dt * 1.2);
    starDrift += dt * 0.0085 * driftScale;
    const KS = 0.9;   // sky counter-wheel over the full page ≈ 11% of the planet's scroll spin
    // Flying-through-space: while the page is actually moving, the sky's crawl
    // surges in the direction of travel and banks into a slight pitch — then
    // relaxes back to its idle horizontal crawl a moment after you stop. Drift +
    // scroll counter-wheel rotate the whole sky as one dome — stars AND the Milky
    // Way band wheel together, so scrolling never shears the galaxy past the
    // points that live inside it.
    const domeY = starDrift + p * KS + scrollVel * SKY_SURGE;
    stars.rotation.y = domeY;
    stars.rotation.x = scrollVel * SKY_BANK;
    milky.rotation.y = domeY;
    // …but the mouse parallax is depth-aware: each shell leans toward the cursor
    // with its own gain, so near/bright stars swing with the mouse while far/dim
    // ones barely stir — the sky reads as layered, not one flat sticker. The band
    // follows too, at its own slow gain, so the whole sky tilts cohesively.
    stars.children.forEach((c, i) => {
      const g = PARALLAX_GAIN[i] ?? 1;
      c.rotation.y = -pointer.x * PX * g;   // yaw follows the cursor
      c.rotation.x = -pointer.y * PY * g;   // pitch follows the cursor
    });
    milky.rotation.y = domeY - pointer.x * PX * MILKY_GAIN;
    milky.rotation.x = -pointer.y * PY * MILKY_GAIN + scrollVel * SKY_BANK;
  }
  [0.55, 0.8, 1.0].forEach((o, i) => {
    stars.children[i].material.opacity = o * (0.85 + 0.15 * Math.sin(t * (1.1 + i * 0.5) + i * 2.1));
  });

  // Shooting stars — slow streaking meteors over the sky
  updateMeteors(dt);

  composer.render();
  if (!firstFrame) { firstFrame = true; setTimeout(() => finishLoader(), REDUCED ? 0 : 1050); }
}
function baseX() { return window.innerWidth < window.innerHeight ? Math.min(1.9, window.innerWidth / 420) : Math.min(2.1, window.innerWidth / 760); }

/* ============ DOM choreography: intro, story, reveals, counters ============ */
const hasGSAP = !!(window.gsap && window.ScrollTrigger);
if (hasGSAP) document.documentElement.classList.add('gsap-on');
let heroPlay = null;
setTimeout(() => { if (loader && !loader.classList.contains('done')) finishLoader(); }, 6000); // safety net

/* Equalizer bars (decorative, generated) */
function eqBars(staticMode) {
  const wrap = document.getElementById('eq');
  if (!wrap) return;
  const bars = [];
  for (let i = 0; i < 26; i++) {
    const b = document.createElement('span');
    wrap.appendChild(b); bars.push(b);
  }
  if (staticMode || !gsapWin) {
    bars.forEach((b) => { b.style.height = (14 + Math.random() * 62) + '%'; });
    return;
  }
  const tick = () => {
    bars.forEach((b) => gsapWin.to(b, {
      height: (16 + Math.random() * 58) + '%',
      duration: 0.22 + Math.random() * 0.3,
      ease: 'sine.inOut', overwrite: 'auto'
    }));
  };
  gsapWin.ticker.add(() => { if (Math.random() < 0.2) tick(); });
  tick();
}

/* Hero entrance — plays the moment the loader fades */
function heroIntro() {
  if (!gsapWin) return;
  const items = gsapWin.utils.toArray('.hero-copy > *, .scroll-cue');
  const tl = gsapWin.timeline({ paused: true });
  tl.fromTo(items, { y: 48, autoAlpha: 0 }, {
    y: 0, autoAlpha: 1, duration: 1.1, ease: 'power3.out', stagger: 0.09
  }, 0);
  heroPlay = () => tl.play();
}

/* Story statements — fade in as they arrive, fade out as they leave, scrubbed to scroll */
function storyTriggers() {
  if (!hasGSAP || REDUCED) return;
  document.querySelectorAll('.statement').forEach((el) => {
    gsapWin.timeline({
      scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true }
    })
    .fromTo(el, { autoAlpha: 0, y: 90 }, { autoAlpha: 1, y: 0, duration: 0.18, ease: 'power1.out' })
    .to({}, { duration: 0.6 })
    .to(el, { autoAlpha: 0, y: -90, duration: 0.22, ease: 'power1.in' });
  });
}

/* Panels & feature cards rise into place once each */
function panelReveals() {
  if (!hasGSAP || REDUCED) return;
  const groups = [
    { sel: '.features .panel', y: 84 },
    { sel: '.features .feature', y: 48, stagger: 0.09 },
    { sel: '.specs-grid', y: 84 },
    { sel: '.reserve-panel', y: 84 },
  ];
  groups.forEach((g) => {
    document.querySelectorAll(g.sel).forEach((el) => {
      gsapWin.fromTo(el, { autoAlpha: 0, y: g.y }, {
        autoAlpha: 1, y: 0, duration: 1.15, ease: 'power3.out', stagger: g.stagger || 0,
        scrollTrigger: { trigger: el, start: 'top 84%' }
      });
    });
  });
}

/* Spec counters tick up when scrolled into view */
function counters() {
  document.querySelectorAll('.count').forEach((el) => {
    const target = parseInt(el.dataset.count, 10) || 0;
    if (REDUCED || !hasGSAP) { el.textContent = target; return; }
    const state = { v: 0 };
    gsapWin.to(state, {
      v: target, duration: 1.9, ease: 'power2.out',
      scrollTrigger: { trigger: el, start: 'top 88%' },
      onUpdate: () => { el.textContent = Math.round(state.v); }
    });
  });
}

/* Nav backdrop once the page scrolls */
function navScroll() {
  const onScroll = () => document.body.classList.toggle('scrolled', window.scrollY > 40);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ---------- Boot ---------- */
function boot() {
  eqBars(REDUCED);
  heroIntro();
  counters();
  navScroll();
  storyTriggers();
  panelReveals();

  if (REDUCED) {
    document.body.classList.add('no-3d');           // canvas hidden by CSS; static vignette bg
    setTimeout(finishLoader, 1500);
    return;
  }
  let ok = false;
  try { ok = initScene(); }
  catch (e) { console.error('3D init failed:', e); ok = false; }
  if (!ok) { document.body.classList.add('no-3d'); finishLoader(); }
}
boot();







