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
let renderer, scene, camera, composer, bloomPass, vignettePass, group, stars, clouds, dust, clock;
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
  // Cinematic space rig — a warm sun from the front-right, a cool blue rim
  // from behind that carves the planet's silhouette off the void, and a faint
  // night-side fill so the dark hemisphere never falls to pure black.
  scene.add(new THREE.HemisphereLight(0x33415e, 0x04050a, 0.55));
  const key = new THREE.DirectionalLight(0xffe9d2, 2.4);
  key.position.set(5, 3, 4.5);
  const coolRim = new THREE.DirectionalLight(0x9db8e8, 1.1);
  coolRim.position.set(-4.5, -1, -5);
  const fill = new THREE.DirectionalLight(0x7fa8ff, 0.45);
  fill.position.set(-2.5, -1.5, 5.5);
  scene.add(key, coolRim, fill);

  // Depth cue: distant dust melts into the void
  scene.fog = new THREE.Fog(0x070708, 9.5, 14);

  group = new THREE.Group();
  group.rotation.z = 0.41;   // real axial tilt — 23.4°, like Earth itself
  scene.add(group);

  // 4K earth (turban/webgl-earth) + a night-lights layer (three-globe):
  // day map, elevation bump, ocean specular mask, cloud shell, city lights.
  const texLoader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const earthMap = texLoader.load('https://raw.githubusercontent.com/turban/webgl-earth/master/images/2_no_clouds_4k.jpg');
  const bumpMap = texLoader.load('https://raw.githubusercontent.com/turban/webgl-earth/master/images/elev_bump_4k.jpg');
  const waterMap = texLoader.load('https://raw.githubusercontent.com/turban/webgl-earth/master/images/water_4k.png');
  const cloudsMap = texLoader.load('https://raw.githubusercontent.com/turban/webgl-earth/master/images/fair_clouds_4k.png');
  const nightMap = texLoader.load('https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg');
  [earthMap, cloudsMap, nightMap].forEach((t) => { t.colorSpace = THREE.SRGBColorSpace; });
  [earthMap, bumpMap, waterMap, cloudsMap, nightMap].forEach((t) => { t.anisotropy = aniso; });

  // Planet — the warm sun lights the day side, oceans catch a tight specular
  // glint from the water mask, and the night side glows with city lights.
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 128, 64),
    new THREE.MeshPhongMaterial({
      map: earthMap,
      bumpMap, bumpScale: 0.05,
      specularMap: waterMap, specular: new THREE.Color(0x444444), shininess: 14,
      emissiveMap: nightMap, emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.1
    })
  );
  group.add(earth);

  // Clouds — a slightly larger shell drifting at its own pace
  clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.012, 96, 48),
    new THREE.MeshLambertMaterial({ map: cloudsMap, transparent: true, opacity: 0.85, depthWrite: false })
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
}

/* ---------- Starfield: 770 points in three brightness classes ---------- */
function starField() {
  const classes = [
    { n: 1200, rmin: 22, rmax: 34, size: 0.22, opacity: 0.55, color: 0xffffff },
    { n: 500,  rmin: 22, rmax: 38, size: 0.4,  opacity: 0.8,  color: 0xffe6c8 },
    { n: 200,  rmin: 24, rmax: 40, size: 0.8,  opacity: 1.0,  color: 0xdceaff }
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

/* ---------- Interaction + scroll state ---------- */
const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
window.addEventListener('pointermove', (e) => {
  pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
}, { passive: true });

function pageProgress() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

/* ---------- Render loop ---------- */
let idleRot = REDUCED ? 0.6 : 0;
let elapsed = 0;
let firstFrame = false;
function animate() {
  requestAnimationFrame(animate);
  if (!group) return;
  const dt = clock.getDelta();
  elapsed += dt; const t = elapsed;
  if (!REDUCED) idleRot += dt * 0.06;   // slow majestic planetary spin

  pointer.x += (pointer.tx - pointer.x) * 0.05;
  pointer.y += (pointer.ty - pointer.y) * 0.05;

  const p = pageProgress();
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

  // Starfield — a barely-perceptible drift plus a slow per-class twinkle
  stars.rotation.y += dt * 0.0035;
  [0.55, 0.8, 1.0].forEach((o, i) => {
    stars.children[i].material.opacity = o * (0.85 + 0.15 * Math.sin(t * (1.1 + i * 0.5) + i * 2.1));
  });

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
