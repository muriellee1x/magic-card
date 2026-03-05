const SparkReady = Promise.all([
  import('three'),
  import('@sparkjsdev/spark'),
]);

// ── Card ID from URL (gallery passes ?card=N) ──
const _urlParams = new URLSearchParams(window.location.search);
const CARD_ID = parseInt(_urlParams.get('card')) || 1;
const _fromGallery = _urlParams.has('card');

// ── DOM references ──
const card          = document.getElementById('card');
const cardWrapper   = document.getElementById('card-wrapper');
const cardFrame     = document.getElementById('card-frame');
const cardEffect    = document.getElementById('card-effect');
const sceneEffect   = document.getElementById('scene-effect');
const cardChar      = document.getElementById('card-character');
const cardCharCanvas = document.getElementById('card-character-canvas');
const overlay       = document.getElementById('overlay');
const overlayText   = document.getElementById('overlay-text');
const loadingScreen = document.getElementById('loading-screen');
const loadingIcon   = document.getElementById('loading-icon');
const loadingText   = document.getElementById('loading-text');
const pageBg        = document.getElementById('page-bg');
const sceneOverlay  = document.getElementById('scene-overlay');
const sceneWrap     = document.getElementById('scene-wrap');
const backBtn       = document.getElementById('back-btn');
const gyroBtn       = document.getElementById('gyro-btn');
const menuBtn       = document.getElementById('menu-btn');
const layerMenu     = document.getElementById('layer-menu');
const checkChar     = document.getElementById('check-char');
const checkFrame    = document.getElementById('check-frame');
const checkScene    = document.getElementById('check-scene');
const chatBubble    = document.getElementById('chat-bubble');
const bubbleText    = document.getElementById('bubble-text');
const sceneToast    = document.getElementById('scene-toast');

// ── Loading hint lines — rotate once per animation cycle (2.5 s) ──
const LOADING_LINES = [
  '魔法加载中…',
  '戳戳主播试试～',
  '点击手机形状 icon 开启陀螺仪',
  '双击进入魔法世界！',
  '点击 menu 控制显示内容',
  '稍等一下，马上就好～',
];
let _loadingLineIdx = 0;
if (loadingText) {
  loadingText.textContent = LOADING_LINES[0];
  loadingText.addEventListener('animationiteration', () => {
    _loadingLineIdx = (_loadingLineIdx + 1) % LOADING_LINES.length;
    loadingText.textContent = LOADING_LINES[_loadingLineIdx];
  });
}

// ── Per-card dialogue lines (4 lines each, cycle on every tap) ──
const CARD_LINES = {
  1: ['收到了寄给我的信～', '信封上还有香味呢！', '写信的人是你吗？', '哎呀，别点我啦！'],
  2: ['来一瓶快乐水！', '今天天气真不错～', '要不要一起游泳？', '哎呀，别点我啦！'],
  3: ['好美的枫叶呀！', '秋天是拍照的好时节', '叶子都红透啦～', '哎呀，别点我啦！'],
  4: ['看！下雪啦～', '幸亏戴了帽子', '你那里下雪了吗～', '哎呀，别点我啦！'],
};

let bubbleLineIndex = 0;

function advanceBubble() {
  const lines = CARD_LINES[CARD_ID] || CARD_LINES[1];
  bubbleLineIndex = (bubbleLineIndex + 1) % lines.length;
  bubbleText.textContent = lines[bubbleLineIndex];
  // Micro-bounce: briefly scale down then spring back via CSS transition
  chatBubble.style.transform = 'translateZ(31px) scale(0.88)';
  requestAnimationFrame(() => {
    chatBubble.style.transform = 'translateZ(31px) scale(1)';
  });
}

function initBubble() {
  const lines = CARD_LINES[CARD_ID] || CARD_LINES[1];
  bubbleLineIndex = 0;
  bubbleText.textContent = lines[0];
}

// Check if a screen-space click lands inside the card-character region.
// character is centered at (62%, 50%) of card-wrapper, sized 60% × 60%.
function isInCharacterRegion(clientX, clientY) {
  const rect = cardWrapper.getBoundingClientRect();
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  return relX >= 0.30 && relX <= 0.94 && relY >= 0.18 && relY <= 0.82;
}

// ── Dynamic image sources based on card ID ──
// Use a session-scoped version tag: same string for the whole browser session so
// files are cached after the first load; a new tag is only issued on a fresh session.
const _v = (() => {
  const KEY = '_assetV';
  let v = sessionStorage.getItem(KEY);
  if (!v) { v = Date.now().toString(); sessionStorage.setItem(KEY, v); }
  return v;
})();
cardFrame.src = `./files/card-frame${CARD_ID}.webp?v=${_v}`;
if (cardEffect)  cardEffect.src  = `./files/card${CARD_ID}-effect.webp?v=${_v}`;
if (sceneEffect) sceneEffect.src = cardEffect ? cardEffect.src : `./files/card${CARD_ID}-effect.webp?v=${_v}`;
// Cards 1 & 3 ship alpha-channel effects → normal blend; cards 2 & 4 use screen.
const _effectBlend = (CARD_ID === 1 || CARD_ID === 3) ? 'normal' : 'screen';
if (cardEffect)  cardEffect.style.mixBlendMode  = _effectBlend;
if (sceneEffect) sceneEffect.style.mixBlendMode = _effectBlend;
cardChar.src  = `./files/charactor${CARD_ID}.webp?v=${_v}`;
if (pageBg) pageBg.style.backgroundImage = `url('./files/BG-card${CARD_ID}-auto.webp?v=${_v}')`;
// loadingIcon src is set in HTML and preloaded via <link rel="preload">; no override needed.

if (_fromGallery) backBtn.style.display = 'flex';

// ── Character animation on canvas (optional) ──
let _charPingPongController = null;

async function startAnimatedWebPOnCanvas({ url, canvasEl, fallbackImgEl, fps = 24 }) {
  if (!canvasEl || !fallbackImgEl) return null;

  // Feature detection: WebCodecs ImageDecoder (not supported everywhere)
  if (typeof ImageDecoder !== 'function') {
    canvasEl.style.display = 'none';
    fallbackImgEl.style.display = '';
    return null;
  }

  const controller = {
    _stopped: false,
    _raf: 0,
    _decoder: null,
    _frames: [],
    stop() {
      this._stopped = true;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      try { this._decoder?.close?.(); } catch {}
      this._decoder = null;
      for (const f of this._frames) { try { f?.close?.(); } catch {} }
      this._frames = [];
    }
  };

  try {
    // Ensure fallback doesn't animate underneath
    fallbackImgEl.style.display = 'none';
    canvasEl.style.display = 'block';

    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`Failed to fetch character: ${res.status}`);
    const buf = await res.arrayBuffer();
    if (controller._stopped) return controller;

    const decoder = new ImageDecoder({ data: buf, type: 'image/webp' });
    controller._decoder = decoder;
    await decoder.tracks.ready;
    if (controller._stopped) return controller;

    const track = decoder.tracks.selectedTrack;
    const frameCount = track?.frameCount ?? 0;
    if (!frameCount || frameCount < 2) {
      canvasEl.style.display = 'none';
      fallbackImgEl.style.display = '';
      return controller;
    }

    // Decode all frames once (33 frames → OK)
    const frames = new Array(frameCount);
    const durationsMs = new Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      if (controller._stopped) { try { image?.close?.(); } catch {} ; return controller; }
      frames[i] = image; // VideoFrame
      // Prefer encoded per-frame duration if available; fallback to fixed fps.
      const fallbackMs = 1000 / fps;
      const durUs = typeof image?.duration === 'number' ? image.duration : 0;
      durationsMs[i] = durUs > 0 ? (durUs / 1000) : fallbackMs;
    }
    controller._frames = frames;

    const first = frames[0];
    const w = first.displayWidth || first.codedWidth;
    const h = first.displayHeight || first.codedHeight;
    canvasEl.width = w;
    canvasEl.height = h;

    const ctx = canvasEl.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D not available');
    ctx.imageSmoothingEnabled = true;

    let frameIndex = 0;
    let lastT = performance.now();
    let carry = 0; // leftover ms for variable frame durations

    const draw = (t) => {
      if (controller._stopped) return;
      const dt = t - lastT;
      lastT = t;
      carry += dt;

      // Advance frames based on each frame's own duration
      // (some animated WebP have non-uniform timing even if "fps" looks like 24).
      let guard = 0;
      while (carry >= (durationsMs[frameIndex] || (1000 / fps))) {
        carry -= (durationsMs[frameIndex] || (1000 / fps));
        frameIndex = (frameIndex + 1) % frameCount;
        // Prevent pathological long loops if tab was backgrounded
        if (++guard > frameCount * 5) { carry = 0; break; }
      }

      const frame = frames[frameIndex] ?? frames[0];
      try {
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        ctx.drawImage(frame, 0, 0, canvasEl.width, canvasEl.height);
      } catch {}

      controller._raf = requestAnimationFrame(draw);
    };

    // Draw first frame immediately
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.drawImage(frames[0], 0, 0, canvasEl.width, canvasEl.height);
    controller._raf = requestAnimationFrame(draw);
    return controller;
  } catch (err) {
    // Fallback to native animated WebP loop
    try { controller.stop(); } catch {}
    canvasEl.style.display = 'none';
    fallbackImgEl.style.display = '';
    return null;
  }
}

if (cardCharCanvas && cardChar) {
  // Wait for the <img> to finish loading before calling fetch() inside the canvas
  // animator — this ensures fetch({ cache: 'force-cache' }) hits the cache instead
  // of firing a second parallel network request for the same file.
  const _launchCharAnim = () => {
    _charPingPongController?.stop?.();
    startAnimatedWebPOnCanvas({
      url: cardChar.src,
      canvasEl: cardCharCanvas,
      fallbackImgEl: cardChar,
      fps: 24
    }).then(ctrl => { _charPingPongController = ctrl; });
  };
  if (cardChar.complete && cardChar.naturalWidth > 0) {
    _launchCharAnim();
  } else {
    cardChar.addEventListener('load',  _launchCharAnim, { once: true });
    cardChar.addEventListener('error', _launchCharAnim, { once: true });
  }
}

// ── Scene file paths (dynamic per card) ──
// .sog = SparkJS pcsogszip format (ZIP of PNG attribute images, ~9-10 MB vs 63 MB PLY)
const CARD_PLY  = `./files/3D/sharp_charactor${CARD_ID}_b.sog`;
const SCENE_PLY = `./files/3D/sharp_charactor${CARD_ID}_a.sog`;

// ── Per-card splat position offsets [x, y, z] ──
// Adjust each card's 3D scene center independently.
// x: 左右 (正=右), y: 上下 (正=上), z: 前后 (正=离相机近)
// const CARD_SPLAT_POSITION = {
//   1: [0, 0.75, 0.5],
//   2: [-5, 10, 1],
//   3: [0, 0.5, 0],
//   4: [0, 0.5, 0],
// };
// const SCENE_SPLAT_POSITION = {
//   1: [-0.5, 1, 0.5],
//   2: [0, 0.5, 0],
//   3: [0, 1.55, 1],
//   4: [-0.85, -1.1, 0.75],
// };
const CARD_SPLAT_POSITION = {
  1: [0, 0, 0],
  2: [0, 0, 0],
  3: [0, 0, 0],
  4: [0, 0, 0],
};
const SCENE_SPLAT_POSITION = {
  1: [0, 0, 0],
  2: [0, 0, 0],
  3: [0, 0, 0],
  4: [0, 0, 0],
};
const _cardPos  = CARD_SPLAT_POSITION[CARD_ID]  || [0, 0.5, 0];
const _scenePos = SCENE_SPLAT_POSITION[CARD_ID] || [0, 0.5, 0];

// ── Per-card splat Z clipping [zMin, zMax] (local space, OpenCV: +Z = 远离相机) ──
// 设为 null 表示不裁剪；只保留 zMin ≤ z ≤ zMax 范围内的 splat
const CARD_SPLAT_CLIP = {
  1: [0.75, null],
  2: [0.1, null],
  3: [0.1, null],
  4: [0.1, null],
};
const SCENE_SPLAT_CLIP = {
  1: [1, null],
  2: [0.1, null],
  3: [0.75, null],
  4: [0.1, null],
};
const _cardClip  = CARD_SPLAT_CLIP[CARD_ID]  || null;
const _sceneClip = SCENE_SPLAT_CLIP[CARD_ID] || null;

function clipSplats(splatMesh, zMin, zMax) {
  let clipped = 0;
  splatMesh.forEachSplat((index, center, scales, quaternion, opacity, color) => {
    const z = center.z;
    if ((zMin != null && z < zMin) || (zMax != null && z > zMax)) {
      splatMesh.packedSplats.setSplat(index, center, scales, quaternion, 0, color);
      clipped++;
    }
  });
  if (clipped > 0) {
    splatMesh.packedSplats.needsUpdate = true;
    splatMesh.updateVersion();
    console.log(`[clipSplats] removed ${clipped} / ${splatMesh.numSplats} splats outside z=[${zMin ?? '-∞'}, ${zMax ?? '+∞'}]`);
  }
}

// ── Default camera parameters ──
const DEFAULT_INTRINSICS = [
  [712.9761866535534, 0, 464.0],
  [0, 712.9761866535534, 616.0],
  [0, 0, 1]
];
const DEFAULT_EXTRINSICS = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1]
];

// ── Focal constants ──
const GEN_FOCAL_MM    = 30;
const FOCAL_OFFSET_MM = 20;
const FOCAL_ZOOM_DELTA = 10;   // extra focal when entering fullscreen
const FOCAL_ZOOM_DAMP  = 0.035; // cinematic zoom speed (~1.5 s)

const ORBIT_DIST = 4;

// ── Camera math ──

function computeVFOV(intrinsics, offsetMM = FOCAL_OFFSET_MM) {
  const fy = intrinsics[1][1];
  const cy = intrinsics[1][2];
  const displayFocal = GEN_FOCAL_MM + offsetMM;
  const effectiveFy  = fy * (displayFocal / GEN_FOCAL_MM);
  return 2 * Math.atan(cy / effectiveFy) * 180 / Math.PI;
}

function computeCameraSetup(extrinsics) {
  const R = [
    [extrinsics[0][0], extrinsics[0][1], extrinsics[0][2]],
    [extrinsics[1][0], extrinsics[1][1], extrinsics[1][2]],
    [extrinsics[2][0], extrinsics[2][1], extrinsics[2][2]]
  ];
  const t = [extrinsics[0][3], extrinsics[1][3], extrinsics[2][3]];

  const pos = [
    -(R[0][0]*t[0] + R[1][0]*t[1] + R[2][0]*t[2]),
    -(R[0][1]*t[0] + R[1][1]*t[1] + R[2][1]*t[2]),
    -(R[0][2]*t[0] + R[1][2]*t[1] + R[2][2]*t[2])
  ];

  const right = [R[0][0], R[0][1], R[0][2]];
  const up    = [R[1][0], R[1][1], R[1][2]];
  const back  = [R[2][0], R[2][1], R[2][2]];
  const fwd   = [-back[0], -back[1], -back[2]];

  const lookAt = [
    pos[0] + fwd[0] * ORBIT_DIST,
    pos[1] + fwd[1] * ORBIT_DIST,
    pos[2] + fwd[2] * ORBIT_DIST
  ];

  return { pos, right, up, back, fwd, lookAt };
}

// ── Splat scale ──
const SPLAT_SCALE = 2;

// ── Orbit / interaction constants ──
const MAX_ORBIT_H = 10 * Math.PI / 180;  // 左右最大旋转角
const MAX_ORBIT_V =  4 * Math.PI / 180;  // 上下最大旋转角
const DAMP        = 0.12;
const TOUCH_SENS  = 0.003;
const GYRO_SENS   = 0.5;

// ── Zoom constants ──
const ZOOM_MIN_CARD    = 0.8;
const ZOOM_MAX_CARD    = 1.0;
const ZOOM_MIN_SCENE   = 0.95;
const ZOOM_MAX_SCENE   = 1.4;
const ZOOM_DAMP        = 0.12;
const WHEEL_ZOOM_SPEED = 0.001;

// ── CSS tilt ──
const CARD_TILT_AMP   = 1.0;
const RAD_TO_DEG      = 180 / Math.PI;
// Card zoom-in/out during fullscreen enter/exit
const CARD_ZOOM_ENTER = 1.06;  // target scale when fullscreen is active
const CARD_ZOOM_DAMP  = 0.09;  // matches ~0.45 s CSS overlay transition

// ── Viewer state ──
// Card viewer (rendered into #card element)
let cardRenderer = null, cardScene = null, cardCamera = null, cardSplat = null;
// Scene viewer (rendered into #scene-wrap element)
let sceneRenderer = null, sceneScene = null, sceneCamera = null, sceneSplat = null;
let cardLoaded  = false;
let sceneLoaded = false;
// isOverlayVisible: true while scene overlay is visible (incl. exit transition)
let isOverlayVisible = false;
let exitTransitionTimer = null;

// ── Shared interaction state ──
let alpha = 0, beta = 0;
let touchDA = 0, touchDB = 0;
let gyroDA = 0, gyroDB = 0;
let targetA = 0, targetB = 0;

let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
let gyroOn = false, gyroBeta0 = null, gyroGamma0 = null;
let isFullscreen = false;

let zoomFactor = 1.0, targetZoom = 1.0;
let pinching = false, pinchStartDist = 0, pinchStartZoom = 1.0;
// Animated scale for card enter/exit zoom effect
let cardScale = 1.0;

// ── Focal zoom (scene viewer only) ──
let focalOffset = FOCAL_OFFSET_MM;
let targetFocalOffset = FOCAL_OFFSET_MM;
let currentIntrinsics = DEFAULT_INTRINSICS;

// ── Per-viewer orbit reference frames ──
function makeOrbit() {
  return {
    cx: 0, cy: 0, cz: -ORBIT_DIST, radius: ORBIT_DIST,
    rx: 1, ry: 0, rz: 0,
    ux: 0, uy: 1, uz: 0,
    bx: 0, by: 0, bz: 1
  };
}

let cardOrbit  = makeOrbit();
let sceneOrbit = makeOrbit();

// ── Robust front-center of splat scene ──────────────────────────────────────
// Uses SparkJS forEachSplat API to sample positions, discard outliers, and
// return the centroid shifted to the 10th-percentile depth plane.
// Returns [x,y,z] or null → safe fallback to original orbit.
function computeRobustFrontCenter(splatMesh, fwd, camPos) {
  try {
    if (!splatMesh || !splatMesh.isInitialized) return null;
    const numSplats = splatMesh.numSplats || 0;
    if (numSplats < 9) return null;

    const step = Math.max(1, Math.floor(numSplats / 3000)); // sample ≤ 3000 points
    const pts  = [];

    splatMesh.forEachSplat((index, center) => {
      if (index % step !== 0) return;
      const x = center.x, y = center.y, z = center.z;
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
      const d = (x - camPos[0]) * fwd[0] +
                (y - camPos[1]) * fwd[1] +
                (z - camPos[2]) * fwd[2];
      if (d <= 0) return;
      pts.push({ x, y, z, d });
    });

    if (pts.length < 10) return null;

    pts.sort((a, b) => a.d - b.d);
    const lo       = Math.floor(pts.length * 0.05);
    const hi       = Math.ceil (pts.length * 0.95);
    const filtered = pts.slice(lo, hi);
    if (!filtered.length) return null;

    let mx = 0, my = 0, mz = 0;
    for (const p of filtered) { mx += p.x; my += p.y; mz += p.z; }
    mx /= filtered.length; my /= filtered.length; mz /= filtered.length;

    const frontDepth  = filtered[Math.floor(filtered.length * 0.10)].d;
    const centerDepth = (mx - camPos[0]) * fwd[0] +
                        (my - camPos[1]) * fwd[1] +
                        (mz - camPos[2]) * fwd[2];
    const shift = frontDepth - centerDepth;

    return [
      mx + shift * fwd[0],
      my + shift * fwd[1],
      mz + shift * fwd[2],
    ];
  } catch {
    return null;
  }
}

// ── Reposition orbit pivot while keeping camera at its current position ──────
// pivotCenter must be in front of the camera (sanity-checked here).
// Returns true on success, false → caller should keep original orbit.
function applyPivotOrbit(orbit, camPos, pivotCenter, worldUp, fwd) {
  try {
    // Pivot must be strictly in front of the camera
    const tpx = pivotCenter[0] - camPos[0];
    const tpy = pivotCenter[1] - camPos[1];
    const tpz = pivotCenter[2] - camPos[2];
    if (tpx * fwd[0] + tpy * fwd[1] + tpz * fwd[2] <= 0) return false;

    const radius = Math.sqrt(tpx*tpx + tpy*tpy + tpz*tpz);
    if (radius < 1e-6) return false;

    // back = unit vector from pivot toward camera
    const bx = -tpx / radius, by = -tpy / radius, bz = -tpz / radius;

    // right = normalize(cross(worldUp, back))
    let rx = worldUp[1]*bz - worldUp[2]*by;
    let ry = worldUp[2]*bx - worldUp[0]*bz;
    let rz = worldUp[0]*by - worldUp[1]*bx;
    const rLen = Math.sqrt(rx*rx + ry*ry + rz*rz);
    if (rLen < 1e-6) return false;
    rx /= rLen; ry /= rLen; rz /= rLen;

    orbit.cx = pivotCenter[0]; orbit.cy = pivotCenter[1]; orbit.cz = pivotCenter[2];
    orbit.radius = radius;
    orbit.bx = bx; orbit.by = by; orbit.bz = bz;
    orbit.rx = rx; orbit.ry = ry; orbit.rz = rz;
    orbit.ux = worldUp[0]; orbit.uy = worldUp[1]; orbit.uz = worldUp[2];
    return true;
  } catch {
    return false;
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function showError(text) {
  overlayText.textContent = text;
  overlay.classList.remove('hidden');
}

let _sceneToastTimer = null;
function showSceneToast() {
  if (!sceneToast) return;
  if (_sceneToastTimer) { clearTimeout(_sceneToastTimer); _sceneToastTimer = null; }
  sceneToast.classList.remove('hidden');
  _sceneToastTimer = setTimeout(() => {
    sceneToast.classList.add('hidden');
    _sceneToastTimer = null;
  }, 2000);
}

// ── Apply orbit to a camera ──
function applyOrbit(cam, orbit, a, b, radius) {
  const cosA = Math.cos(-a), sinA = Math.sin(-a);
  const cosB = Math.cos(b),  sinB = Math.sin(b);
  const offX = radius * (orbit.bx*cosA*cosB + orbit.rx*sinA*cosB + orbit.ux*sinB);
  const offY = radius * (orbit.by*cosA*cosB + orbit.ry*sinA*cosB + orbit.uy*sinB);
  const offZ = radius * (orbit.bz*cosA*cosB + orbit.rz*sinA*cosB + orbit.uz*sinB);
  cam.position.set(orbit.cx + offX, orbit.cy + offY, orbit.cz + offZ);
  cam.lookAt(orbit.cx, orbit.cy, orbit.cz);
}

// ── Camera params loader ──
async function loadCameraParams(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.intrinsics) return data;
    return null;
  } catch {
    return null;
  }
}

// ── Detect splat file type for SparkJS ──
function detectSplatFileType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.ksplat'))  return 'ksplat';
  if (lower.endsWith('.splat'))   return 'splat';
  if (lower.endsWith('.spz'))     return 'spz';
  if (lower.endsWith('.sog'))     return 'pcsogszip';   // SparkJS pcsogszip format
  // .ply auto-detected by SparkJS from file contents
  return undefined;
}

// ── Create a canvas + THREE.js WebGLRenderer inside a container element ──
function createRendererInContainer(THREE, container) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  container.appendChild(canvas);
  const { width, height } = container.getBoundingClientRect();
  const w = Math.max(width, 1), h = Math.max(height, 1);
  console.log(`[createRenderer] container size: ${width}x${height}, using: ${w}x${h}`);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  console.log(`[createRenderer] renderer initialized, pixelRatio: ${window.devicePixelRatio}`);
  return { renderer, canvas, w, h };
}

// ── Load card viewer (card splat into #card) ──
async function loadCardViewer(THREE, Spark, params) {
  const intrinsics = params?.intrinsics || DEFAULT_INTRINSICS;
  const extrinsics = params?.extrinsics || DEFAULT_EXTRINSICS;
  const vfov  = computeVFOV(intrinsics);
  const setup = computeCameraSetup(extrinsics);

  const { renderer, w, h } = createRendererInContainer(THREE, card);
  cardRenderer = renderer;

  cardScene  = new THREE.Scene();
  cardCamera = new THREE.PerspectiveCamera(vfov, w / h, 0.1, 1000);
  cardCamera.up.set(setup.up[0], setup.up[1], setup.up[2]);
  cardCamera.position.set(setup.pos[0], setup.pos[1], setup.pos[2]);
  cardCamera.lookAt(setup.lookAt[0], setup.lookAt[1], setup.lookAt[2]);

  const spark = new Spark.SparkRenderer({
    renderer: cardRenderer,
    focalAdjustment: 1.0,
    minAlpha: 5 / 255,
  });
  cardScene.add(spark);

  cardSplat = new Spark.SplatMesh({
    url:      CARD_PLY,
    fileType: detectSplatFileType(CARD_PLY),
  });
  cardSplat.quaternion.set(1, 0, 0, 0);
  cardSplat.position.set(_cardPos[0], _cardPos[1], _cardPos[2]);
  cardScene.add(cardSplat);

  await cardSplat.initialized;
  cardSplat.scale.setScalar(SPLAT_SCALE);
  if (_cardClip) clipSplats(cardSplat, _cardClip[0], _cardClip[1]);
  console.log('[card splat] initialized, numSplats:', cardSplat.numSplats);

  // Orbit: use fixed lookAt as pivot so all cards share the same rotation center
  cardOrbit.radius = ORBIT_DIST;
  cardOrbit.cx = setup.lookAt[0]; cardOrbit.cy = setup.lookAt[1]; cardOrbit.cz = setup.lookAt[2];
  cardOrbit.rx = setup.right[0];  cardOrbit.ry = setup.right[1];  cardOrbit.rz = setup.right[2];
  cardOrbit.ux = setup.up[0];     cardOrbit.uy = setup.up[1];     cardOrbit.uz = setup.up[2];
  cardOrbit.bx = setup.back[0];   cardOrbit.by = setup.back[1];   cardOrbit.bz = setup.back[2];

  cardLoaded = true;
}

// ── Load scene viewer (scene splat into #scene-wrap) ──
async function loadSceneViewer(THREE, Spark, params) {
  const intrinsics = params?.intrinsics || DEFAULT_INTRINSICS;
  const extrinsics = params?.extrinsics || DEFAULT_EXTRINSICS;
  currentIntrinsics = intrinsics;
  const vfov  = computeVFOV(intrinsics);
  const setup = computeCameraSetup(extrinsics);

  const { renderer, w, h } = createRendererInContainer(THREE, sceneWrap);
  sceneRenderer = renderer;

  sceneScene  = new THREE.Scene();
  sceneCamera = new THREE.PerspectiveCamera(vfov, w / h, 0.1, 1000);
  sceneCamera.up.set(setup.up[0], setup.up[1], setup.up[2]);
  sceneCamera.position.set(setup.pos[0], setup.pos[1], setup.pos[2]);
  sceneCamera.lookAt(setup.lookAt[0], setup.lookAt[1], setup.lookAt[2]);

  const spark = new Spark.SparkRenderer({
    renderer: sceneRenderer,
    focalAdjustment: 1.0,
    minAlpha: 5 / 255,
  });
  sceneScene.add(spark);

  sceneSplat = new Spark.SplatMesh({
    url:      SCENE_PLY,
    fileType: detectSplatFileType(SCENE_PLY),
  });
  sceneSplat.quaternion.set(1, 0, 0, 0);
  sceneSplat.position.set(_scenePos[0], _scenePos[1], _scenePos[2]);
  sceneScene.add(sceneSplat);

  await sceneSplat.initialized;
  sceneSplat.scale.setScalar(SPLAT_SCALE);
  if (_sceneClip) clipSplats(sceneSplat, _sceneClip[0], _sceneClip[1]);

  sceneOrbit.radius = ORBIT_DIST;
  sceneOrbit.cx = setup.lookAt[0]; sceneOrbit.cy = setup.lookAt[1]; sceneOrbit.cz = setup.lookAt[2];
  sceneOrbit.rx = setup.right[0];  sceneOrbit.ry = setup.right[1];  sceneOrbit.rz = setup.right[2];
  sceneOrbit.ux = setup.up[0];     sceneOrbit.uy = setup.up[1];     sceneOrbit.uz = setup.up[2];
  sceneOrbit.bx = setup.back[0];   sceneOrbit.by = setup.back[1];   sceneOrbit.bz = setup.back[2];

  sceneLoaded = true;
}

// ========== Main loop ==========

function tick() {
  requestAnimationFrame(tick);

  if (cardLoaded || sceneLoaded) {
    targetA = clamp(touchDA + gyroDA, -MAX_ORBIT_H, MAX_ORBIT_H);
    targetB = clamp(touchDB + gyroDB, -MAX_ORBIT_V, MAX_ORBIT_V);
    alpha += (targetA - alpha) * DAMP;
    beta  += (targetB - beta)  * DAMP;
    zoomFactor += (targetZoom - zoomFactor) * ZOOM_DAMP;

    // ── Card viewer (always orbit; CSS tilt + zoom animation always updated) ──
    if (cardLoaded && cardCamera) {
      applyOrbit(cardCamera, cardOrbit, alpha, beta, cardOrbit.radius);

      // cardScale interpolates: 1.0 in normal mode, CARD_ZOOM_ENTER in fullscreen
      const cardScaleTarget = isFullscreen ? CARD_ZOOM_ENTER : 1.0;
      cardScale += (cardScaleTarget - cardScale) * CARD_ZOOM_DAMP;

      if (!isFullscreen) {
        // Normal: tilt + user zoom + card zoom animation
        const tiltY =  alpha * RAD_TO_DEG * CARD_TILT_AMP;
        const tiltX = -beta  * RAD_TO_DEG * CARD_TILT_AMP;
        cardWrapper.style.transform =
          `rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale(${zoomFactor * cardScale})`;
      } else {
        // Fullscreen: only drive the card zoom (no tilt, overlay is on top)
        cardWrapper.style.transform = `scale(${cardScale})`;
      }
    }

    // ── Scene viewer (orbit + focal zoom; only when overlay is visible) ──
    if (sceneLoaded && sceneCamera && isOverlayVisible) {
      const radius = isFullscreen
        ? sceneOrbit.radius / zoomFactor
        : sceneOrbit.radius;
      applyOrbit(sceneCamera, sceneOrbit, alpha, beta, radius);

      if (Math.abs(targetFocalOffset - focalOffset) > 0.01) {
        focalOffset += (targetFocalOffset - focalOffset) * FOCAL_ZOOM_DAMP;
        sceneCamera.fov = computeVFOV(currentIntrinsics, focalOffset);
        sceneCamera.updateProjectionMatrix();
      }
    }
  }

  // Render: card always; scene only while overlay is visible
  if (cardRenderer && cardScene && cardCamera) {
    try { 
      cardRenderer.render(cardScene, cardCamera);
      // Log first few frames for debugging
      if (!window.__cardRenderCount) window.__cardRenderCount = 0;
      if (window.__cardRenderCount < 5) {
        console.log(`[render ${window.__cardRenderCount}] card rendered`);
        window.__cardRenderCount++;
      }
    } catch (e) {
      if (!window.__cardRenderError) {
        console.error('[render] card error:', e);
        window.__cardRenderError = true;
      }
    }
  }
  if (sceneRenderer && sceneScene && sceneCamera && isOverlayVisible) {
    try { sceneRenderer.render(sceneScene, sceneCamera); } catch {}
  }
}

requestAnimationFrame(tick);

// ========== Pointer helpers (shared) ==========

function ptrDown(px, py) { if (pinching) return; dragging = true; lastX = px; lastY = py; downX = px; downY = py; }

function ptrMove(px, py) {
  if (!dragging || pinching) return;
  touchDA = clamp(touchDA + (px - lastX) * TOUCH_SENS, -MAX_ORBIT_H, MAX_ORBIT_H);
  touchDB = clamp(touchDB + (py - lastY) * TOUCH_SENS, -MAX_ORBIT_V, MAX_ORBIT_V);
  lastX = px;
  lastY = py;
}

function ptrUp() { dragging = false; }

function getTouchDist(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Attach pointer/touch/wheel events to a given element ──
function attachInteraction(el, allowDoubleTap = false) {
  // Pointer drag
  el.addEventListener('pointerdown', e => {
    e.stopPropagation(); e.preventDefault();
    ptrDown(e.clientX, e.clientY);
  }, { capture: true });

  el.addEventListener('pointermove', e => {
    e.stopPropagation(); e.preventDefault();
    ptrMove(e.clientX, e.clientY);
  }, { capture: true });

  el.addEventListener('pointerup', e => {
    e.stopPropagation();
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    const isTap = !pinching && Math.sqrt(dx * dx + dy * dy) < 8;
    ptrUp();
    if (allowDoubleTap && isTap && !isFullscreen) {
      if (isInCharacterRegion(e.clientX, e.clientY)) advanceBubble();
    }
  }, { capture: true });

  el.addEventListener('pointercancel', e => {
    e.stopPropagation(); ptrUp();
  }, { capture: true });

  // Pinch-to-zoom
  el.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      pinching = true;
      dragging = false;
      pinchStartDist = getTouchDist(e.touches[0], e.touches[1]);
      pinchStartZoom = targetZoom;
    }
  }, { passive: false, capture: true });

  el.addEventListener('touchmove', e => {
    if (pinching && e.touches.length === 2) {
      e.preventDefault();
      if (!isFullscreen) return;
      const dist  = getTouchDist(e.touches[0], e.touches[1]);
      const scale = dist / pinchStartDist;
      targetZoom  = clamp(pinchStartZoom * scale, ZOOM_MIN_SCENE, ZOOM_MAX_SCENE);
    }
  }, { passive: false, capture: true });

  el.addEventListener('touchend', e => {
    if (pinching && e.touches.length < 2) pinching = false;
  }, { capture: true });

  el.addEventListener('touchcancel', () => { pinching = false; }, { capture: true });

  // Mouse wheel zoom
  el.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    if (!isFullscreen) return;
    targetZoom = clamp(targetZoom * (1 - e.deltaY * WHEEL_ZOOM_SPEED), ZOOM_MIN_SCENE, ZOOM_MAX_SCENE);
  }, { passive: false });

  if (!allowDoubleTap) return;

  // Double-tap (mobile) — only on card-wrapper, not scene overlay
  el.addEventListener('dblclick', e => {
    if (!cardLoaded || isFullscreen) return;
    e.stopPropagation();
    if (!sceneLoaded) { showSceneToast(); return; }
    enterFullscreen();
  });

  let lastTapTime = 0;
  let hadMultiTouch = false;

  el.addEventListener('touchstart', e => {
    if (e.touches.length >= 2) hadMultiTouch = true;
  }, { passive: true, capture: true });

  el.addEventListener('touchend', e => {
    if (e.touches.length !== 0) return;
    if (hadMultiTouch) { hadMultiTouch = false; lastTapTime = 0; return; }
    hadMultiTouch = false;
    if (!cardLoaded || isFullscreen) return;
    const now = Date.now();
    if (now - lastTapTime < 300) {
      e.preventDefault(); e.stopPropagation();
      if (!sceneLoaded) { showSceneToast(); return; }
      enterFullscreen();
    }
    lastTapTime = now;
  }, { passive: false, capture: true });

  el.addEventListener('touchcancel', () => {
    hadMultiTouch = false; lastTapTime = 0;
  }, { capture: true });
}

attachInteraction(cardWrapper, true);   // card: drag + pinch + double-tap
attachInteraction(sceneOverlay, false); // scene: drag + pinch only

// ========== Gyroscope ==========

const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (isMobile || 'DeviceOrientationEvent' in window) {
  gyroBtn.style.display = 'flex';
}

let gyroTimeout = null;

gyroBtn.addEventListener('click', async () => {
  if (gyroOn) {
    gyroOn = false;
    gyroBtn.classList.remove('active');
    gyroDA = gyroDB = 0;
    touchDA = touchDB = 0;
    window.removeEventListener('deviceorientation', onGyro);
    if (gyroTimeout) { clearTimeout(gyroTimeout); gyroTimeout = null; }
    return;
  }

  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') {
        console.warn('[gyro] permission denied');
        return;
      }
    } catch (err) {
      console.warn('[gyro] permission request failed:', err);
      return;
    }
  }

  touchDA = touchDB = 0;
  gyroOn = true;
  gyroBeta0 = gyroGamma0 = null;
  gyroBtn.classList.add('active');
  window.addEventListener('deviceorientation', onGyro);

  gyroTimeout = setTimeout(() => {
    if (gyroOn && gyroBeta0 == null) {
      gyroOn = false;
      gyroBtn.classList.remove('active');
      window.removeEventListener('deviceorientation', onGyro);
    }
    gyroTimeout = null;
  }, 3000);
});

function onGyro(e) {
  if (!gyroOn || e.beta == null || e.gamma == null) return;
  if (gyroBeta0 == null) {
    gyroBeta0  = e.beta;
    gyroGamma0 = e.gamma;
    if (gyroTimeout) { clearTimeout(gyroTimeout); gyroTimeout = null; }
  }
  gyroDA = clamp(-(e.gamma - gyroGamma0) * Math.PI / 180 * GYRO_SENS, -MAX_ORBIT_H, MAX_ORBIT_H);
  gyroDB = clamp(-(e.beta  - gyroBeta0)  * Math.PI / 180 * GYRO_SENS, -MAX_ORBIT_V, MAX_ORBIT_V);
}

// ========== Scene fullscreen mode ==========

function enterFullscreen() {
  isFullscreen = true;
  isOverlayVisible = true;
  if (exitTransitionTimer) { clearTimeout(exitTransitionTimer); exitTransitionTimer = null; }

  document.body.classList.add('scene-fullscreen');
  sceneOverlay.classList.add('active');
  backBtn.style.display = 'flex';

  // Reset shared interaction to neutral
  touchDA = touchDB = 0;
  alpha = beta = targetA = targetB = 0;
  zoomFactor = targetZoom = 1.0;
  cardScale = 1.0; // start card zoom-in from scratch

  // Start focal zoom-in on scene viewer
  focalOffset = FOCAL_OFFSET_MM;
  targetFocalOffset = FOCAL_OFFSET_MM + FOCAL_ZOOM_DELTA;
}

function exitFullscreen() {
  isFullscreen = false;
  sceneOverlay.classList.remove('active');
  backBtn.style.display = _fromGallery ? 'flex' : 'none';
  document.body.classList.remove('scene-fullscreen');

  zoomFactor = targetZoom = 1.0;
  targetFocalOffset = FOCAL_OFFSET_MM;

  // Keep scene rendering until CSS transition completes, then stop
  exitTransitionTimer = setTimeout(() => {
    isOverlayVisible = false;
    exitTransitionTimer = null;
  }, 600); // > CSS transition duration (450ms)
}

backBtn.addEventListener('click', () => {
  if (isFullscreen) {
    exitFullscreen();
  } else if (_fromGallery) {
    window.location.href = 'index.html';
  }
});

// ========== Menu button ==========

menuBtn.addEventListener('click', e => {
  e.stopPropagation();
  layerMenu.classList.toggle('hidden');
  menuBtn.classList.toggle('active', !layerMenu.classList.contains('hidden'));
});

document.addEventListener('click', e => {
  if (!layerMenu.contains(e.target) && e.target !== menuBtn) {
    layerMenu.classList.add('hidden');
    menuBtn.classList.remove('active');
  }
});

// ========== Layer visibility toggles ==========

checkChar.addEventListener('change', () => {
  const v = checkChar.checked ? '' : 'hidden';
  cardChar.style.visibility = v;
  if (cardCharCanvas) cardCharCanvas.style.visibility = v;
  // hide chat bubble when character is hidden
  if (chatBubble) chatBubble.style.visibility = v;
});

checkFrame.addEventListener('change', () => {
  cardFrame.style.visibility = checkFrame.checked ? '' : 'hidden';
});

checkScene.addEventListener('change', () => {
  const v = checkScene.checked ? '' : 'hidden';
  card.style.visibility = v;
  // hide card-effect (screen-blend layer) together with the scene
  if (cardEffect) cardEffect.style.visibility = v;
});

// ========== Resize observers ==========

new ResizeObserver(() => {
  if (!cardCamera || !cardRenderer) return;
  const { width, height } = card.getBoundingClientRect();
  if (width === 0 || height === 0) return;
  cardRenderer.setPixelRatio(window.devicePixelRatio);
  cardRenderer.setSize(width, height);
  cardCamera.aspect = width / height;
  cardCamera.updateProjectionMatrix();
}).observe(card);

new ResizeObserver(() => {
  if (!sceneCamera || !sceneRenderer) return;
  const { width, height } = sceneWrap.getBoundingClientRect();
  if (width === 0 || height === 0) return;
  sceneRenderer.setPixelRatio(window.devicePixelRatio);
  sceneRenderer.setSize(width, height);
  sceneCamera.aspect = width / height;
  sceneCamera.updateProjectionMatrix();
}).observe(sceneWrap);

// ── Wait for an img element to finish loading (resolves immediately if already complete) ──
function waitForImage(imgEl) {
  if (!imgEl || !imgEl.src || imgEl.complete) return Promise.resolve();
  return new Promise(resolve => {
    imgEl.addEventListener('load',  resolve, { once: true });
    imgEl.addEventListener('error', resolve, { once: true });
  });
}

// ========== Init: card viewer first, then scene viewer in background ==========

async function init() {
  try {
    const [[THREE, Spark], params] = await Promise.all([
      SparkReady,
      loadCameraParams('./camera.json'),
    ]);

    // Phase 1: load only what's needed for initial display (_b.sog + images).
    // _a.sog (scene viewer) is ~10 MB and only needed on double-tap;
    // loading both files at once doubles peak memory and can trigger an iOS tab kill.
    await Promise.all([
      loadCardViewer(THREE, Spark, params),
      waitForImage(cardFrame),
      waitForImage(cardChar),
      waitForImage(cardEffect),
    ]);

    // Show the page as soon as the card is ready.
    alpha = beta = targetA = targetB = 0;
    touchDA = touchDB = 0;
    zoomFactor = targetZoom = 1.0;
    focalOffset = targetFocalOffset = FOCAL_OFFSET_MM;

    loadingScreen.classList.add('hidden');
    if (pageBg) pageBg.classList.add('visible');
    initBubble();

    // Phase 2: load scene viewer silently in background.
    // Double-tap gesture checks sceneLoaded before entering fullscreen.
    loadSceneViewer(THREE, Spark, params).catch(err => {
      console.warn('Scene viewer background load failed:', err);
    });
  } catch (err) {
    console.error('Init failed:', err);
    loadingScreen.classList.add('hidden');
    if (pageBg) pageBg.classList.add('visible');
    showError('加载失败: ' + err.message);
  }
}

init();
