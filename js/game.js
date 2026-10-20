// ---------------------------------------------------------------------------
// GAME LOGIC — a real 3D scene via Three.js, one continuous map (no more
// separate exterior/interior spaces or teleport-style transitions). Walking
// through the open front door just continues into the same physical world.
// Screens: title -> story -> explore (with an optional detour to settings
// or the pause menu). World coordinates: grid (x, y) maps directly to
// world (X, Z); Y is vertical (up).
// ---------------------------------------------------------------------------

const state = {
  phase: "title", // "title" | "story" | "settings" | "explore" | "paused"
  flags: {},
  log: [],
  activeNpc: null,
  dialogueNode: "start",
  settings: { showPrompts: true, soundOn: true },
  settingsReturnTo: "title", // "title" | "paused" — where the Back button goes
  inventory: {}, // itemId -> true, once picked up
  flashlightOn: false,
  batteryLevel: 100, // 0-100, drains while the flashlight is on
  frontDoorOpen: false,
  doorsOpen: {},
  entity: { mode: "idle", timer: 0, x: 0, z: 0, beat: 0 },
};

const keys = new Set();

const MOVE_SPEED = 2.6; // world units per second
const MOUSE_SENSITIVITY = 0.0022;
const PITCH_LIMIT = 1.3; // radians, keeps the camera from flipping past vertical
const PLAYER_RADIUS = 0.24;
const INTERACT_DIST = 1.15;
const EYE_HEIGHT = 1.5;
const WALL_HEIGHT = 3;
const DOOR_OPEN_ANGLE = -Math.PI * 0.62; // swings inward, like a real hinge
const DOOR_OPEN_SPEED = 2.4; // radians/second
const DOOR_ROW = Math.floor(FRONT_DOOR.y); // row 6 — everything south of this is "the street"

// Vision range indoors: full range while the flashlight is on and has
// charge, a short oppressive range otherwise — drives real Three.js fog
// distance. Outdoors always uses the dimmer, moonlit street range.
const LIT_RANGE = 12;
const DARK_RANGE = 2.6;
const MOON_RANGE = 12;
const FACADE_H = 9; // the street-facing walls are three storeys tall

// Battery drains fully after this many seconds of continuous use.
const BATTERY_LIFE_SECONDS = 180;
const BATTERY_DRAIN_RATE = 100 / BATTERY_LIFE_SECONDS;

function hasFlashlightOn() {
  return !!(state.inventory.flashlight && state.batteryLevel > 0 && state.flashlightOn);
}

function currentLightRange() {
  return hasFlashlightOn() ? LIT_RANGE : DARK_RANGE;
}

function isOutside() {
  return yawObject.position.z >= DOOR_ROW;
}

// ---- audio (procedural, Web Audio) --------------------------------------------

let audioCtx = null;
let ambientGains = [];
let footstepTimer = 0;
let noiseBuf = null;

function initAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  noiseBuf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.1), audioCtx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  [54, 55.7].forEach((f) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.value = state.settings.soundOn ? 0.03 : 0;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    ambientGains.push(g);
  });
}

function setSoundEnabled(on) {
  state.settings.soundOn = on;
  ambientGains.forEach((g) => (g.gain.value = on ? 0.03 : 0));
}

function audioReady() {
  if (!audioCtx || !state.settings.soundOn) return false;
  if (audioCtx.state === "suspended") audioCtx.resume();
  return true;
}

function playFootstep(quiet) {
  if (!audioReady()) return;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuf;
  const lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 260 + Math.random() * 140;
  const g = audioCtx.createGain();
  g.gain.value = quiet ? 0.07 : 0.12;
  src.connect(lp).connect(g).connect(audioCtx.destination);
  src.start();
}

function playDoorCreak() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(180, t);
  o.frequency.linearRampToValueAtTime(85, t + 1.1);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.05, t + 0.3);
  g.gain.linearRampToValueAtTime(0.0001, t + 1.1);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 1.15);
}

function playClick() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "square";
  o.frequency.value = 900;
  g.gain.setValueAtTime(0.05, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 0.05);
}

function playHeartbeat(strength) {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  [0, 0.17].forEach((off, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(95, t + off);
    o.frequency.exponentialRampToValueAtTime(55, t + off + 0.14);
    const peak = (0.12 + 0.18 * strength) * (i ? 0.7 : 1);
    g.gain.setValueAtTime(0.0001, t + off);
    g.gain.linearRampToValueAtTime(peak, t + off + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.16);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + off);
    o.stop(t + off + 0.2);
  });
}

function playSting() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(35, t + 0.9);
  g.gain.setValueAtTime(0.25, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 0.95);
  const n = audioCtx.createBufferSource();
  const ng = audioCtx.createGain();
  n.buffer = noiseBuf;
  n.loop = true;
  ng.gain.setValueAtTime(0.15, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  n.connect(ng).connect(audioCtx.destination);
  n.start(t);
  n.stop(t + 0.65);
}

function playKnock() {
  playFootstep(false);
  setTimeout(() => playFootstep(false), 140);
}

function toggleFlashlight() {
  if (!state.inventory.flashlight) {
    return;
  }
  if (state.batteryLevel <= 0) {
    return;
  }
  state.flashlightOn = !state.flashlightOn;
  playClick();
  renderHud();
}

// ---- captions: short lines at the bottom middle that fade away ----------------

let captionQueue = [];
let captionBusy = false;
let captionTimer = null;

function queueCaption(text) {
  captionQueue.push(text);
  if (captionQueue.length > 3) captionQueue.shift();
  if (!captionBusy) showNextCaption();
}

function showNextCaption() {
  const el = document.getElementById("caption");
  const text = captionQueue.shift();
  if (!text) {
    captionBusy = false;
    el.style.opacity = "0";
    return;
  }
  captionBusy = true;
  el.textContent = text;
  el.style.opacity = "1";
  const hold = 2600 + text.length * 45;
  captionTimer = setTimeout(() => {
    el.style.opacity = "0";
    captionTimer = setTimeout(showNextCaption, 700); // let it fade before the next line
  }, hold);
}

function clearCaptions() {
  captionQueue = [];
  captionBusy = false;
  clearTimeout(captionTimer);
  document.getElementById("caption").style.opacity = "0";
}

function addLog(entry) {
  state.log.unshift(entry);
  state.log = state.log.slice(0, 6);
  queueCaption(entry);
}

// ---- screen switching -----------------------------------------------------

function showScreen(id) {
  ["screen-title", "screen-settings", "Story-screen", "screen-explore"].forEach((s) => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

// ---- title screen -----------------------------------------------------------

function resetRun() {
  state.flags = {};
  state.log = [];
  state.inventory = {};
  state.flashlightOn = false;
  state.batteryLevel = 100;
  state.frontDoorOpen = false;
  state.doorsOpen = {};
  flashlightCurrentIntensity = 0;
  flashlightFlickerTimer = 0;
  state.activeNpc = null;
  state.dialogueNode = "start";
  state.entity = { mode: "idle", timer: 0, x: 0, z: 0, beat: 0 };
  entityGroup.visible = false;
  setFear(0);
  keys.clear();
  clearCaptions();
}

document.getElementById("title-start-button").addEventListener("click", () => {
  initAudio();
  resetRun();
  state.phase = "story";
  showScreen("Story-screen");
  document.getElementById("Story-screen").classList.add("fade-in");
  typeStory();
});

document.getElementById("title-settings-button").addEventListener("click", () => {
  state.settingsReturnTo = "title";
  state.phase = "settings";
  showScreen("screen-settings");
  renderSettings();
});

document.getElementById("settings-back-button").addEventListener("click", () => {
  if (state.settingsReturnTo === "paused") {
    state.phase = "paused";
    showScreen("screen-explore");
  } else {
    state.phase = "title";
    showScreen("screen-title");
  }
});

// ---- pause menu ---------------------------------------------------------------

function openPauseMenu() {
  state.phase = "paused";
  keys.clear();
  document.getElementById("pause-overlay").classList.remove("hidden");
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }
}

function closePauseMenu() {
  document.getElementById("pause-overlay").classList.add("hidden");
  state.phase = "explore";
  renderer.domElement.requestPointerLock();
}

document.getElementById("pause-resume-button").addEventListener("click", closePauseMenu);

document.getElementById("pause-settings-button").addEventListener("click", () => {
  state.settingsReturnTo = "paused";
  showScreen("screen-settings");
  renderSettings();
});

document.getElementById("pause-leave-button").addEventListener("click", () => {
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }
  document.getElementById("pause-overlay").classList.add("hidden");
  state.phase = "title";
  showScreen("screen-title");
});

// ---- settings screen ---------------------------------------------------------

function renderSettings() {
  const btn = document.getElementById("toggle-prompts");
  btn.textContent = state.settings.showPrompts ? "On" : "Off";
  btn.className = "toggle-button " + (state.settings.showPrompts ? "on" : "off");
  const sb = document.getElementById("toggle-sound");
  sb.textContent = state.settings.soundOn ? "On" : "Off";
  sb.className = "toggle-button " + (state.settings.soundOn ? "on" : "off");
}

document.getElementById("toggle-sound").addEventListener("click", () => {
  initAudio();
  setSoundEnabled(!state.settings.soundOn);
  renderSettings();
});

document.getElementById("toggle-prompts").addEventListener("click", () => {
  state.settings.showPrompts = !state.settings.showPrompts;
  renderSettings();
});

// ---- HUD / log --------------------------------------------------------------

function renderHud() {
  const hud = document.getElementById("hud");
  const carried = Object.keys(state.inventory).filter((id) => state.inventory[id]);
  const carriedNames = carried
    .map((id) => (ITEMS.find((it) => it.id === id) || {}).name || id)
    .join(" · ");
  const flashlightStatus = hasFlashlightOn()
    ? "ON"
    : state.inventory.flashlight
    ? state.batteryLevel <= 0
      ? "dead"
      : "OFF (press F)"
    : "none";
  hud.innerHTML = `
    <div class="portrait" style="background:${PROTAGONIST.color}">${PROTAGONIST.name.charAt(0)}</div>
    <div>
      <div class="hud-name">${PROTAGONIST.name}</div>
      <div class="stat-line">Carrying: ${carriedNames || "nothing"}</div>
      <div class="stat-line">Flashlight: ${flashlightStatus}</div>
    </div>
  `;
}

// ---- story screen -------------------------------------------------

document.getElementById("Story-screen").addEventListener("click", () => {
  if (state.phase !== "story") return;

  const textEl = document.getElementById("story-text");
  const promptEl = document.getElementById("story-prompt");
  if (textEl.textContent.length < storyString.length) {
    clearInterval(typeInterval);
    textEl.textContent = storyString;
    promptEl.classList.remove("hidden");
    return;
  }
  enterExplore();
});

function enterExplore() {
  state.phase = "explore";
  showScreen("screen-explore");
  yawObject.position.set(PLAYER_START.x, EYE_HEIGHT, PLAYER_START.y);
  yawObject.rotation.y = 0;
  camera.rotation.x = 0;
  buildWorld();
  renderHud();
  clock.start();
  renderer.setAnimationLoop(gameLoop);
  renderer.domElement.requestPointerLock();
}

// ---- typewriter effect ------------------------------------------------------

const storyString = PROTAGONIST.storyIntro;
let typeInterval;

function typeStory() {
  const textEl = document.getElementById("story-text");
  const promptEl = document.getElementById("story-prompt");
  textEl.textContent = "";
  promptEl.classList.add("hidden");
  let i = 0;
  clearInterval(typeInterval);
  typeInterval = setInterval(() => {
    textEl.textContent += storyString.charAt(i);
    i++;
    if (i >= storyString.length) {
      clearInterval(typeInterval);
      setTimeout(() => promptEl.classList.remove("hidden"), 1000);
    }
  }, 80);
}

// ---- Three.js scene setup -----------------------------------------------------

const canvas = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x000000, 0.1, DARK_RANGE);
scene.background = new THREE.Color(0x0b0a0d);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 100);
const yawObject = new THREE.Object3D();
yawObject.add(camera);
scene.add(yawObject);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.06);
scene.add(ambientLight);

// A faint cold moon, only switched on outside (so it never leaks indoors).
const moonLight = new THREE.DirectionalLight(0x5566aa, 0);
moonLight.position.set(8.5, 25, 30);
scene.add(moonLight);

const flashlightLight = new THREE.SpotLight(0xfff2d0, 0, 9, Math.PI / 6.5, 0.5, 1.1);
flashlightLight.position.set(0, 0, 0);
camera.add(flashlightLight);
camera.add(flashlightLight.target);
flashlightLight.target.position.set(0, 0, -1);

const FLASHLIGHT_MAX_INTENSITY = 2.4;
const FLASHLIGHT_RAMP_SPEED = 7; // intensity/second — fast but not an instant snap
let flashlightCurrentIntensity = 0;
let flashlightFlickerTimer = 0;

const worldGroup = new THREE.Group();
scene.add(worldGroup);
let doorPivots = {}; // id -> hinge group, set in buildWorld(); drives the swing animation
let deskLamp = null; // set in buildWorld(); flickers in the game loop
let deskLampFlickerTimer = 0;

function resizeRenderer() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
resizeRenderer();
window.addEventListener("resize", resizeRenderer);

// ---- textures (procedurally generated, no image files needed) -----------------

const TEXTURE_SIZE = 128;

function makeThreeTexture(canvasEl) {
  const tex = new THREE.CanvasTexture(canvasEl);
  tex.magFilter = THREE.NearestFilter; // crisp, no blur
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

function createInteriorWallTexture() {
  const c = document.createElement("canvas");
  c.width = TEXTURE_SIZE;
  c.height = TEXTURE_SIZE;
  const t = c.getContext("2d");
  t.fillStyle = "#141010";
  t.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const brickW = 32;
  const brickH = 16;
  for (let y = 0; y < TEXTURE_SIZE; y += brickH) {
    const offset = (y / brickH) % 2 === 0 ? 0 : brickW / 2;
    for (let x = -brickW; x < TEXTURE_SIZE + brickW; x += brickW) {
      const shade = 42 + Math.floor(Math.random() * 16);
      t.fillStyle = `rgb(${shade + 16}, ${shade + 9}, ${shade})`;
      t.fillRect(x + offset + 1, y + 1, brickW - 2, brickH - 2);
    }
  }
  for (let i = 0; i < 7; i++) {
    t.fillStyle = `rgba(15, 10, 10, ${0.15 + Math.random() * 0.25})`;
    t.beginPath();
    t.arc(Math.random() * TEXTURE_SIZE, Math.random() * TEXTURE_SIZE, 8 + Math.random() * 18, 0, Math.PI * 2);
    t.fill();
  }
  return c;
}

function createExteriorWallTexture() {
  const c = document.createElement("canvas");
  c.width = TEXTURE_SIZE;
  c.height = TEXTURE_SIZE;
  const t = c.getContext("2d");
  t.fillStyle = "#26302a";
  t.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const panel = 64;
  for (let y = 0; y < TEXTURE_SIZE; y += panel) {
    for (let x = 0; x < TEXTURE_SIZE; x += panel) {
      const shade = 28 + Math.floor(Math.random() * 10);
      t.fillStyle = `rgb(${shade + 8}, ${shade + 12}, ${shade + 9})`;
      t.fillRect(x + 2, y + 2, panel - 4, panel - 4);
    }
  }
  for (let i = 0; i < 5; i++) {
    t.fillStyle = `rgba(10, 14, 11, ${0.15 + Math.random() * 0.2})`;
    t.fillRect(Math.random() * TEXTURE_SIZE, 0, 4 + Math.random() * 6, TEXTURE_SIZE);
  }
  const winW = 22;
  const winH = 18;
  [[20, 12], [76, 12], [20, 68], [76, 68]].forEach(([wx, wy]) => {
    const lit = Math.random() < 0.4;
    t.fillStyle = lit ? "rgba(255, 195, 110, 0.65)" : "rgba(8, 10, 10, 0.8)";
    t.fillRect(wx, wy, winW, winH);
    t.strokeStyle = "rgba(15, 18, 15, 0.7)";
    t.lineWidth = 2;
    t.strokeRect(wx, wy, winW, winH);
  });
  return c;
}

// Every door in the building: the front door plus the interior doors.
function doorList() {
  return [Object.assign({ isFront: true }, FRONT_DOOR)].concat(DOORS);
}
function isDoorOpen(door) {
  return door.isFront ? state.frontDoorOpen : !!state.doorsOpen[door.id];
}
function doorAtCell(col, row) {
  return doorList().find((d) => Math.floor(d.x) === col && Math.floor(d.y) === row) || null;
}

function createDoorTexture(plate = FRONT_DOOR.plateNumber, base = "#7c847a") {
  const c = document.createElement("canvas");
  c.width = TEXTURE_SIZE;
  c.height = TEXTURE_SIZE;
  const t = c.getContext("2d");
  const S = TEXTURE_SIZE;
  t.fillStyle = base;
  t.fillRect(0, 0, S, S);
  if (plate) {
    t.fillStyle = "rgba(20, 20, 16, 0.85)";
    t.font = `${Math.max(6, S * 0.06)}px "Courier New", monospace`;
    t.textAlign = "center";
    t.textBaseline = "top";
    t.fillText(plate, S / 2, S * 0.02);
  }
  const winX = S * 0.16;
  const winY = S * 0.08;
  const winW = S * 0.68;
  const winH = S * 0.26;
  t.fillStyle = "rgba(195, 210, 200, 0.6)";
  t.fillRect(winX, winY, winW, winH);
  t.strokeStyle = "rgba(35, 38, 33, 0.9)";
  t.lineWidth = 2;
  t.strokeRect(winX, winY, winW, winH);
  t.beginPath();
  t.moveTo(winX + winW / 2, winY);
  t.lineTo(winX + winW / 2, winY + winH);
  t.moveTo(winX, winY + winH / 3);
  t.lineTo(winX + winW, winY + winH / 3);
  t.moveTo(winX, winY + (winH * 2) / 3);
  t.lineTo(winX + winW, winY + (winH * 2) / 3);
  t.stroke();
  const dividerY = S * 0.4;
  t.fillStyle = "rgba(40, 42, 36, 0.65)";
  t.fillRect(0, dividerY, S, S * 0.02);
  const medX = S / 2;
  const medY = S * 0.66;
  const medR = S * 0.14;
  t.strokeStyle = "rgba(20, 20, 18, 0.9)";
  t.lineWidth = 2;
  t.beginPath();
  t.arc(medX, medY, medR, 0, Math.PI * 2);
  t.stroke();
  [0, 1, 2, 3].forEach((i) => {
    const angle = (Math.PI / 2) * i + Math.PI / 4;
    const cx = medX + Math.cos(angle) * medR * 1.3;
    const cy = medY + Math.sin(angle) * medR * 1.3;
    t.beginPath();
    t.arc(cx, cy, medR * 0.35, 0, Math.PI * 1.5);
    t.stroke();
  });
  t.fillStyle = "#9a9484";
  t.fillRect(S * 0.62, S * 0.58, S * 0.05, S * 0.09);
  return c;
}

// Door textures are drawn on a square canvas but shown on a 0.85 x 2.55 door,
// so anything drawn is stretched 3x vertically. These helpers compensate.
function ell(t, cx, cy, rx) {
  t.beginPath();
  t.ellipse(cx, cy, rx, rx / 3, 0, 0, Math.PI * 2);
}
function flatText(t, text, cx, cy, size, color) {
  t.save();
  t.translate(cx, cy);
  t.scale(1, 1 / 3);
  t.fillStyle = color;
  t.font = `bold ${size}px "Courier New", monospace`;
  t.textAlign = "center";
  t.textBaseline = "middle";
  t.fillText(text, 0, 0);
  t.restore();
}

function createStyledDoorTexture(style, plate, base) {
  const S = TEXTURE_SIZE;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const t = c.getContext("2d");
  t.fillStyle = base;
  t.fillRect(0, 0, S, S);
  const shade = (x, y, w, h, a) => {
    t.fillStyle = a > 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${-a})`;
    t.fillRect(x * S, y * S, w * S, h * S);
  };
  if (style === "wood") {
    [[0.1, 0.07], [0.54, 0.07], [0.1, 0.5], [0.54, 0.5]].forEach(([x, y]) => {
      const h = y < 0.3 ? 0.34 : 0.42;
      shade(x, y, 0.36, h, -0.22);
      shade(x + 0.02, y + 0.012, 0.32, h - 0.024, 0.07);
    });
    shade(0, 0, 0.03, 1, -0.3);
    shade(0.97, 0, 0.03, 1, -0.3);
    t.fillStyle = "#b89a52";
    t.fillRect(S * 0.36, S * 0.425, S * 0.28, S * 0.06);
    flatText(t, plate || "", S * 0.5, S * 0.455, S * 0.2, "#2a1f0c");
    ell(t, S * 0.5, S * 0.3, S * 0.035);
    t.fillStyle = "#0c0a08";
    t.fill();
    t.strokeStyle = "#b89a52";
    t.lineWidth = 1;
    t.stroke();
    ell(t, S * 0.85, S * 0.53, S * 0.035);
    t.fillStyle = "#c9ab5f";
    t.fill();
  } else if (style === "hall") {
    shade(0.14, 0.07, 0.72, 0.38, 0.28); // frosted glass
    t.strokeStyle = "rgba(20,16,12,0.9)";
    t.lineWidth = 2;
    t.strokeRect(S * 0.14, S * 0.07, S * 0.72, S * 0.38);
    t.beginPath();
    t.moveTo(S * 0.5, S * 0.07);
    t.lineTo(S * 0.5, S * 0.45);
    t.moveTo(S * 0.14, S * 0.26);
    t.lineTo(S * 0.86, S * 0.26);
    t.stroke();
    shade(0.14, 0.55, 0.72, 0.36, -0.2);
    shade(0.16, 0.565, 0.68, 0.33, 0.06);
    ell(t, S * 0.85, S * 0.52, S * 0.035);
    t.fillStyle = "#c9ab5f";
    t.fill();
  } else if (style === "metal") {
    for (let i = 0; i < 14; i++) shade(0, i / 14, 1, 0.012, -0.25);
    shade(0, 0, 0.03, 1, -0.3);
    shade(0.97, 0, 0.03, 1, -0.3);
    flatText(t, "STAFF", S * 0.5, S * 0.26, S * 0.22, "rgba(15,15,15,0.8)");
    flatText(t, "ONLY", S * 0.5, S * 0.34, S * 0.22, "rgba(15,15,15,0.8)");
    for (let i = 0; i < 10; i++) {
      t.fillStyle = i % 2 ? "#151512" : "#b99a2a";
      t.fillRect(S * i * 0.1, S * 0.92, S * 0.1, S * 0.05);
    }
    t.fillStyle = "#c8ccd0";
    t.fillRect(S * 0.74, S * 0.5, S * 0.1, S * 0.03);
  } else if (style === "fire") {
    shade(0.22, 0.08, 0.56, 0.2, 0.3);
    t.strokeStyle = "rgba(10,20,14,0.9)";
    t.lineWidth = 2;
    t.strokeRect(S * 0.22, S * 0.08, S * 0.56, S * 0.2);
    for (let i = 1; i < 4; i++) {
      t.beginPath();
      t.moveTo(S * (0.22 + 0.14 * i), S * 0.08);
      t.lineTo(S * (0.22 + 0.14 * i), S * 0.28);
      t.stroke();
    }
    flatText(t, "STAIRS", S * 0.5, S * 0.4, S * 0.2, "rgba(225,225,215,0.85)");
    t.fillStyle = "#c8ccd0";
    t.fillRect(S * 0.12, S * 0.55, S * 0.76, S * 0.025);
    shade(0, 0.88, 1, 0.12, -0.3);
  } else if (style === "elevator") {
    for (let i = 0; i < 40; i++) shade(Math.random(), 0, 0.006, 1, Math.random() < 0.5 ? 0.06 : -0.06);
    shade(0.49, 0, 0.02, 1, -0.55);
    shade(0.38, 0.03, 0.24, 0.035, -0.5);
    t.fillStyle = "rgba(200,130,40,0.45)";
    t.fillRect(S * 0.46, S * 0.04, S * 0.08, S * 0.015);
    shade(0.86, 0.46, 0.1, 0.1, -0.5);
    ell(t, S * 0.91, S * 0.5, S * 0.02);
    t.fillStyle = "rgba(200,130,40,0.5)";
    t.fill();
  }
  return c;
}

const interiorWallTexture = makeThreeTexture(createInteriorWallTexture());
const exteriorWallTexture = makeThreeTexture(createExteriorWallTexture());
// Tall street-side walls repeat the exterior texture once per storey.
const facadeTexture = makeThreeTexture(createExteriorWallTexture());
facadeTexture.wrapS = THREE.RepeatWrapping;
facadeTexture.wrapT = THREE.RepeatWrapping;
facadeTexture.repeat.set(1, 3);
const doorTexture = makeThreeTexture(createDoorTexture());
const doorTextures = { frontDoor: doorTexture };
DOORS.forEach((d) => {
  doorTextures[d.id] = makeThreeTexture(createStyledDoorTexture(d.style, d.plate, d.baseColor));
});

function makeColorTexture(hex) {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const t = c.getContext("2d");
  t.fillStyle = hex;
  t.fillRect(0, 0, 8, 8);
  return makeThreeTexture(c);
}

// ---- world building -------------------------------------------------------

function disposeWorld() {
  worldGroup.children.slice().forEach((obj) => {
    worldGroup.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material && obj.userData.disposeMaterial) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  });
}

function buildWorld() {
  disposeWorld();
  doorPivots = {};
  deskLamp = null;

  const rows = MAP.length;
  const cols = MAP[0].length;
  const interiorMat = new THREE.MeshStandardMaterial({ map: interiorWallTexture, roughness: 0.95 });
  const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTexture, roughness: 0.95 });
  const facadeGeo = new THREE.BoxGeometry(1, FACADE_H, 1);
  const wallGeo = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);

  const doorCol = Math.floor(FRONT_DOOR.x);
  const doorRow = Math.floor(FRONT_DOOR.y);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (MAP[row][col] !== 1) continue;
      if (doorAtCell(col, row)) continue; // door cells are drawn separately below
      const street = row >= doorRow;
      const mesh = new THREE.Mesh(street ? facadeGeo : wallGeo, street ? facadeMat : interiorMat);
      mesh.position.set(col + 0.5, (street ? FACADE_H : WALL_HEIGHT) / 2, row + 0.5);
      worldGroup.add(mesh);
    }
  }

  // Two floor strips — dark interior floor north of the door, cold street
  // ground south of it — plus one continuous ceiling.
  const interiorRows = doorRow + 1;
  const interiorFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(cols, interiorRows),
    new THREE.MeshStandardMaterial({ color: 0x3a3228, roughness: 1 })
  );
  interiorFloor.rotation.x = -Math.PI / 2;
  interiorFloor.position.set(cols / 2, 0, interiorRows / 2);
  worldGroup.add(interiorFloor);

  const streetRows = rows - doorRow;
  const streetFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(cols, streetRows),
    new THREE.MeshStandardMaterial({ color: 0x232c1f, roughness: 1 })
  );
  streetFloor.rotation.x = -Math.PI / 2;
  streetFloor.position.set(cols / 2, 0, doorRow + streetRows / 2);
  worldGroup.add(streetFloor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(cols, interiorRows),
    new THREE.MeshStandardMaterial({ color: 0x16161e, side: THREE.BackSide })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cols / 2, WALL_HEIGHT, interiorRows / 2);
  worldGroup.add(ceiling);

  // Roof: a cornice that overhangs the facade, and a pitched slope behind it.
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 1, side: THREE.DoubleSide });
  const cornice = new THREE.Mesh(new THREE.BoxGeometry(cols, 0.35, 1.6), roofMat);
  cornice.position.set(cols / 2, FACADE_H + 0.17, doorRow + 0.6);
  worldGroup.add(cornice);
  const tilt = 0.35;
  const eaveZ = doorRow + 0.6;
  const ridgeZ = 3;
  const run = eaveZ - ridgeZ;
  const slope = new THREE.Mesh(new THREE.PlaneGeometry(cols, run / Math.cos(tilt)), roofMat);
  slope.rotation.x = tilt - Math.PI / 2;
  slope.position.set(cols / 2, FACADE_H + 0.35 + (run * Math.tan(tilt)) / 2, (eaveZ + ridgeZ) / 2);
  worldGroup.add(slope);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 0.9), roofMat);
  chimney.position.set(13.5, FACADE_H + 1.6, 8.5);
  worldGroup.add(chimney);

  // Every door is a real hinged pivot, not a texture trick.
  const doorW = 0.85;
  const doorH = WALL_HEIGHT * 0.85;
  const doorGeo = new THREE.BoxGeometry(doorW, doorH, 0.14);
  doorList().forEach((door) => {
    const mat = new THREE.MeshStandardMaterial({ map: doorTextures[door.id], roughness: 0.85 });
    const mesh = new THREE.Mesh(doorGeo, mat);
    mesh.position.set(doorW / 2, 0, 0);
    const pivot = new THREE.Group();
    pivot.position.set(door.x - doorW / 2, doorH / 2, door.y);
    pivot.rotation.y = isDoorOpen(door) ? DOOR_OPEN_ANGLE : 0;
    pivot.add(mesh);
    worldGroup.add(pivot);
    doorPivots[door.id] = pivot;
  });

  // Fill the gap above each door so no door has an open slot over it.
  doorList().forEach((door) => {
    const top = door.isFront ? FACADE_H : WALL_HEIGHT;
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(1, top - doorH, 1),
      door.isFront ? facadeMat : interiorMat
    );
    lintel.position.set(Math.floor(door.x) + 0.5, doorH + (top - doorH) / 2, Math.floor(door.y) + 0.5);
    worldGroup.add(lintel);
  });

  const doorGlow = new THREE.PointLight(0xc3e182, 1.4, 5, 2);
  doorGlow.position.set(FRONT_DOOR.x, WALL_HEIGHT * 0.8, FRONT_DOOR.y);
  worldGroup.add(doorGlow);

  // The only other light outside: one street lamp, off to the side.
  addStreetLight(5.5, 16);

  // The first thing you see on the left, just past the door.
  addReceptionDesk(5.5, 12.0);
  addMailboxes(1.1, 8.8);
  addSofa(13.5, 11.6);
  addPlant(14.7, 8.7);
  addPlant(1.6, 12.3);
  addRunner(8.5, 5.5, 13, 1.1);
  addBed(14.5, 1.6); // John's apartment
  addTable(6.5, 1.5); // apartment 2, where the key is
  addChair(5.4, 2.3);
  const aptLight = new THREE.PointLight(0xffbb66, 0.35, 3.5, 2);
  aptLight.position.set(6.5, 2.4, 2.2);
  worldGroup.add(aptLight);

  // One weak, cold bulb in the hallway so it isn't a total void.
  [4.5, 8.5, 12.5].forEach((hx) => {
    const hallLight = new THREE.PointLight(0x8fa0b8, 0.3, 6, 2);
    hallLight.position.set(hx, WALL_HEIGHT * 0.9, 5.5);
    worldGroup.add(hallLight);
  });

  NPCS.forEach((npc) => addMarkerSprite(npc.x, npc.y, npc.color, 0.9));
  ITEMS.filter((it) => !state.inventory[it.id]).forEach((it) =>
    addMarkerSprite(it.x, it.y, it.color, 0.4, it.height)
  );
}

// A single street lamp: a dark pole, a lamp head, and a real warm light
// source — meant to be one of only two visible light sources on an
// otherwise empty, dark street (the other being the door's glow).
function addStreetLight(x, z) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1a, roughness: 0.8 });
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.6, 0.08), poleMat);
  pole.position.set(x, 1.3, z);
  worldGroup.add(pole);

  const headMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a26,
    emissive: 0x554422,
    emissiveIntensity: 0.5,
  });
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.32), headMat);
  head.position.set(x, 2.62, z);
  worldGroup.add(head);

  const lamp = new THREE.PointLight(0xffdca0, 1.9, 7, 2);
  lamp.position.set(x, 2.55, z);
  worldGroup.add(lamp);
}

// A creepy old reception desk: a dark, worn desk with a single dim,
// flickering lamp — barely enough light to see the desk itself, let alone
// the room around it.
function addReceptionDesk(x, z) {
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x241f18, roughness: 0.9 });
  const desk = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.75, 0.6), deskMat);
  desk.position.set(x, 0.375, z);
  worldGroup.add(desk);

  const lampBaseMat = new THREE.MeshStandardMaterial({ color: 0x171512 });
  const lampBase = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.32, 0.07), lampBaseMat);
  lampBase.position.set(x + 0.4, 0.75 + 0.16, z - 0.15);
  worldGroup.add(lampBase);

  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0x332211,
    emissive: 0xffbb55,
    emissiveIntensity: 1.3,
  });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), bulbMat);
  bulb.position.set(x + 0.4, 0.75 + 0.34, z - 0.15);
  worldGroup.add(bulb);

  deskLamp = new THREE.PointLight(0xffbb55, 0.8, 3, 2.4);
  deskLamp.position.set(x + 0.4, 0.75 + 0.38, z - 0.15);
  worldGroup.add(deskLamp);
}

function addBox(w, h, d, x, y, z, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 1 }));
  m.position.set(x, y, z);
  worldGroup.add(m);
  return m;
}

// A block of metal mailboxes on the lobby's west wall.
function addMailboxes(x, z) {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 6; c++) {
      addBox(0.14, 0.22, 0.34, x, 1.0 + r * 0.26, z + c * 0.38, r ? 0x3d4146 : 0x35393d);
    }
  }
}

function addSofa(x, z) {
  addBox(1.8, 0.4, 0.8, x, 0.2, z, 0x2b2220);
  addBox(1.8, 0.55, 0.2, x, 0.65, z + 0.35, 0x251d1b);
  addBox(0.2, 0.55, 0.8, x - 0.9, 0.45, z, 0x251d1b);
  addBox(0.2, 0.55, 0.8, x + 0.9, 0.45, z, 0x251d1b);
}

function addPlant(x, z) {
  addBox(0.35, 0.4, 0.35, x, 0.2, z, 0x2a2018);
  const leaves = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x1d3320, roughness: 1 })
  );
  leaves.position.set(x, 0.75, z);
  worldGroup.add(leaves);
}

function addRunner(cx, cz, length, width) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(length, width),
    new THREE.MeshStandardMaterial({ color: 0x3a1414, roughness: 1 })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(cx, 0.012, cz);
  worldGroup.add(m);
}

function addTable(x, z) {
  addBox(0.9, 0.75, 0.6, x, 0.375, z, 0x2e2419);
}

function addChair(x, z) {
  addBox(0.42, 0.45, 0.42, x, 0.225, z, 0x241c15);
  addBox(0.42, 0.45, 0.06, x, 0.68, z + 0.18, 0x241c15);
}

// A plain, unmade bed in John's room.
function addBed(x, z) {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.4, 0.9),
    new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 1 })
  );
  frame.position.set(x, 0.2, z);
  worldGroup.add(frame);
  const sheet = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.12, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x59544a, roughness: 1 })
  );
  sheet.position.set(x, 0.46, z);
  worldGroup.add(sheet);
}

function addMarkerSprite(x, y, colorHex, scale, height) {
  const mat = new THREE.SpriteMaterial({ map: makeColorTexture(colorHex) });
  const sprite = new THREE.Sprite(mat);
  sprite.userData.disposeMaterial = true;
  sprite.scale.set(scale, scale, 1);
  sprite.position.set(x, height !== undefined ? height : EYE_HEIGHT * 0.55, y);
  worldGroup.add(sprite);
}

// ---- collision + movement ---------------------------------------------------

function isWall(x, y) {
  const col = Math.floor(x);
  const row = Math.floor(y);
  if (row < 0 || row >= MAP.length || col < 0 || col >= MAP[0].length) return true;
  // The front door's cell is solid until it's been opened — this always
  // takes precedence over the map's own value there.
  const door = doorAtCell(col, row);
  if (door) return !isDoorOpen(door);
  return MAP[row][col] === 1;
}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function tryMovePlayer(dt) {
  if (state.activeNpc) return; // frozen mid-dialogue

  let forwardInput = 0;
  if (keys.has("w") || keys.has("arrowup")) forwardInput += 1;
  if (keys.has("s") || keys.has("arrowdown")) forwardInput -= 1;
  let strafeInput = 0;
  if (keys.has("d")) strafeInput += 1;
  if (keys.has("a")) strafeInput -= 1;
  if (keys.has("arrowleft")) yawObject.rotation.y += 1.6 * dt;
  if (keys.has("arrowright")) yawObject.rotation.y -= 1.6 * dt;

  if (forwardInput === 0 && strafeInput === 0) {
    footstepTimer = 0.3; // first step lands quickly after starting to walk
    return;
  }
  footstepTimer += dt;
  if (footstepTimer >= 0.45) {
    footstepTimer = 0;
    playFootstep(isOutside());
  }

  camera.getWorldDirection(_forward);
  _forward.y = 0;
  _forward.normalize();
  _right.crossVectors(_forward, _up).normalize();

  const moveX = (_forward.x * forwardInput + _right.x * strafeInput) * MOVE_SPEED * dt;
  const moveZ = (_forward.z * forwardInput + _right.z * strafeInput) * MOVE_SPEED * dt;

  const nx = yawObject.position.x + moveX;
  const nz = yawObject.position.z + moveZ;
  if (!isWall(nx + Math.sign(moveX || 1) * PLAYER_RADIUS, yawObject.position.z)) {
    yawObject.position.x = nx;
  }
  if (!isWall(yawObject.position.x, nz + Math.sign(moveZ || 1) * PLAYER_RADIUS)) {
    yawObject.position.z = nz;
  }
}

function checkJohnRoom() {
  if (state.flags.enteredJohnRoom) return;
  const p = yawObject.position;
  if (p.x > JOHN_ROOM.minX && p.x < JOHN_ROOM.maxX && p.z > JOHN_ROOM.minY && p.z < JOHN_ROOM.maxY) {
    state.flags.enteredJohnRoom = true;
    state.entity.mode = "done";
    entityGroup.visible = false;
    setFear(0);
  }
}

function updateDoorAnimation(dt) {
  doorList().forEach((door) => {
    const pivot = doorPivots[door.id];
    if (!pivot) return;
    const target = isDoorOpen(door) ? DOOR_OPEN_ANGLE : 0;
    const current = pivot.rotation.y;
    if (Math.abs(target - current) < 0.001) {
      pivot.rotation.y = target;
      return;
    }
    const step = DOOR_OPEN_SPEED * dt;
    pivot.rotation.y = target > current ? Math.min(target, current + step) : Math.max(target, current - step);
  });
}

function updateDeskLampFlicker(dt) {
  if (!deskLamp) return;
  deskLampFlickerTimer += dt;
  if (deskLampFlickerTimer > 0.13) {
    deskLampFlickerTimer = 0;
    deskLamp.intensity = 0.5 + Math.random() * 0.55;
  }
}

// Drains the battery while genuinely on, smoothly ramps the light's actual
// intensity toward its target instead of snapping instantly (a real
// flashlight has a beat of inertia switching on/off), and adds an erratic
// flicker once the charge is nearly gone — the visual cue that it's about
// to die, before it actually does.
function updateFlashlight(dt) {
  const wantsOn = hasFlashlightOn();

  if (wantsOn) {
    state.batteryLevel = Math.max(0, state.batteryLevel - BATTERY_DRAIN_RATE * dt);
    if (state.batteryLevel <= 0) {
      state.batteryLevel = 0;
      state.flashlightOn = false;
      renderHud();
    }
  }

  let targetIntensity = hasFlashlightOn() ? FLASHLIGHT_MAX_INTENSITY : 0;

  if (hasFlashlightOn() && state.batteryLevel < 20) {
    flashlightFlickerTimer += dt;
    if (flashlightFlickerTimer > 0.07) {
      flashlightFlickerTimer = 0;
      const flickerChance = (20 - state.batteryLevel) / 20;
      if (Math.random() < flickerChance * 0.65) {
        targetIntensity *= 0.1 + Math.random() * 0.3;
      }
    }
  }

  const diff = targetIntensity - flashlightCurrentIntensity;
  const step = FLASHLIGHT_RAMP_SPEED * dt;
  flashlightCurrentIntensity =
    Math.abs(diff) <= step ? targetIntensity : flashlightCurrentIntensity + Math.sign(diff) * step;
  flashlightLight.intensity = flashlightCurrentIntensity;

  updateBatteryHud();
}

function updateBatteryHud() {
  const hud = document.getElementById("battery-hud");
  if (!state.inventory.flashlight) {
    hud.classList.add("hidden");
    return;
  }
  hud.classList.remove("hidden");
  const pct = Math.round(state.batteryLevel);
  const fill = document.getElementById("battery-fill");
  fill.style.width = pct + "%";
  fill.style.background = pct < 20 ? "#8a1f1f" : pct < 50 ? "#c9a15c" : "#5c8a52";
  document.getElementById("battery-pct").textContent = pct + "%";
}

// ---- mouse look (pointer lock) -------------------------------------------------

function onPointerLockChange() {
  const hint = document.getElementById("pointer-lock-hint");
  const locked = document.pointerLockElement === renderer.domElement;
  const shouldShowHint = state.phase === "explore" && !state.activeNpc && !locked;
  hint.classList.toggle("hidden", !shouldShowHint);
}

function onMouseMove(e) {
  if (document.pointerLockElement !== renderer.domElement || state.activeNpc) return;
  yawObject.rotation.y -= e.movementX * MOUSE_SENSITIVITY;
  camera.rotation.x -= e.movementY * MOUSE_SENSITIVITY;
  camera.rotation.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.rotation.x));
}

document.addEventListener("pointerlockchange", onPointerLockChange);
document.addEventListener("mousemove", onMouseMove);
canvas.addEventListener("click", () => {
  if (state.phase === "explore" && !state.activeNpc && document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock();
  }
});

// ---- interaction (proximity + "E") -------------------------------------------

function nearestInteractable() {
  const px = yawObject.position.x;
  const py = yawObject.position.z; // grid "y" is world Z
  let closest = null;
  let closestDist = INTERACT_DIST;

  NPCS.forEach((npc) => {
    const d = Math.hypot(npc.x - px, npc.y - py);
    if (d < closestDist) {
      closestDist = d;
      closest = { type: "npc", id: npc.id, label: `Talk to the ${capitalize(npc.id)}` };
    }
  });

  ITEMS.forEach((item) => {
    if (state.inventory[item.id]) return;
    const d = Math.hypot(item.x - px, item.y - py);
    if (d < closestDist) {
      closestDist = d;
      closest = { type: "item", id: item.id, label: `Pick up ${item.name}` };
    }
  });

  if (closest) return closest;

  // No item in reach — fall back to the nearest closed door.
  let doorTarget = null;
  let doorDist = Infinity;
  doorList().forEach((door) => {
    if (isDoorOpen(door)) return;
    const d = Math.hypot(door.x - px, door.y - py);
    if (d < (door.interactionDistance || 1.4) && d < doorDist) {
      doorDist = d;
      const canUnlock = door.keyId && state.inventory[door.keyId];
      doorTarget = {
        type: "door",
        id: door.id,
        label: canUnlock ? door.unlockLabel || "Unlock Door" : door.label,
      };
    }
  });
  return doorTarget;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function updateInteractPrompt() {
  const prompt = document.getElementById("interact-prompt");
  if (state.activeNpc || !state.settings.showPrompts) {
    prompt.classList.add("hidden");
    return;
  }
  const target = nearestInteractable();
  if (!target) {
    prompt.classList.add("hidden");
    return;
  }
  prompt.textContent = `[E] ${target.label}`;
  prompt.classList.remove("hidden");
}

function handleInteract() {
  if (state.activeNpc) return;
  const target = nearestInteractable();
  if (!target) return;

  if (target.type === "door") {
    const door = doorList().find((d) => d.id === target.id);
    if (door.isFront) {
      state.frontDoorOpen = true;
      playDoorCreak();
    } else if (door.locked && !(door.keyId && state.inventory[door.keyId])) {
      playKnock();
      addLog(door.lockedText || "Locked.");
    } else {
      if (door.locked) playClick(); // key turning
      state.doorsOpen[door.id] = true;
      playDoorCreak();
      if (door.id === "hallDoor" && state.entity.mode === "idle") {
        state.entity.mode = "waiting";
        state.entity.timer = ENTITY_SPAWN_DELAY;
      }
    }
  } else if (target.type === "item") {
    const item = ITEMS.find((it) => it.id === target.id);
    state.inventory[target.id] = true;
    if (target.id === "flashlight") {
      addLog("Press F to turn the flashlight on.");
    }
    renderHud();
    buildWorld(); // remove the collected item's marker from the scene
  } else if (target.type === "npc") {
    openDialogue(target.id);
  }
}

// ---- keyboard input -----------------------------------------------------------

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();

  if (key === "escape") {
    if (state.activeNpc) {
      closeDialogue();
    } else if (state.phase === "explore") {
      openPauseMenu();
    } else if (state.phase === "paused") {
      closePauseMenu();
    }
    return;
  }

  if (state.phase !== "explore") return;
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(key)) {
    e.preventDefault();
    keys.add(key);
  }
  if (key === "e") handleInteract();
  if (key === "f") toggleFlashlight();
});

window.addEventListener("keyup", (e) => {
  keys.delete(e.key.toLowerCase());
});

// ---- dialogue ----------------------------------------------------------------

function openDialogue(npcId) {
  state.activeNpc = npcId;
  state.dialogueNode = "start";
  document.getElementById("dialogue-overlay").classList.remove("hidden");
  renderDialogue();
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }
}

function closeDialogue() {
  state.activeNpc = null;
  document.getElementById("dialogue-overlay").classList.add("hidden");
  renderer.domElement.requestPointerLock();
}

function passesFlagReq(choice) {
  if (!choice.requiresFlag) return true;
  return !!state.flags[choice.requiresFlag];
}

function renderDialogue() {
  const tree = DIALOGUES[state.activeNpc];
  const node = tree[state.dialogueNode];
  document.getElementById("dialogue-speaker").textContent = node.speaker;
  document.getElementById("dialogue-text").textContent = node.text;
  const choicesEl = document.getElementById("dialogue-choices");
  choicesEl.innerHTML = "";
  node.choices.filter(passesFlagReq).forEach((choice) => {
    const btn = document.createElement("button");
    btn.className = "choice-button";
    btn.textContent = choice.label;
    btn.addEventListener("click", () => chooseDialogueOption(choice));
    choicesEl.appendChild(btn);
  });
}

function chooseDialogueOption(choice) {
  if (choice.setFlags) {
    state.flags = { ...state.flags, ...choice.setFlags };
  }
  addLog(`You: "${choice.label}"`);
  if (!choice.next) {
    closeDialogue();
    return;
  }
  state.dialogueNode = choice.next;
  renderDialogue();
}

document.getElementById("dialogue-exit").addEventListener("click", closeDialogue);

// ---- the presence ---------------------------------------------------------------
// Something moves through the building (it ignores walls). Light off or dead:
// it closes in. Light on but not pointed at it: it hangs back. Light on it:
// it recoils. If it reaches you in the dark, the run ends.

const ENTITY_SPAWN_DELAY = 12; // seconds after the hall door opens
const ENTITY_SPEED_DARK = 0.9;
const ENTITY_SPEED_DEAD = 1.2; // battery gone: it moves faster
const ENTITY_SPEED_WATCHING = 0.25;
const ENTITY_RETREAT_SPEED = 1.8;
const ENTITY_CATCH_DIST = 0.8;
const ENTITY_BEAM_COS = 0.9; // roughly a 25 degree cone
const ENTITY_BEAM_RANGE = 9;
const ENTITY_SPAWNS = [
  [3.0, 9.5], [13.5, 9.5], [8.5, 9.0], [2.0, 11.5],
  [14.5, 11.5], [4.0, 5.5], [12.5, 6.0], [8.5, 5.5],
];

const entityGroup = new THREE.Group();
(function buildEntityMesh() {
  const dark = new THREE.MeshStandardMaterial({ color: 0x0f0f12, roughness: 1 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.45, 0.26), dark);
  body.position.set(0, 0.75, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 8), dark);
  head.position.set(0, 1.65, 0);
  const armGeo = new THREE.BoxGeometry(0.09, 1.15, 0.09);
  const armL = new THREE.Mesh(armGeo, dark);
  armL.position.set(-0.3, 0.9, 0);
  const armR = new THREE.Mesh(armGeo, dark);
  armR.position.set(0.3, 0.9, 0);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xcc2222 });
  const eyeGeo = new THREE.SphereGeometry(0.03, 6, 6);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.07, 1.68, 0.15);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.07, 1.68, 0.15);
  [body, head, armL, armR, eyeL, eyeR].forEach((m) => entityGroup.add(m));
  entityGroup.visible = false;
  scene.add(entityGroup);
})();

function setFear(v) {
  document.getElementById("fear-vignette").style.opacity = v.toFixed(2);
}

function hasLineOfSight(ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const steps = Math.ceil(Math.hypot(dx, dz) / 0.25);
  for (let i = 1; i < steps; i++) {
    if (isWall(ax + (dx * i) / steps, az + (dz * i) / steps)) return false;
  }
  return true;
}

function entityInBeam(e) {
  if (!hasFlashlightOn()) return false;
  const p = yawObject.position;
  const d = Math.hypot(e.x - p.x, e.z - p.z);
  if (d > ENTITY_BEAM_RANGE) return false;
  // Horizontal angle only (the creature is tall), as long as the player isn't
  // staring at the floor or ceiling.
  const yaw = yawObject.rotation.y;
  if (Math.abs(camera.rotation.x) > 0.7) return false;
  const tx = e.x - p.x;
  const tz = e.z - p.z;
  const len = Math.hypot(tx, tz) || 1;
  const dot = (-Math.sin(yaw) * tx + -Math.cos(yaw) * tz) / len;
  return dot > ENTITY_BEAM_COS && hasLineOfSight(p.x, p.z, e.x, e.z);
}

function spawnEntity() {
  const p = yawObject.position;
  const far = ENTITY_SPAWNS.filter(([x, z]) => Math.hypot(x - p.x, z - p.z) >= 6);
  const pool = far.length ? far : ENTITY_SPAWNS;
  const [x, z] = pool[Math.floor(Math.random() * pool.length)];
  state.entity.x = x;
  state.entity.z = z;
  state.entity.mode = "active";
  if (!state.flags.entitySeen) {
    state.flags.entitySeen = true;
  }
}

function caughtByEntity() {
  state.phase = "caught";
  state.entity.mode = "done";
  keys.clear();
  playSting();
  setFear(1);
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  document.getElementById("caught-overlay").classList.remove("hidden");
}

function updateEntity(dt) {
  const e = state.entity;
  if (state.phase !== "explore") return;
  if (e.mode === "idle" || e.mode === "done") {
    entityGroup.visible = false;
    return;
  }
  if (e.mode === "waiting" || e.mode === "gone") {
    entityGroup.visible = false;
    setFear(0);
    e.timer -= dt;
    if (e.timer <= 0) spawnEntity();
    return;
  }

  // active
  if (isOutside()) {
    entityGroup.visible = false;
    setFear(0);
    return;
  }
  const p = yawObject.position;
  const dx = p.x - e.x;
  const dz = p.z - e.z;
  const d = Math.hypot(dx, dz) || 0.0001;
  const inBeam = entityInBeam(e);
  let speed;
  let dir = 1;
  if (inBeam) {
    speed = ENTITY_RETREAT_SPEED;
    dir = -1;
    if (!state.flags.entityRecoiled) {
      state.flags.entityRecoiled = true;
    }
  } else if (hasFlashlightOn()) {
    speed = ENTITY_SPEED_WATCHING;
  } else {
    speed = state.batteryLevel <= 0 ? ENTITY_SPEED_DEAD : ENTITY_SPEED_DARK;
  }
  e.x = Math.max(1.3, Math.min(15.7, e.x + (dir * dx / d) * speed * dt));
  e.z = Math.max(1.3, Math.min(12.7, e.z + (dir * dz / d) * speed * dt));

  const nd = Math.hypot(p.x - e.x, p.z - e.z);
  if (inBeam && nd > ENTITY_BEAM_RANGE) {
    e.mode = "gone";
    e.timer = 8 + Math.random() * 7;
    entityGroup.visible = false;
    setFear(0);
    return;
  }
  if (nd < ENTITY_CATCH_DIST && !inBeam) {
    caughtByEntity();
    entityGroup.position.set(e.x, 0, e.z);
    entityGroup.rotation.y = Math.atan2(p.x - e.x, p.z - e.z);
    entityGroup.visible = true;
    return;
  }

  entityGroup.position.set(e.x, 0, e.z);
  entityGroup.rotation.y = Math.atan2(p.x - e.x, p.z - e.z);
  entityGroup.visible = true;

  const fear = Math.max(0, Math.min(1, 1 - (nd - ENTITY_CATCH_DIST) / 7)) * (inBeam ? 0.6 : 1);
  setFear(fear);
  e.beat -= dt;
  if (e.beat <= 0 && fear > 0.05) {
    playHeartbeat(fear);
    e.beat = 1.3 - fear * 0.85;
  }
}

document.getElementById("caught-retry-button").addEventListener("click", () => {
  document.getElementById("caught-overlay").classList.add("hidden");
  resetRun();
  enterExplore();
});

document.getElementById("caught-leave-button").addEventListener("click", () => {
  document.getElementById("caught-overlay").classList.add("hidden");
  resetRun();
  state.phase = "title";
  showScreen("screen-title");
});

// ---- main loop -----------------------------------------------------------------

const clock = new THREE.Clock();

function gameLoop() {
  const dt = Math.min(0.1, clock.getDelta());
  tryMovePlayer(dt);
  checkJohnRoom();
  updateEntity(dt);
  updateDoorAnimation(dt);
  updateDeskLampFlicker(dt);
  updateFlashlight(dt);

  const outside = isOutside();
  scene.fog.far = outside ? MOON_RANGE : currentLightRange();
  moonLight.intensity = outside ? 0.35 : 0;
  const bgColor = outside ? 0x0a0918 : 0x0b0a0d;
  scene.background.set(bgColor);
  scene.fog.color.set(bgColor);
  ambientLight.intensity = outside ? 0.045 : hasFlashlightOn() ? 0.22 : 0.09;

  updateInteractPrompt();
  renderer.render(scene, camera);
}

// ---- boot --------------------------------------------------------------------

showScreen("screen-title");