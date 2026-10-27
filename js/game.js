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
const DOOR_OPEN_SPEED = 1.9; // radians/second
const DOOR_ROW = Math.floor(FRONT_DOOR.y); // row 6 — everything south of this is "the street"

// Vision range indoors: full range while the flashlight is on and has
// charge, a short oppressive range otherwise — drives real Three.js fog
// distance. Outdoors always uses the dimmer, moonlit street range.
const LIT_RANGE = 12;
const DARK_RANGE = 2.6;
const MOON_RANGE = 12;
const ELEVATOR = FIXTURES.find((f) => f.id === "elevator");
const FACADE_H = 9; // the street-facing walls are three storeys tall

// Fog is decided by where a surface IS, not where the camera stands: anything
// inside the building (south edge z < 13.02, below the ceiling) fades at the
// short indoor range, everything else at the street range. So the lobby is
// already dark when you look in through the open door from outside.
(function patchFogChunks() {
  const SC = THREE.ShaderChunk;
  if (!SC || !SC.fog_fragment) return;
  const swap = (name, from, to) => {
    if (SC[name].indexOf(from) !== -1) SC[name] = SC[name].replace(from, to);
  };
  swap("fog_pars_vertex", "varying float vFogDepth;", "varying float vFogDepth;\n\tvarying vec3 vFogWorld;");
  swap("fog_vertex", "vFogDepth = - mvPosition.z;", "vFogDepth = - mvPosition.z;\n\tvFogWorld = ( inverse( viewMatrix ) * mvPosition ).xyz;");
  swap("fog_pars_fragment", "varying float vFogDepth;", "varying float vFogDepth;\n\tvarying vec3 vFogWorld;");
  swap(
    "fog_fragment",
    "float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );",
    "float fogFarHere = ( vFogWorld.z < 13.02 && vFogWorld.y < 6.5 ) ? fogFar : " + MOON_RANGE.toFixed(1) + ";\n\t\tfloat fogFactor = smoothstep( fogNear, fogFarHere, vFogDepth );"
  );
})();

// Battery drains fully after this many seconds of continuous use.
const BATTERY_LIFE_SECONDS = 180;
const BATTERY_DRAIN_RATE = 100 / BATTERY_LIFE_SECONDS;

function hasFlashlightOn() {
  return !!(state.inventory.flashlight && state.held === "flashlight" && state.batteryLevel > 0 && state.flashlightOn);
}

// With the breaker on, the ground floor (lobby, hall, apartments, stairwell, staff room) is lit by ceiling fluorescents.
function groundLit() {
  return !!state.flags.powerOn && levelOf(yawObject.position.x) === 0 && yawObject.position.z < DOOR_ROW;
}

function currentLightRange() {
  if (hasFlashlightOn() || groundLit()) return LIT_RANGE;
  // the reception lamp throws enough light that the desk reads from across the lobby
  const near = Math.hypot(yawObject.position.x - 2.8, yawObject.position.z - 10.5) < 6.5;
  return near ? 5.5 : DARK_RANGE;
}

function isOutside() {
  return yawObject.position.z >= DOOR_ROW;
}

// ---- audio (procedural, Web Audio) --------------------------------------------

let audioCtx = null;
let ambientGains = [];
let footstepTimer = 0;
let noiseBuf = null;
let doorCreakBuffer = null; // the recorded creak, loaded after the first click

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
    g.gain.value = 0;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    ambientGains.push(g);
  });
  // Tension music: a low dissonant drone that rises in volume and pitch as the thing gets close,
  // with a thin shriek that only appears when it's right on top of you.
  const tlp = audioCtx.createBiquadFilter();
  tlp.type = "lowpass";
  tlp.frequency.value = 250;
  const tg = audioCtx.createGain();
  tg.gain.value = 0;
  tlp.connect(tg).connect(audioCtx.destination);
  const tOscs = [[55, "sawtooth"], [58.6, "sawtooth"], [110.9, "triangle"], [164.8, "sawtooth"]].map(([f, type]) => {
    const o = audioCtx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(tlp);
    o.start();
    return o;
  });
  const hi = audioCtx.createOscillator();
  hi.type = "sine";
  hi.frequency.value = 1180;
  const hg = audioCtx.createGain();
  hg.gain.value = 0;
  const vib = audioCtx.createOscillator();
  vib.frequency.value = 6.5;
  const vibDepth = audioCtx.createGain();
  vibDepth.gain.value = 35;
  vib.connect(vibDepth).connect(hi.frequency);
  hi.connect(hg).connect(audioCtx.destination);
  hi.start();
  vib.start();
  tensionNodes = { tg, tlp, tOscs, hi, hg };
  ambientOn = null;
  // The recorded door creak. If it can't load (e.g. opened as a plain file), the
  // synthesized creak below is used instead.
  if (typeof fetch === "function") {
    fetch("audio/door-creak.mp3")
      .then((r) => r.arrayBuffer())
      .then((buf) => audioCtx.decodeAudioData(buf))
      .then((decoded) => {
        doorCreakBuffer = decoded;
      })
      .catch(() => {});
  }
}

function setSoundEnabled(on) {
  state.settings.soundOn = on;
  syncAmbient();
}

// The background hum only plays while you're actually exploring — silent on the
// title, pause, inventory, reading and caught screens.
let ambientOn = null;
let tensionNodes = null;

function applyTension(level) {
  if (!tensionNodes) return;
  const want = state.settings.soundOn && state.phase === "explore" ? level : 0;
  const t = audioCtx.currentTime;
  const { tg, tlp, tOscs, hg } = tensionNodes;
  tg.gain.setTargetAtTime(want * want * 0.13, t, 0.2);
  tlp.frequency.setTargetAtTime(220 + want * 2400, t, 0.2);
  tOscs[3].frequency.setTargetAtTime(164.8 * (1 + want * 0.6), t, 0.3);
  tOscs[1].frequency.setTargetAtTime(58.6 + want * 6, t, 0.3);
  hg.gain.setTargetAtTime(Math.pow(Math.max(0, want - 0.6) / 0.4, 2) * 0.035, t, 0.15);
}

function playVanish() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(720, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.7);
  g.gain.setValueAtTime(0.09, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 0.8);
}
function syncAmbient() {
  const want = state.settings.soundOn && state.phase === "explore";
  if (want === ambientOn) return;
  ambientOn = want;
  ambientGains.forEach((g) => (g.gain.value = want ? 0.03 : 0));
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

// A slow, rusty hinge: two sawtooth voices pushed through a resonant filter
// that sweeps as the door turns, chopped by a fast stick-slip pulse, with a
// latch click at the start and a soft thud when it comes to rest.
function playDoorCreak(door) {
  if (!audioReady()) return;
  const cfg = typeof door === "number" ? { creak: door } : door || {};
  if (doorCreakBuffer) {
    // Same recording for every door, but each door shifts its speed (heavier
    // doors slower and lower), darkens or brightens it, changes its loudness and
    // starts a little way in, plus a tiny random drift so no two opens match.
    const src = audioCtx.createBufferSource();
    src.buffer = doorCreakBuffer;
    src.playbackRate.value = Math.max(0.6, Math.min(1.4, (cfg.creak || 1) * (0.97 + Math.random() * 0.06)));
    const tone = audioCtx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = cfg.creakTone || 8000;
    tone.Q.value = 0.7;
    const level = audioCtx.createGain();
    level.gain.value = 0.7 * (cfg.creakGain || 1);
    src.connect(tone).connect(level).connect(audioCtx.destination);
    src.start(audioCtx.currentTime, cfg.creakStart || 0);
    return;
  }
  const pitch = cfg.creak || 1;
  const t = audioCtx.currentTime;
  const dur = 1.2 + Math.random() * 0.4;
  const master = audioCtx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.linearRampToValueAtTime(0.5, t + 0.12);
  master.gain.setValueAtTime(0.5, t + dur * 0.7);
  master.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  master.connect(audioCtx.destination);

  const bp = audioCtx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 6;
  bp.frequency.setValueAtTime(420 * pitch, t);
  bp.frequency.linearRampToValueAtTime(980 * pitch, t + dur * 0.55);
  bp.frequency.linearRampToValueAtTime(560 * pitch, t + dur);

  const am = audioCtx.createGain();
  am.gain.value = 0.45;
  const lfo = audioCtx.createOscillator();
  lfo.type = "sawtooth";
  lfo.frequency.setValueAtTime(24, t);
  lfo.frequency.linearRampToValueAtTime(41, t + dur * 0.6);
  lfo.frequency.linearRampToValueAtTime(19, t + dur);
  const lfoDepth = audioCtx.createGain();
  lfoDepth.gain.value = 0.45;
  lfo.connect(lfoDepth).connect(am.gain);
  lfo.start(t);
  lfo.stop(t + dur + 0.05);

  [1, 1.51].forEach((mult) => {
    const o = audioCtx.createOscillator();
    o.type = "sawtooth";
    const f0 = 118 * pitch * mult;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * 1.5, t + dur * 0.5);
    o.frequency.linearRampToValueAtTime(f0 * 1.1, t + dur);
    o.connect(am);
    o.start(t);
    o.stop(t + dur + 0.05);
  });
  am.connect(bp).connect(master);

  const click = audioCtx.createBufferSource();
  click.buffer = noiseBuf;
  const hp = audioCtx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1500;
  const cg = audioCtx.createGain();
  cg.gain.value = 0.12;
  click.connect(hp).connect(cg).connect(audioCtx.destination);
  click.start(t);

  const thud = audioCtx.createBufferSource();
  thud.buffer = noiseBuf;
  const lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 140;
  const tg = audioCtx.createGain();
  tg.gain.value = 0.18;
  thud.connect(lp).connect(tg).connect(audioCtx.destination);
  thud.start(t + dur * 0.95);
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
  if (state.held !== "flashlight") {
    state.held = "flashlight";
    state.flashlightOn = true;
    playClick();
    return;
  }
  state.flashlightOn = !state.flashlightOn;
  playClick();
}

// ---- captions: short lines at the bottom middle that fade away ----------------

let captionQueue = [];
let captionBusy = false;
let captionTimer = null;

function queueCaption(text) {
  return; // no on-screen log text any more; only the item popup and action prompts remain
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
  state.transition = null;
  elevAnim = null;
  state.flags = {};
  state.log = [];
  state.inventory = {};
  state.held = null;
  state.batteries = 0;
  state.flashlightOn = false;
  state.batteryLevel = 100;
  state.frontDoorOpen = false;
  state.doorsOpen = {};
  flashlightCurrentIntensity = 0;
  flashlightFlickerTimer = 0;
  state.activeNpc = null;
  state.dialogueNode = "start";
  state.entity = { mode: "idle", timer: 0, x: 0, z: 0, beat: 0, dark: 0, path: null, repath: 0 };
  entityGroup.scale.set(1, 1, 1);
  entityGroup.visible = false;
  clearScares();
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


const flashlightLight = new THREE.SpotLight(0xfff2d0, 0, 14, 0.312, 0.4, 2); // small circle of light that falls off with distance
flashlightLight.position.set(0, 0, 0);
camera.add(flashlightLight);
camera.add(flashlightLight.target);
flashlightLight.target.position.set(0, 0, -1);

const FLASHLIGHT_MAX_INTENSITY = 22; // tight beam with real falloff, so it needs more punch
const FLASHLIGHT_RAMP_SPEED = 160; // intensity/second — about a tenth of a second, so on/off feels instant
let flashlightCurrentIntensity = 0;
let flashlightFlickerTimer = 0;

const worldGroup = new THREE.Group();
scene.add(worldGroup);

// A real flashlight: barrel, grip rings, flared head, glass lens, switch.
// Built pointing down -Z. unlit=true gives the always-visible first-person copy.
function buildFlashlightModel(unlit) {
  const mat = (color) =>
    unlit
      ? new THREE.MeshBasicMaterial({ color, depthTest: false })
      : new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.5 });
  const group = new THREE.Group();
  let order = 999;
  const add = (mesh) => {
    if (unlit) mesh.renderOrder = order++;
    group.add(mesh);
    return mesh;
  };
  const barrel = add(new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.2, 14), mat(0x34373a)));
  barrel.rotation.x = Math.PI / 2;
  [0.05, 0.08].forEach((z) => {
    const ring = add(new THREE.Mesh(new THREE.CylinderGeometry(0.0295, 0.0295, 0.014, 14), mat(0x15161a)));
    ring.rotation.x = Math.PI / 2;
    ring.position.z = z;
  });
  const tail = add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 14), mat(0x4a4e52)));
  tail.rotation.x = Math.PI / 2;
  tail.position.z = 0.108;
  const head = add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.07, 14), mat(0x4a4e52)));
  head.rotation.x = Math.PI / 2;
  head.position.z = -0.135;
  const lensMat = unlit
    ? new THREE.MeshBasicMaterial({ color: 0x2a3236, depthTest: false })
    : new THREE.MeshStandardMaterial({ color: 0x9aa6aa, roughness: 0.2, metalness: 0.3 });
  const lens = add(new THREE.Mesh(new THREE.CircleGeometry(0.043, 14), lensMat));
  lens.rotation.y = Math.PI;
  lens.position.z = -0.1715;
  const sw = add(new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.012, 0.03), mat(0xa03030)));
  sw.position.set(0, 0.031, 0.015);
  return { group, lensMat };
}

function addFlashlightModel(x, y, z) {
  const m = buildFlashlightModel(false).group;
  m.rotation.y = Math.PI / 2 + 0.3; // lying on its side, angled a little
  m.position.set(x, y, z);
  worldGroup.add(m);
}

function addKeyModel(x, y, z, scale = 1) {
  const brass = new THREE.MeshStandardMaterial({ color: 0xb8963a, emissive: 0x2a2008, roughness: 0.35, metalness: 0.7 });
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.009, 6, 14), brass);
  ring.rotation.x = Math.PI / 2;
  ring.position.x = -0.06;
  const stem = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.011, 0.011), brass);
  stem.position.x = 0.02;
  const t1 = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.011, 0.03), brass);
  t1.position.set(0.06, 0, 0.014);
  const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.011, 0.02), brass);
  t2.position.set(0.04, 0, 0.01);
  const tag = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.004, 0.035),
    new THREE.MeshStandardMaterial({ color: 0xcfc6a8, roughness: 1 })
  );
  tag.position.set(-0.11, -0.004, 0.03);
  [ring, stem, t1, t2, tag].forEach((m) => g.add(m));
  g.rotation.y = 0.6;
  g.scale.setScalar(scale);
  g.position.set(x, y, z);
  (buildTarget || worldGroup).add(g);
}

// The flashlight in Maria's hand: bottom right of the view, glows when on.
const held = buildFlashlightModel(true);
const heldFlashlight = held.group;
const heldLensMat = held.lensMat;
heldFlashlight.position.set(0.17, -0.15, -0.34);
heldFlashlight.rotation.set(0.04, 0.12, 0);
heldFlashlight.visible = false;
camera.add(heldFlashlight);

function buildAxeGroup() {
  // a fire axe: long grained handle, wrapped grip, heavy curved head with a bright edge and a back spike
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a2c16, roughness: 0.8 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x15110e, roughness: 1 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.45, metalness: 0.8 });
  const edge = new THREE.MeshStandardMaterial({ color: 0xdfe6ec, roughness: 0.2, metalness: 0.9, emissive: 0x20262c });
  const gore = new THREE.MeshStandardMaterial({ color: 0x5a0a0a, roughness: 0.6 });
  const part = (geo, mat, x, y, z, rz) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (rz) m.rotation.z = rz;
    g.add(m);
    return m;
  };
  const handle = part(new THREE.CylinderGeometry(0.022, 0.03, 0.86, 8), wood, -0.02, 0, 0, Math.PI / 2);
  for (let i = 0; i < 5; i++) part(new THREE.CylinderGeometry(0.034, 0.034, 0.025, 8), grip, -0.3 + i * 0.045, 0, 0, Math.PI / 2); // wrapped grip
  part(new THREE.SphereGeometry(0.04, 8, 6), iron, -0.45, 0, 0); // pommel
  part(new THREE.BoxGeometry(0.1, 0.07, 0.07), iron, 0.4, 0, 0); // socket where the head sits
  for (let i = 0; i < 6; i++) {
    // the blade fans out and curves towards the edge
    const w = 0.07 + i * 0.022;
    part(new THREE.BoxGeometry(w, 0.026, 0.045), iron, 0.4 + (i > 3 ? 0.012 * (i - 3) : 0), 0, 0.055 + i * 0.043);
  }
  part(new THREE.BoxGeometry(0.2, 0.014, 0.02), edge, 0.436, 0, 0.3); // the bright edge
  part(new THREE.BoxGeometry(0.1, 0.03, 0.012), gore, 0.43, 0.001, 0.275); // dried blood on it
  part(new THREE.BoxGeometry(0.07, 0.02, 0.02), gore, 0.27, 0, 0.0).rotation.y = 0.4;
  const spike = part(new THREE.ConeGeometry(0.022, 0.2, 6), iron, 0.4, 0, -0.14); // back spike
  spike.rotation.x = -Math.PI / 2;
  return g;
}
const heldAxe = buildAxeGroup();
heldAxe.position.set(0.22, -0.2, -0.45);
heldAxe.rotation.set(0.5, 1.2, 0.9);
heldAxe.scale.setScalar(0.7);
heldAxe.visible = false;
camera.add(heldAxe);
let heldBobTime = 0;

// The night sky: scattered stars and a pale moon (never fogged).
(function buildSky() {
  const n = 260;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(0.12 + Math.random() * 0.88);
    pos[i * 3] = 10.5 + Math.sin(ph) * Math.cos(th) * 90;
    pos[i * 3 + 1] = Math.cos(ph) * 90;
    pos[i * 3 + 2] = 10 + Math.sin(ph) * Math.sin(th) * 90;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.8, sizeAttenuation: false, fog: false })));
  const moon = new THREE.Mesh(new THREE.CircleGeometry(5, 32), new THREE.MeshBasicMaterial({ color: 0xdde4f0, fog: false }));
  moon.position.set(32, 42, 62);
  moon.lookAt(10.5, 1.5, 10);
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(10, 32),
    new THREE.MeshBasicMaterial({ color: 0x8899bb, transparent: true, opacity: 0.14, fog: false, depthWrite: false })
  );
  halo.position.set(0, 0, -0.2);
  moon.add(halo);
  scene.add(moon);
})();

function updateHeldFlashlight(dt) {
  heldAxe.visible = state.held === "axe" && !!state.inventory.axe;
  if (heldAxe.visible) {
    heldBobTime += dt * 2;
    heldAxe.position.y = -0.2 + Math.sin(heldBobTime) * 0.004;
  }
  heldFlashlight.visible = state.held === "flashlight" && !!state.inventory.flashlight;
  if (!heldFlashlight.visible) return;
  const moving = keys.has("w") || keys.has("a") || keys.has("s") || keys.has("d");
  heldBobTime += dt * (moving ? 9 : 1.6);
  const amp = moving ? 0.008 : 0.002;
  heldFlashlight.position.y = -0.15 + Math.sin(heldBobTime) * amp;
  heldFlashlight.position.x = 0.17 + Math.cos(heldBobTime * 0.5) * amp;
  const k = Math.max(0, Math.min(1, flashlightCurrentIntensity / FLASHLIGHT_MAX_INTENSITY));
  heldLensMat.color.setRGB(0.16 + 0.84 * k, 0.2 + 0.77 * k, 0.21 + 0.55 * k);
}
// Furniture you can't walk through: axis-aligned footprints registered while the world is built.
let solids = [];
function addSolid(cx, cz, w, d) {
  solids.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 });
}
let entityBlock = []; // rectangles the creature won't path through (stairs)
// ---- real stairs: floor height under the player ----
function stairAt(x, z) {
  return STAIRS.find((s) => x >= s.x0 && x < s.x1 && (z - s.z1) * (z - s.z0) <= 0);
}
function floorHeight(x, z) {
  const s = stairAt(x, z);
  if (!s) return 0;
  const t = Math.min(1, Math.max(0, (s.z0 - z) / (s.z0 - s.z1)));
  return (s.rise * Math.min(STAIR_STEPS, Math.floor(t * STAIR_STEPS) + 1)) / STAIR_STEPS;
}
let doorPivots = {}; // id -> hinge group, set in buildWorld(); drives the swing animation
let elevPanels = [];
let elevLight = null;
let elevLightMat = null;
let elevLightTimer = 0;
let elevAnim = null; // seconds into the door-opening sequence
let staffSignMat = null;
let staffSignLight = null;
const STAFF_SIGN_LEVEL = 0.9;
let staffSignTimer = 0;
let deskBulbMat = null;
const DESK_LAMP_LEVEL = 4.5;
let deskLampFlickerLeft = 0;
let deskLampNextFlicker = 6;
let flickerLights = []; // {light, base} lights that stutter (emergency bulbs, boiler glow)
let swayers = []; // hanging chains
let scareActive = []; // pop-out apparitions in flight
let scareBlackout = 0;
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

// Handwritten paper: seeded jitter per letter, ink fade, and {scribbled-out} words nobody can read.
function drawPaper(c, text, sloppy, seed) {
  const w = (c.width = 512);
  const h = (c.height = 640);
  const ctx = c.getContext("2d");
  let s = seed * 9301 + 49297;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  ctx.fillStyle = "#d8ceae";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = `rgba(120,90,40,${0.02 + r() * 0.035})`;
    ctx.beginPath();
    ctx.arc(r() * w, r() * h, 30 + r() * 80, 0, 6.3);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  ctx.fillRect(0, h / 2, w, 2);
  ctx.strokeStyle = "rgba(70,90,120,0.18)";
  ctx.lineWidth = 1;
  for (let y = 90; y < h; y += 46) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const size = 44 - sloppy * 8;
  ctx.font = `${size}px "Reenie Beanie","Nothing You Could Do","Segoe Script","Bradley Hand",cursive`;
  const ink = "#1d1f2e";
  let y = 92;
  text.split("\n").forEach((line) => {
    let x = 34 + r() * 16;
    const tilt = (r() - 0.5) * sloppy * 0.06;
    (line.match(/\{[^}]*\}|\S+/g) || []).forEach((tok) => {
      const bad = tok[0] === "{";
      const word = bad ? tok.slice(1, -1) : tok;
      if (bad) {
        const len = Math.max(3, word.length) * size * 0.36;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2 + r() * 2;
        ctx.beginPath();
        ctx.moveTo(x, y - size * 0.3);
        for (let i = 1; i <= 9; i++) ctx.lineTo(x + (len * i) / 9, y - size * 0.3 + (i % 2 ? -1 : 1) * size * (0.1 + r() * 0.3));
        ctx.stroke();
      } else {
        for (const ch of word) {
          ctx.save();
          ctx.translate(x, y + (r() - 0.5) * sloppy * 12 + x * tilt);
          ctx.rotate((r() - 0.5) * sloppy * 0.6);
          ctx.globalAlpha = 1 - sloppy * r() * 0.5;
          ctx.fillStyle = ink;
          ctx.fillText(ch, 0, 0);
          ctx.restore();
          x += (ctx.measureText(ch).width || size * 0.4) * (0.95 + r() * 0.2 * (1 + sloppy));
        }
      }
      x += size * 0.35 * (bad ? 1.4 : 1);
    });
    y += 50 + r() * sloppy * 14;
  });
  ctx.globalAlpha = 1;
  if (sloppy > 0.6) {
    ctx.fillStyle = "rgba(20,20,40,0.22)";
    ctx.beginPath();
    ctx.ellipse(w * (0.55 + r() * 0.3), h * (0.6 + r() * 0.25), 22 + r() * 18, 14 + r() * 10, r(), 0, 6.3);
    ctx.fill();
  }
  return c;
}

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

function createStyledDoorTexture(style, plate, base, back) {
  if (style === "panelka") return createDoorTexture(back ? "" : plate, base);
  if (style === "wood") style = "wood4";
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
  const raised = (x, y, w, h) => {
    shade(x, y, w, h, -0.28);
    shade(x + 0.02, y + 0.012, w - 0.04, h - 0.024, 0.08);
  };
  const grain = (n, a) => {
    for (let i = 0; i < n; i++) shade(Math.random(), Math.random() * 0.4, 0.004, 0.3 + Math.random() * 0.6, (Math.random() < 0.5 ? 1 : -1) * a);
  };
  const stiles = () => {
    shade(0, 0, 0.04, 1, -0.3);
    shade(0.96, 0, 0.04, 1, -0.3);
  };
  if (style === "wood4") {
    grain(40, 0.05);
    stiles();
    [[0.1, 0.07, 0.36, 0.34], [0.54, 0.07, 0.36, 0.34], [0.1, 0.5, 0.36, 0.42], [0.54, 0.5, 0.36, 0.42]].forEach((p) => raised(...p));
  } else if (style === "wood6") {
    grain(40, 0.05);
    stiles();
    [0.1, 0.54].forEach((x) => [[0.05, 0.22], [0.31, 0.22], [0.58, 0.34]].forEach(([y, h]) => raised(x, y, 0.36, h)));
  } else if (style === "flush") {
    grain(70, 0.035);
    stiles();
    shade(0, 0.5, 1, 0.012, -0.45);
    shade(0, 0.512, 1, 0.006, 0.12);
    shade(0.1, 0.1, 0.8, 0.012, -0.3);
    shade(0.1, 0.9, 0.8, 0.012, -0.3);
  } else if (style === "arch") {
    grain(50, 0.06);
    stiles();
    const arch = (inset, a) => {
      const x0 = S * (0.12 + inset);
      const x1 = S * (0.88 - inset);
      const rx = (x1 - x0) / 2;
      t.beginPath();
      t.moveTo(x0, S * (0.4 - inset * 0.4));
      t.lineTo(x0, S * 0.2);
      t.ellipse(S * 0.5, S * 0.2, rx, rx / 3, 0, Math.PI, Math.PI * 2);
      t.lineTo(x1, S * (0.4 - inset * 0.4));
      t.closePath();
      t.fillStyle = a;
      t.fill();
    };
    arch(0, "rgba(0,0,0,0.32)");
    arch(0.025, "rgba(255,255,255,0.07)");
    raised(0.12, 0.52, 0.76, 0.4);
  } else if (style === "entrance") {
    grain(60, 0.05);
    stiles();
    t.fillStyle = back ? "rgba(205,170,105,0.55)" : "rgba(70,98,86,0.72)";
    t.fillRect(S * 0.12, S * 0.06, S * 0.76, S * 0.42);
    shade(0.2, 0.06, 0.1, 0.42, 0.1); // a pale reflection across the glass
    t.strokeStyle = "rgba(8,10,8,0.95)";
    t.lineWidth = 3;
    t.strokeRect(S * 0.12, S * 0.06, S * 0.76, S * 0.42);
    t.lineWidth = 2;
    [1, 2, 3].forEach((i) => {
      t.beginPath();
      t.moveTo(S * (0.12 + 0.19 * i), S * 0.06);
      t.lineTo(S * (0.12 + 0.19 * i), S * 0.48);
      t.stroke();
    });
    [0.2, 0.34].forEach((y) => {
      t.beginPath();
      t.moveTo(S * 0.12, S * y);
      t.lineTo(S * 0.88, S * y);
      t.stroke();
    });
    raised(0.12, 0.56, 0.34, 0.34);
    raised(0.54, 0.56, 0.34, 0.34);
    t.fillStyle = "#b89a52";
    t.fillRect(S * 0.06, S * 0.93, S * 0.88, S * 0.045);
  } else if (style === "hall") {
    grain(30, 0.04);
    shade(0.14, 0.07, 0.72, 0.38, back ? 0.2 : 0.28); // frosted glass
    t.strokeStyle = "rgba(20,16,12,0.9)";
    t.lineWidth = 2;
    t.strokeRect(S * 0.14, S * 0.07, S * 0.72, S * 0.38);
    t.beginPath();
    t.moveTo(S * 0.5, S * 0.07);
    t.lineTo(S * 0.5, S * 0.45);
    t.moveTo(S * 0.14, S * 0.26);
    t.lineTo(S * 0.86, S * 0.26);
    t.stroke();
    raised(0.14, 0.55, 0.72, 0.36);
  } else if (style === "metal") {
    for (let i = 0; i < 14; i++) shade(0, i / 14, 1, 0.012, -0.25);
    shade(0, 0, 0.03, 1, -0.3);
    shade(0.97, 0, 0.03, 1, -0.3);
    if (!back) {
      flatText(t, "STAFF", S * 0.5, S * 0.26, S * 0.22, "rgba(15,15,15,0.8)");
      flatText(t, "ONLY", S * 0.5, S * 0.34, S * 0.22, "rgba(15,15,15,0.8)");
    }
    for (let i = 0; i < 10; i++) {
      t.fillStyle = i % 2 ? "#151512" : "#b99a2a";
      t.fillRect(S * i * 0.1, S * 0.92, S * 0.1, S * 0.05);
    }
  } else if (style === "fire") {
    grain(20, 0.04);
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
    shade(0, 0, 0.03, 1, -0.3);
    shade(0.97, 0, 0.03, 1, -0.3);
    if (!back) flatText(t, "STAIRS", S * 0.5, S * 0.4, S * 0.2, "rgba(225,225,215,0.85)");
  } else if (style === "elevator") {
    for (let i = 0; i < 40; i++) shade(Math.random(), 0, 0.006, 1, Math.random() < 0.5 ? 0.06 : -0.06);
    shade(0.49, 0, 0.02, 1, -0.55);
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
// The lobby side of the facade row is 9 tall, so its wall texture repeats per storey too.
const lobbyWallTexture = makeThreeTexture(createInteriorWallTexture());
lobbyWallTexture.wrapS = THREE.RepeatWrapping;
lobbyWallTexture.wrapT = THREE.RepeatWrapping;
lobbyWallTexture.repeat.set(1, 3);
const doorTexture = makeThreeTexture(createDoorTexture());
const doorTextures = { frontDoor: makeThreeTexture(createStyledDoorTexture(FRONT_DOOR.style, "", FRONT_DOOR.baseColor, false)) };
const fixtureTextures = {};
const doorBackTextures = { frontDoor: makeThreeTexture(createStyledDoorTexture(FRONT_DOOR.style, "", FRONT_DOOR.baseColor, true)) };
DOORS.forEach((d) => {
  doorTextures[d.id] = makeThreeTexture(createStyledDoorTexture(d.style, d.plate, d.baseColor, false));
  doorBackTextures[d.id] = makeThreeTexture(createStyledDoorTexture(d.style, d.plate, d.baseColor, true));
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

// ---- outdoors: road behind you, curb, trees, lamps, parked cars ----------------

let brokenLamp = null;
let brokenLampTimer = 0;
let brokenLampLevel = 1;

function updateBrokenLamp(dt) {
  if (!brokenLamp) return;
  brokenLampTimer -= dt;
  if (brokenLampTimer <= 0) {
    brokenLampLevel = Math.random() < 0.55 ? 1 : 0.06;
    brokenLampTimer = brokenLampLevel === 1 ? 0.2 + Math.random() * 1.8 : 0.04 + Math.random() * 0.12;
  }
  brokenLamp.intensity = 1.3 * brokenLampLevel;
}

function addTree(x, z, s, bare) {
  const wood = 0x2a1f16;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1 * s, 0.17 * s, 2.4 * s, 7),
    new THREE.MeshStandardMaterial({ color: wood, roughness: 1 })
  );
  trunk.position.set(x, 1.2 * s, z);
  worldGroup.add(trunk);
  if (!bare) {
    const leaf = new THREE.MeshStandardMaterial({ color: 0x15281a, roughness: 1 });
    [[0.95, 1.7, 2.3], [0.72, 1.4, 3.2], [0.45, 1.1, 4.0]].forEach(([r, h, y]) => {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r * s, h * s, 8), leaf);
      cone.position.set(x, y * s, z);
      worldGroup.add(cone);
    });
  } else {
    [[0.7, 0.4, 0.2], [-0.8, -0.35, 1.5], [0.5, 0.25, 3.0], [-0.55, -0.3, 4.2]].forEach(([tz, dx, ry]) => {
      const br = addBox(0.07 * s, 1.3 * s, 0.07 * s, x + dx * s, 2.6 * s, z, wood);
      br.rotation.z = tz;
      br.rotation.y = ry;
    });
  }
}

// A parked car, long side along X, front toward +X.
function addCar(x, z, rotY, color) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d1317, roughness: 0.15, metalness: 0.6 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
  const part = (geo, mat, px, py, pz, rx) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    if (rx) m.rotation.x = rx;
    g.add(m);
    return m;
  };
  part(new THREE.BoxGeometry(4.2, 0.55, 1.8), paint, 0, 0.62, 0);
  part(new THREE.BoxGeometry(2.2, 0.5, 1.55), paint, -0.2, 1.14, 0);
  part(new THREE.BoxGeometry(2.24, 0.3, 1.59), glass, -0.2, 1.16, 0);
  [[1.3, 0.9], [1.3, -0.9], [-1.3, 0.9], [-1.3, -0.9]].forEach(([wx, wz]) =>
    part(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14), black, wx, 0.33, wz, Math.PI / 2)
  );
  const head = new THREE.MeshBasicMaterial({ color: 0x6c6c52 });
  const tail = new THREE.MeshBasicMaterial({ color: 0x5a0e0e });
  [0.6, -0.6].forEach((lz) => {
    part(new THREE.BoxGeometry(0.05, 0.14, 0.3), head, 2.1, 0.74, lz);
    part(new THREE.BoxGeometry(0.05, 0.14, 0.3), tail, -2.1, 0.74, lz);
  });
  part(new THREE.BoxGeometry(0.1, 0.18, 1.7), black, 2.12, 0.4, 0);
  part(new THREE.BoxGeometry(0.1, 0.18, 1.7), black, -2.12, 0.4, 0);
  g.rotation.y = rotY;
  g.position.set(x, 0, z);
  worldGroup.add(g);
}

function addOutdoors(cols, rows) {
  const flat = (w, d, x, z, y, color) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color, roughness: 1 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    worldGroup.add(m);
  };
  const cx = cols / 2;
  flat(240, 240, cx, rows + 40, -0.02, 0x10150e); // dark ground all around
  flat(160, 9, cx, rows + 4.5, 0.004, 0x1b1b1e); // the road behind you, z 20-29
  flat(160, 2.2, cx, rows + 10.1, 0.004, 0x2e2e2c); // far sidewalk
  flat(1.8, 3.4, FRONT_DOOR.x, rows - 2.4, 0.007, 0x3b3b39); // path from the door to the road
  flat(cols - 2, 1.2, cx, rows - 1.6, 0.006, 0x33332f); // sidewalk along the curb
  for (let i = 0; i < 16; i++) {
    const dash = addBox(1.6, 0.01, 0.12, -14 + i * 3.6, 0.01, rows + 4.5, 0x8a8a7a);
    dash.material.emissive = new THREE.Color(0x15150f);
  }

  // street lamps along the curb — one of them is failing
  addStreetLight(4.5, rows - 0.5);
  addStreetLight(12.5, rows - 0.5);
  brokenLamp = addStreetLight(19, rows - 0.5);

  // trees: four in the yard (their trunks block you), more beyond the hedges and across the road
  [[2.5, 15.5, 1.0, false], [4.5, 17.5, 0.9, true], [14.5, 15.5, 1.1, false], [17.5, 17.5, 0.95, false]].forEach((t) =>
    addTree(t[0], t[1], t[2], t[3])
  );
  [[-2.5, 16.5, 1.2, false], [-4.5, 21, 1.0, true], [23.5, 15.5, 1.15, false], [25, 20.5, 0.95, false],
   [3, rows + 10.4, 1.1, false], [10, rows + 10.6, 1.2, true], [17, rows + 10.3, 1.0, false]].forEach((t) =>
    addTree(t[0], t[1], t[2], t[3])
  );

  // parked and stopped cars
  addCar(5.0, rows + 1.5, 0, 0x4a1c1c);
  addCar(15.5, rows + 1.5, 0, 0x20303b);
  addCar(10.5, rows + 6.6, Math.PI, 0x2f2f34);
}

// ---- world building -------------------------------------------------------

// ---- doors -----------------------------------------------------------------

const DOOR_W = 0.88;
const DOOR_H = 2.5;
const DOOR_THICK = 0.07;
const DOOR_TRIM = 0.1;

function makeSignTexture(text, bg, fg) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const t = c.getContext("2d");
  t.fillStyle = bg;
  t.fillRect(0, 0, 256, 64);
  t.strokeStyle = fg;
  t.lineWidth = 3;
  t.strokeRect(5, 5, 246, 54);
  t.fillStyle = fg;
  t.font = 'bold 34px "Courier New", monospace';
  t.textAlign = "center";
  t.textBaseline = "middle";
  t.fillText(text, 128, 34);
  return makeThreeTexture(c);
}

function makePlateTexture(text, bg, fg) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 32;
  const t = c.getContext("2d");
  t.fillStyle = bg;
  t.fillRect(0, 0, 64, 32);
  t.strokeStyle = "rgba(0,0,0,0.5)";
  t.lineWidth = 2;
  t.strokeRect(1, 1, 62, 30);
  t.fillStyle = fg;
  const size = Math.min(22, Math.floor(58 / (text.length * 0.6)));
  t.font = `bold ${size}px "Courier New", monospace`;
  t.textAlign = "center";
  t.textBaseline = "middle";
  t.fillText(text, 32, 17);
  return makeThreeTexture(c);
}

// The door itself, built around its left (hinge) edge. Handles, hinges, plates
// and the rest are real meshes on both faces so it reads as a complete door.
function buildDoorMesh(door) {
  const metal = new THREE.MeshStandardMaterial({ color: door.metal || "#b8963a", roughness: 0.3, metalness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0a0907, roughness: 1 });
  const side = new THREE.MeshStandardMaterial({ color: door.baseColor, roughness: 0.9 });
  const frontMat = new THREE.MeshStandardMaterial({ map: doorTextures[door.id], roughness: 0.8 });
  const backMat = new THREE.MeshStandardMaterial({ map: doorBackTextures[door.id], roughness: 0.8 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W, DOOR_H, DOOR_THICK), [side, side, side, side, frontMat, backMat]);
  slab.position.set(DOOR_W / 2, 0, 0);

  const half = DOOR_THICK / 2;
  const yAt = (h) => h - DOOR_H / 2; // height above the floor -> slab-local y
  const hx = DOOR_W / 2 - 0.09; // handle position, near the free edge
  const put = (mesh, x, y, z) => {
    mesh.position.set(x, y, z);
    slab.add(mesh);
    return mesh;
  };
  const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  const upright = (r, len, m) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), m); // axis along Y
  const deep = (r, len, m) => {
    const c = upright(r, len, m);
    c.rotation.x = Math.PI / 2; // axis along Z
    return c;
  };

  [1, -1].forEach((s) => {
    const z0 = s * half;
    if (door.handle === "knob") {
      put(deep(0.034, 0.012, metal), hx, yAt(1.0), z0 + s * 0.006);
      put(deep(0.011, 0.05, metal), hx, yAt(1.0), z0 + s * 0.03);
      put(new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 10), metal), hx, yAt(1.0), z0 + s * 0.062);
    } else if (door.handle === "lever") {
      put(deep(0.03, 0.01, metal), hx, yAt(1.0), z0 + s * 0.005);
      put(deep(0.01, 0.045, metal), hx, yAt(1.0), z0 + s * 0.027);
      put(box(0.13, 0.022, 0.022, metal), hx - 0.045, yAt(1.0), z0 + s * 0.05);
    } else if (door.handle === "pull") {
      if (s === 1) {
        put(upright(0.014, 0.42, metal), hx, yAt(1.05), z0 + 0.055);
        [-0.17, 0.17].forEach((dy) => put(deep(0.009, 0.055, metal), hx, yAt(1.05) + dy, z0 + 0.027));
      } else {
        put(box(0.1, 0.34, 0.01, metal), hx, yAt(1.05), z0 - 0.005); // push plate on the other side
      }
    } else if (door.handle === "pushbar") {
      const bar = upright(0.014, 0.7, metal);
      bar.rotation.z = Math.PI / 2;
      put(bar, 0, yAt(1.0), z0 + s * 0.05);
      [-0.33, 0.33].forEach((dx) => put(deep(0.012, 0.05, metal), dx, yAt(1.0), z0 + s * 0.025));
    }
    if (door.deadbolt) {
      put(deep(0.03, 0.01, metal), hx, yAt(1.22), z0 + s * 0.005);
      put(deep(0.018, 0.03, metal), hx, yAt(1.22), z0 + s * 0.02);
    }
    if (door.kick) put(box(DOOR_W - 0.1, 0.22, 0.012, metal), 0, yAt(0.15), z0 + s * 0.006);
  });
  // front-face details only
  if (door.keyhole) {
    put(box(0.05, 0.11, 0.008, metal), hx, yAt(0.84), half + 0.004);
    put(box(0.01, 0.034, 0.01, dark), hx, yAt(0.85), half + 0.009);
  }
  if (door.peephole) {
    put(deep(0.016, 0.012, metal), 0, yAt(1.6), half + 0.006);
    put(deep(0.009, 0.014, dark), 0, yAt(1.6), half + 0.008);
  }
  if (door.plate) {
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.07),
      new THREE.MeshStandardMaterial({ map: makePlateTexture(door.plate, "#b89a52", "#2a1f0c"), roughness: 0.4, metalness: 0.5 })
    );
    put(plate, 0, yAt(1.78), half + 0.004);
  }
  [0.25, 1.25, 2.2].forEach((h) => put(upright(0.017, 0.1, metal), -DOOR_W / 2 + 0.003, yAt(h), 0));
  return slab;
}

function addDoorFrame(door) {
  const mat = new THREE.MeshStandardMaterial({ color: door.frame || "#222222", roughness: 0.85 });
  const h = DOOR_H + DOOR_TRIM;
  [-0.47, 0.47].forEach((dx) => {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.06, h, 0.18), mat);
    jamb.position.set(door.x + dx, h / 2, door.y);
    worldGroup.add(jamb);
  });
  const header = new THREE.Mesh(new THREE.BoxGeometry(1.0, DOOR_TRIM, 0.18), mat);
  header.position.set(door.x, DOOR_H + DOOR_TRIM / 2, door.y);
  worldGroup.add(header);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.02, 0.26), new THREE.MeshStandardMaterial({ color: 0x15120f, roughness: 1 }));
  sill.position.set(door.x, 0.01, door.y);
  worldGroup.add(sill);
}

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
  entityBlock = [];
  elevPanels = [];
  elevLight = null;
  elevLightMat = null;
  staffSignMat = null;
  staffSignLight = null;
  solids = [];
  deskLamp = null;
  flickerLights = [];
  swayers = [];
  clearScares();

  const rows = MAP.length;
  const cols = MAP[0].length;
  const interiorMat = new THREE.MeshStandardMaterial({ map: interiorWallTexture, roughness: 0.95 });
  // No moon: the street walls and roof carry a faint cold glow of their own.
  const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTexture, roughness: 0.95, emissive: 0x03050a });
  const lobbyWallMat = new THREE.MeshStandardMaterial({ map: lobbyWallTexture, roughness: 0.95 });
  const facadeGeo = new THREE.BoxGeometry(1, FACADE_H, 1);
  const wallGeo = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);

  const doorCol = Math.floor(FRONT_DOOR.x);
  const doorRow = Math.floor(FRONT_DOOR.y);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (MAP[row][col] !== 1) continue;
      if (col > 21 && row > 12) continue;
      if (col === Math.floor(ELEVATOR.x) && row === Math.floor(ELEVATOR.y - 0.5)) continue; // the elevator cab takes this wall block
      if (doorAtCell(col, row)) continue; // door cells are drawn separately below
      const street = row >= doorRow;
      // the facade row shows the street texture outside and plain lobby wall inside
      const faces = row === doorRow ? [facadeMat, facadeMat, facadeMat, facadeMat, facadeMat, lobbyWallMat] : facadeMat;
      const mesh = new THREE.Mesh(street ? facadeGeo : wallGeo, street ? faces : interiorMat);
      mesh.position.set(col + 0.5, (street ? FACADE_H : WALL_HEIGHT) / 2, row + 0.5);
      worldGroup.add(mesh);
    }
  }

  // Hedges along the left/right edge of the yard, curb along the road.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (MAP[row][col] !== 2) continue;
      if (row === rows - 1) {
        addBox(1, 0.22, 1, col + 0.5, 0.11, row + 0.5, 0x4d4d4a);
      } else {
        addBox(1, 1.1, 1, col + 0.5, 0.55, row + 0.5, 0x182b1b);
        addBox(0.88, 0.22, 0.88, col + 0.5, 1.2, row + 0.5, 0x1d3522);
      }
    }
  }

  // Floor and ceiling are cut where stairs go down (floor) or up through (ceiling).
  const interiorRows = doorRow + 1;
  const holeRect = (s) => ({ x0: s.x0, x1: s.x1, z0: Math.min(s.z0, s.z1), z1: Math.max(s.z0, s.z1) });
  const floorHoles = STAIRS.filter((s) => s.rise < 0).map(holeRect);
  const ceilHoles = STAIRS.filter((s) => s.rise > 0).map(holeRect);
  addPlaneWithHoles(0, -Math.PI / 2, new THREE.MeshStandardMaterial({ color: 0x3a3228, roughness: 1 }), cols, interiorRows, floorHoles);

  const streetRows = rows - doorRow;
  const streetFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(cols, streetRows),
    new THREE.MeshStandardMaterial({ color: 0x232c1f, roughness: 1 })
  );
  streetFloor.rotation.x = -Math.PI / 2;
  streetFloor.position.set(cols / 2, 0, doorRow + streetRows / 2);
  worldGroup.add(streetFloor);

  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x16161e, roughness: 1, side: THREE.DoubleSide }); // solid from below, so no sky shows through
  addPlaneWithHoles(WALL_HEIGHT, Math.PI / 2, ceilMat, cols, interiorRows, ceilHoles);

  // Roof: a cornice that overhangs the facade, and a pitched slope behind it.
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 1, side: THREE.DoubleSide, emissive: 0x020309 });
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

  // Every door is a full hinged door: slab, frame, handles, hinges.
  doorList().forEach((door) => {
    const pivot = new THREE.Group();
    pivot.position.set(door.x - DOOR_W / 2, DOOR_H / 2, door.y);
    pivot.rotation.y = isDoorOpen(door) ? (door.openAngle !== undefined ? door.openAngle : DOOR_OPEN_ANGLE) : 0;
    pivot.add(buildDoorMesh(door));
    worldGroup.add(pivot);
    doorPivots[door.id] = pivot;
    addDoorFrame(door);
  });

  // Fill the wall above each door frame.
  doorList().forEach((door) => {
    const top = door.isFront ? FACADE_H : WALL_HEIGHT;
    const low = DOOR_H + DOOR_TRIM;
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(1, top - low, 1),
      door.isFront ? facadeMat : interiorMat
    );
    lintel.position.set(Math.floor(door.x) + 0.5, low + (top - low) / 2, Math.floor(door.y) + 0.5);
    worldGroup.add(lintel);
  });

  // ---- the entrance: stone surround, canopy on two columns, lit sign, lantern ----
  const fx = FRONT_DOOR.x;
  const faceZ = doorRow + 1; // street face of the facade
  const stone = 0x3a3d39;
  addBox(0.2, 3.2, 0.12, fx - 0.65, 1.6, faceZ + 0.06, stone); // pilasters
  addBox(0.2, 3.2, 0.12, fx + 0.65, 1.6, faceZ + 0.06, stone);
  addBox(1.7, 0.24, 0.16, fx, 2.78, faceZ + 0.08, stone); // header slab over the door
  const address = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.19),
    new THREE.MeshStandardMaterial({ map: makePlateTexture(FRONT_DOOR.plateNumber, "#b89a52", "#2a1f0c"), roughness: 0.4, metalness: 0.5 })
  );
  address.position.set(fx, 2.78, faceZ + 0.165);
  worldGroup.add(address);
  addBox(3.6, 0.16, 2.2, fx, 3.15, faceZ + 1.1, 0x2a2c2b); // canopy
  addBox(3.7, 0.08, 0.1, fx, 3.0, faceZ + 2.15, 0x1c1d1c);
  [fx - 1, fx + 1].forEach((cx) => addBox(0.24, 3.1, 0.24, cx, 1.55, faceZ + 1.5, stone));
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 2.4),
    new THREE.MeshStandardMaterial({ color: 0x353533, roughness: 1 })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(fx, 0.008, faceZ + 1.2);
  worldGroup.add(apron);
  const doormat = new THREE.Mesh(
    new THREE.PlaneGeometry(1.2, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x3a1717, roughness: 1 })
  );
  doormat.rotation.x = -Math.PI / 2;
  doormat.position.set(fx, 0.016, faceZ + 0.5);
  worldGroup.add(doormat);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 0.48),
    new THREE.MeshBasicMaterial({ map: makeSignTexture(FRONT_DOOR.signText, "#14200f", "#c3e182") })
  );
  sign.position.set(fx, 3.75, faceZ + 0.02);
  worldGroup.add(sign);
  addBox(0.02, 0.3, 0.02, fx, 2.95, faceZ + 1.0, 0x1a1a18); // hanging lantern
  const lanternGlass = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.2, 0.16),
    new THREE.MeshBasicMaterial({ color: 0xd4e68c })
  );
  lanternGlass.position.set(fx, 2.7, faceZ + 1.0);
  worldGroup.add(lanternGlass);
  const doorGlow = new THREE.PointLight(0xc3e182, 1.8, 8, 2);
  doorGlow.position.set(fx, 2.6, faceZ + 1.0);
  worldGroup.add(doorGlow);
  const signGlow = new THREE.PointLight(0xc3e182, 0.8, 6, 2);
  signGlow.position.set(fx, 3.6, faceZ + 0.8);
  worldGroup.add(signGlow);

  // The only other light outside: one street lamp, off to the side.
  addOutdoors(cols, rows);

  // The first thing you see on the left, just past the door.
  addReceptionDesk(3.0, 10.8);
  addMailboxes(19.9, 8.8);
  addSofa(15.5, 11.6);
  addPlant(18.6, 8.7);
  addPlant(14.7, 8.7);
  addPlant(19.3, 12.3);
  addRunner(10.5, 5.5, 17, 1.1);
  addStairs();
  FIXTURES.forEach(addFixture);
  addBed(14.5, 1.6); // John's apartment
  addBox(0.5, 0.75, 1.0, 15.45, 0.375, 2.8, 0x2e2419); // his desk
  addSolid(15.45, 2.8, 0.5, 1.0);
  addTable(6.5, 1.5); // apartment 2, where the key is
  addChair(5.4, 2.3);
  const aptLight = new THREE.PointLight(0xffbb66, 0.12, 3, 2);
  aptLight.position.set(6.5, 2.4, 2.2);
  worldGroup.add(aptLight);

  // One weak, cold bulb in the hallway so it isn't a total void.
  if (!state.flags.powerOn) [8.5, 12.5, 16.5].forEach((hx) => {
    const hallLight = new THREE.PointLight(0x8fa0b8, 0.07, 5, 2);
    hallLight.position.set(hx, WALL_HEIGHT * 0.9, 5.5);
    worldGroup.add(hallLight);
  });

  addLevels();
  {
    const inApt = APT_DEFS.find((a) => yawObject.position.x >= a.ox && yawObject.position.x < a.ox + 20);
    if (inApt) addApartment(inApt);
  }
  if (levelOf(yawObject.position.x) === 2) addBasementDecor();
  addFluorescents();
  worldGroup.traverse((o) => { if (o.isPointLight) o.intensity *= 1.1; }); // environment 10% brighter
  NPCS.forEach((npc) => addMarkerSprite(npc.x, npc.y, npc.color, 0.9));
  ITEMS.filter((it) => !state.inventory[it.id] && !it.hidden).forEach((it) => {
    if (it.id === "flashlight") addFlashlightModel(it.x, 0.78, it.y);
    else if (it.id === "johnKey") addKeyModel(it.x, 0.775, it.y);
    else if (it.id === "axe") { if (state.flags.powerOn) addAxeModel(it.x, 0.07, it.y); }
    else if (it.name === "Batteries") [0, 0.07].forEach((o) => addBox(0.05, 0.05, 0.05, it.x, it.h + 0.02, it.y + o - 0.03, 0x9a7a1a));
    else if (it.note) {
      const paper = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.28),
        new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawPaper(document.createElement("canvas"), it.paper, it.sloppy, it.seed)), roughness: 1 })
      );
      paper.rotation.set(-Math.PI / 2, 0, it.seed * 0.7);
      paper.position.set(it.x, (it.h || 0.02) + 0.005, it.y);
      worldGroup.add(paper);
    }
    else addMarkerSprite(it.x, it.y, it.color, 0.4, it.height);
  });
}

// Ceiling fluorescent tubes on the ground floor, switched on by the breaker.
let fluoLights = [];
const FLUORESCENTS = [
  [3.5, 10.5], [8.5, 9.5], [13.5, 10.5], [17.5, 9.5], // lobby
  [8.5, 6.0], [12.5, 6.0], [17.0, 6.0], // hallway
  [6.5, 2.0], [14.5, 2.0], // apartment 2, John's room
  [18.5, 3.4], // stairwell
  [3.0, 6.0], // staff room
];
function addFluorescents() {
  fluoLights = [];
  const px = yawObject.position.x;
  if (!state.flags.powerOn || (px >= 21 && px < APT_X0)) return;
  let spots = FLUORESCENTS;
  let power = 20;
  let reach = 14;
  if (px >= APT_X0) {
    const a = APT_DEFS.find((d) => px >= d.ox && px < d.ox + 20);
    spots = a ? [[a.ox + 14.5, 3.6], [a.ox + 17, 10]] : [];
    power = 13;
    reach = 9;
  }
  const tubeMat = new THREE.MeshBasicMaterial({ color: 0xeaf6e0 });
  spots.forEach(([x, z]) => {
    addBox(1.3, 0.05, 0.22, x, WALL_HEIGHT - 0.03, z, 0x9a9a96); // housing
    const tube = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.03, 0.12), tubeMat);
    tube.position.set(x, WALL_HEIGHT - 0.07, z);
    worldGroup.add(tube);
    const l = new THREE.PointLight(0xe4f2dc, power, reach, 2);
    l.position.set(x, WALL_HEIGHT - 0.2, z);
    worldGroup.add(l);
    l.userData.base = power;
    fluoLights.push(l);
  });
}

let fluoTimer = 0;
function updateFluorescents(dt) {
  if (!fluoLights.length) return;
  fluoTimer -= dt;
  if (fluoTimer > 0) return;
  fluoTimer = 0.06 + Math.random() * 0.12;
  fluoLights.forEach((l) => (l.intensity = l.userData.base * 1.1));
  if (Math.random() < 0.05) {
    const l = fluoLights[Math.floor(Math.random() * fluoLights.length)];
    l.intensity = l.userData.base * 1.1 * (0.15 + Math.random() * 0.4); // a tube stutters
  }
}

function addAxeModel(x, y, z) {
  const g = buildAxeGroup();
  g.position.set(x, y, z);
  g.rotation.y = 0.5;
  worldGroup.add(g);
}


// ---- the apartments --------------------------------------------------------------------
let tileTex = null;
function getTileTexture() {
  if (tileTex) return tileTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  x.fillStyle = "#5a574d";
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = "#48453c";
  x.fillRect(0, 0, 32, 32);
  x.fillRect(32, 32, 32, 32);
  x.strokeStyle = "#25231f";
  x.lineWidth = 3;
  x.strokeRect(0, 0, 64, 64);
  x.beginPath();
  x.moveTo(32, 0); x.lineTo(32, 64); x.moveTo(0, 32); x.lineTo(64, 32);
  x.stroke();
  tileTex = new THREE.CanvasTexture(c);
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
  return tileTex;
}
function flatTiles(x0, z0, w, d) {
  const t = getTileTexture().clone();
  t.repeat.set(w / 0.7, d / 0.7);
  t.needsUpdate = true;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x0 + w / 2, 0.006, z0 + d / 2);
  worldGroup.add(m);
}

function addApartment(a) {
  const ox = a.ox;
  const dmg = APT_DAMAGE[a.id];
  let seed = (ox * 7919) % 2147483647 || 17;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // furniture group: local origin = centre on the floor, faces +z (south) at rot 0
  const furn = (rx, rz, rot, solid, build) => {
    const G = new THREE.Group();
    G.position.set(ox + rx, 0, rz);
    G.rotation.y = rot || 0;
    worldGroup.add(G);
    buildTarget = G;
    build((w, h, d, x, y, z, c) => addBox(w, h, d, x, y, z, c));
    buildTarget = null;
    if (solid) addSolid(ox + rx, rz, solid[0], solid[1]);
    return G;
  };
  const wood = 0x4a3524, darkwood = 0x2f2218, white = 0xb4b0a2, grime = 0x2c2a26;

  // tiled floors in the kitchen and bathroom
  flatTiles(ox + 10, 1, 9, 6);
  flatTiles(ox + 15, 8, 4, 4);

  // ---- kitchen (north wall: counter, stove, counter, fridge; cabinets above)
  furn(11.4, 1.35, 0, [2.2, 0.6], (b) => {
    b(2.2, 0.85, 0.6, 0, 0.43, 0, wood);
    b(2.24, 0.05, 0.64, 0, 0.88, 0, 0x2a2926);
    b(0.55, 0.03, 0.4, -0.3, 0.9, 0.02, 0x15150f); // sink
    b(0.04, 0.22, 0.04, -0.3, 1.0, -0.2, 0x8a8a86);
    b(0.12, 0.03, 0.04, -0.3, 1.1, -0.12, 0x8a8a86);
    [-0.7, 0.2, 0.7].forEach((x) => b(0.02, 0.5, 0.02, x, 0.42, 0.31, grime));
  });
  furn(13.0, 1.4, 0, [0.8, 0.7], (b) => {
    b(0.78, 0.88, 0.66, 0, 0.44, 0, white);
    [[-0.2, -0.15], [0.2, -0.15], [-0.2, 0.15], [0.2, 0.15]].forEach(([x, z]) => b(0.2, 0.02, 0.2, x, 0.9, z, 0x1a1a1a));
    b(0.62, 0.34, 0.02, 0, 0.42, 0.34, 0x151515); // oven window
    [-0.25, 0, 0.25].forEach((x) => b(0.05, 0.05, 0.03, x, 0.78, 0.34, 0x8a8a86));
    b(0.82, 0.22, 0.55, 0, 2.0, -0.05, 0x8a8a84); // range hood
    b(0.26, 0.5, 0.26, 0, 2.36, -0.18, 0x7a7a76);
  });
  furn(14.2, 1.35, 0, [1.6, 0.6], (b) => {
    b(1.6, 0.85, 0.6, 0, 0.43, 0, wood);
    b(1.64, 0.05, 0.64, 0, 0.88, 0, 0x2a2926);
    [-0.4, 0.4].forEach((x) => b(0.02, 0.4, 0.02, x, 0.5, 0.31, grime));
  });
  furn(15.6, 1.45, 0, [0.8, 0.75], (b) => {
    b(0.76, 1.75, 0.7, 0, 0.88, 0, 0xa7a597);
    b(0.78, 0.02, 0.02, 0, 1.15, 0.36, 0x333330); // seam between the doors
    b(0.03, 0.4, 0.04, 0.3, 1.45, 0.38, 0x77756e);
    b(0.03, 0.3, 0.04, 0.3, 0.8, 0.38, 0x77756e);
  });
  [[11.4, 2.2, 0], [14.2, 2.0, 0.3]].forEach(([x, w, ajar]) => furn(x, 1.2, 0, null, (b) => {
    b(w, 0.75, 0.36, 0, 1.95, 0, wood);
    for (let i = 0; i < Math.round(w / 0.5); i++) b(0.012, 0.7, 0.02, -w / 2 + 0.5 * (i + 1), 1.95, 0.19, darkwood);
    if (ajar) { const door = b(0.45, 0.7, 0.03, w / 2 + 0.05, 1.95, 0.35, wood); door.rotation.y = 0.9; } // a door hanging open
  }));
  // table with two chairs
  furn(16.5, 4.4, 0, [1.2, 0.8], (b) => {
    b(1.2, 0.05, 0.8, 0, 0.75, 0, 0x4d3a28);
    [[-0.55, -0.35], [0.55, -0.35], [-0.55, 0.35], [0.55, 0.35]].forEach(([x, z]) => b(0.05, 0.75, 0.05, x, 0.37, z, darkwood));
  });
  [[15.3, 4.4, -Math.PI / 2], [17.7, 4.4, Math.PI / 2]].forEach(([x, z, r]) => furn(x, z, r, [0.4, 0.4], (b) => {
    b(0.4, 0.04, 0.4, 0, 0.45, 0, darkwood);
    b(0.4, 0.45, 0.04, 0, 0.7, -0.18, darkwood);
    [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]].forEach(([cx, cz]) => b(0.04, 0.45, 0.04, cx, 0.22, cz, darkwood));
  }));
  furn(18.3, 6.4, 0, null, () => {
    const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.3, 10), new THREE.MeshStandardMaterial({ color: 0x6a6c70, roughness: 0.7 }));
    bucket.position.y = 0.15;
    buildTarget.add(bucket);
  });

  // ---- bedroom
  furn(6.5, 2.3, 0, [1.4, 2.0], (b) => {
    [[-0.65, -0.95], [0.65, -0.95], [-0.65, 0.95], [0.65, 0.95]].forEach(([x, z]) => b(0.06, 0.32, 0.06, x, 0.16, z, darkwood));
    b(1.4, 0.08, 2.0, 0, 0.34, 0, darkwood);
    b(1.3, 0.16, 1.9, 0, 0.46, 0, 0x6a665a); // stained mattress
    b(0.55, 0.1, 0.36, 0, 0.6, -0.65, 0x8a8678);
    b(1.3, 0.06, 1.1, 0, 0.56, 0.3, 0x4a2a2a);
    b(1.42, 0.75, 0.06, 0, 0.7, -1.0, darkwood);
  });
  furn(8.0, 1.5, 0, [0.5, 0.5], (b) => {
    b(0.5, 0.55, 0.5, 0, 0.28, 0, wood);
    b(0.4, 0.14, 0.02, 0, 0.38, 0.26, darkwood);
    b(0.04, 0.04, 0.03, 0, 0.38, 0.28, 0x8a8a76);
  });
  furn(2.0, 1.6, 0, [1.0, 0.5], (b) => {
    b(1.0, 0.9, 0.5, 0, 0.45, 0, wood);
    [0.2, 0.5, 0.78].forEach((y) => { b(0.9, 0.012, 0.02, 0, y, 0.26, darkwood); b(0.05, 0.03, 0.03, 0, y - 0.1, 0.27, 0x8a8a76); });
  });
  furn(4.3, 1.5, 0, [1.2, 0.6], (b) => {
    b(1.2, 0.05, 0.6, 0, 0.74, 0, wood);
    b(0.04, 0.72, 0.56, -0.56, 0.36, 0, darkwood);
    b(0.04, 0.72, 0.56, 0.56, 0.36, 0, darkwood);
    b(0.5, 0.4, 0.5, 0.28, 0.5, 0, darkwood); // drawers
  });
  furn(4.3, 2.4, Math.PI, [0.4, 0.4], (b) => {
    b(0.4, 0.04, 0.4, 0, 0.45, 0, darkwood);
    b(0.4, 0.45, 0.04, 0, 0.7, -0.18, darkwood);
    [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]].forEach(([cx, cz]) => b(0.04, 0.45, 0.04, cx, 0.22, cz, darkwood));
  });
  furn(1.5, 5.4, Math.PI / 2, [0.6, 1.3], (b) => {
    b(1.3, 1.95, 0.6, 0, 0.98, 0, wood);
    b(0.012, 1.8, 0.02, 0, 0.98, 0.31, darkwood);
    b(0.04, 0.1, 0.04, -0.08, 1.0, 0.33, 0x8a8a76);
    b(0.04, 0.1, 0.04, 0.08, 1.0, 0.33, 0x8a8a76);
  });
  const rug = (rx, rz, w, d, c) => addBox(w, 0.012, d, ox + rx, 0.009, rz, c);
  rug(4.8, 4.6, 2.4, 1.7, 0x3b2323);

  // ---- living room
  furn(8.2, 8.55, 0, [2.0, 0.9], (b) => {
    b(2.0, 0.4, 0.9, 0, 0.24, 0, 0x4a4036);
    b(2.0, 0.5, 0.22, 0, 0.62, -0.34, 0x4a4036);
    b(0.2, 0.55, 0.9, -0.9, 0.38, 0, 0x3e362e);
    b(0.2, 0.55, 0.9, 0.9, 0.38, 0, 0x3e362e);
    b(0.8, 0.1, 0.6, -0.3, 0.48, 0.08, 0x554a3e);
    b(0.8, 0.1, 0.6, 0.45, 0.48, 0.08, 0x554a3e);
  });
  furn(8.2, 10.2, 0, [1.0, 0.5], (b) => {
    b(1.0, 0.04, 0.5, 0, 0.4, 0, darkwood);
    [[-0.45, -0.2], [0.45, -0.2], [-0.45, 0.2], [0.45, 0.2]].forEach(([x, z]) => b(0.04, 0.4, 0.04, x, 0.2, z, darkwood));
  });
  furn(11.0, 11.5, Math.PI, [1.2, 0.5], (b) => {
    b(1.2, 0.5, 0.45, 0, 0.25, 0, wood);
    b(0.62, 0.5, 0.46, 0, 0.78, 0, 0x1c1c1e); // old TV
    b(0.5, 0.36, 0.02, 0, 0.78, 0.24, 0x0c0e0d);
    b(0.04, 0.3, 0.04, 0.15, 1.15, 0, 0x555552);
  });
  furn(1.5, 10.2, Math.PI / 2, [0.35, 1.4], (b) => {
    b(1.4, 1.7, 0.35, 0, 0.85, -0.01, darkwood);
    [0.3, 0.7, 1.1, 1.5].forEach((y) => {
      b(1.3, 0.03, 0.34, 0, y, 0.02, wood);
      for (let i = 0; i < 6; i++) b(0.05, 0.22 + rnd() * 0.08, 0.2, -0.55 + i * 0.2 + rnd() * 0.05, y + 0.13, 0.02, [0x5a2a2a, 0x2a3a4a, 0x3a4a2a, 0x4a3a2a][i % 4]);
    });
  });
  furn(1.6, 8.6, 0, [0.4, 0.4], (b) => b(0.4, 0.55, 0.4, 0, 0.28, 0, wood));
  rug(8.0, 10.0, 3.2, 2.0, 0x2e2630);

  // ---- bathroom
  furn(18.4, 11.4, 0, [0.45, 0.7], (b) => {
    b(0.4, 0.45, 0.5, 0, 0.23, -0.05, 0xc2beb0);
    b(0.38, 0.04, 0.46, 0, 0.47, -0.05, 0x9a968a);
    b(0.4, 0.4, 0.2, 0, 0.62, 0.25, 0xc2beb0); // tank
    b(0.06, 0.04, 0.04, 0.1, 0.84, 0.25, 0x8a8a86);
  });
  furn(18.5, 9.0, 0, [0.8, 1.7], (b) => {
    b(0.8, 0.5, 1.7, 0, 0.25, 0, 0xb8b4a6);
    b(0.62, 0.04, 1.5, 0, 0.51, 0, 0x242820); // stained water line
    b(0.04, 0.2, 0.04, 0, 0.62, -0.8, 0x8a8a86);
  });
  furn(16.5, 11.6, 0, [0.6, 0.45], (b) => {
    b(0.2, 0.7, 0.2, 0, 0.35, 0, 0xb4b0a2);
    b(0.55, 0.16, 0.4, 0, 0.8, 0, 0xc2beb0);
    b(0.04, 0.12, 0.04, 0, 0.94, -0.12, 0x8a8a86);
  });
  const mirror = addBox(0.55, 0.75, 0.02, ox + 16.5, 1.55, 11.97, 0x1a2224); // cracked mirror
  [[0.2, 0.01], [-0.1, 0.01]].forEach(([x], i) => { const c = addBox(0.01, 0.5, 0.01, ox + 16.5 + x, 1.55, 11.95, 0x8a9a9a); c.rotation.z = i ? 0.5 : -0.4; });

  // ---- the front door (inside face), south wall of the living room
  const door = DOORS.find((dr) => dr.id === a.door);
  const dtex = makeThreeTexture(createStyledDoorTexture(door.style, door.plate, door.baseColor, true));
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 2.55), new THREE.MeshStandardMaterial({ map: dtex, roughness: 0.6 }));
  panel.rotation.y = Math.PI;
  panel.position.set(ox + 3.5, 1.28, 11.96);
  worldGroup.add(panel);
  addBox(1.14, 2.7, 0.05, ox + 3.5, 1.35, 11.98, 0x1c1814);

  // ---- damage: holes in the floor and ceiling
  (dmg.holes || []).forEach(([x, z, w, d]) => {
    addBox(w, 0.02, d, ox + x, 0.012, z, 0x030303);
    for (let i = 0; i < 6; i++) {
      const s = addBox(0.05, 0.03, 0.4 + rnd() * 0.3, ox + x + (rnd() - 0.5) * w, 0.03, z + (rnd() - 0.5) * d, 0x3a2a1c);
      s.rotation.y = rnd() * 3;
      s.rotation.z = (rnd() - 0.5) * 0.8;
    }
    addSolid(ox + x, z, w, d);
  });
  (dmg.ceil || []).forEach(([x, z, w, d]) => {
    addBox(w, 0.02, d, ox + x, WALL_HEIGHT - 0.012, z, 0x020202);
    const flap = addBox(0.6, 0.03, 0.5, ox + x + w / 2, WALL_HEIGHT - 0.25, z, 0x5a5448);
    flap.rotation.z = 0.7;
  });

  // ---- mess on the floor
  const mess = [0x4a463e, 0x5a5448, 0x6a6558, 0x3a2a1c, 0x2c2c2a];
  for (let i = 0; i < dmg.mess; i++) {
    const rx = 1.3 + rnd() * 17.4;
    const rz = 1.3 + rnd() * 10.4;
    if (isWall(ox + rx, rz) || solids.some((s) => ox + rx > s.minX - 0.1 && ox + rx < s.maxX + 0.1 && rz > s.minZ - 0.1 && rz < s.maxZ + 0.1)) continue;
    const s = 0.05 + rnd() * 0.13;
    const m = addBox(s, s * (0.2 + rnd() * 0.5), s * (0.6 + rnd()), ox + rx, s * 0.15, rz, rnd() < 0.3 ? 0x9a9688 : mess[i % mess.length]);
    m.rotation.y = rnd() * 3;
  }
}

// Basement, upstairs: the extra levels live in the far east of the map.
function addLevels() {
  // basement (cols 46-69): boiler room, storage room, corridor blocked by rubble
  addBox(1.4, 0.8, 0.6, 50.5, 0.4, 1.5, 0x3a2a1c); // workbench
  addSolid(50.5, 1.5, 1.4, 0.6);
  addBox(1.2, 1.7, 1.2, 53.5, 0.85, 5.1, 0x2d2d2a); // boiler
  addBox(0.3, 1.0, 0.3, 53.5, 2.2, 5.1, 0x242422);
  addSolid(53.5, 5.1, 1.2, 1.2);
  addBox(0.8, 0.5, 0.5, 50.5, 0.25, 9.4, 0x3a2a1c); // crate with the batteries on it
  addSolid(50.5, 9.4, 0.8, 0.5);
  addBox(0.7, 0.7, 0.7, 53.4, 0.35, 10.4, 0x2f2a22);
  addSolid(53.4, 10.4, 0.7, 0.7);
  [[59.5, 3.5, 1.3], [59.3, 3.2, 0.9], [59.7, 3.8, 0.8], [59.2, 3.9, 0.6]].forEach(([x, z, s], i) => {
    const r = addBox(s, s, s, x, s / 2, z, i % 2 ? 0x3a3835 : 0x2a2927);
    r.rotation.y = i * 0.7;
  });
  // flickering STAFF sign over the staff door, on the lobby side
  staffSignMat = new THREE.MeshBasicMaterial({ map: makeSignTexture("STAFF", "#10140f", "#d7e6a8") });
  const staffSign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.225), staffSignMat);
  staffSign.position.set(3.5, 2.82, 8.02);
  worldGroup.add(staffSign);
  staffSignLight = new THREE.PointLight(0xd7e6a8, STAFF_SIGN_LEVEL, 4, 2);
  staffSignLight.position.set(3.5, 2.6, 8.4);
  worldGroup.add(staffSignLight);
  // staff room (west end of the hallway): shelf, mop bucket, breaker panel
  addBox(1.2, 1.6, 0.35, 1.8, 0.8, 6.8, 0x2a2118);
  addBox(0.3, 0.3, 0.3, 4.5, 0.15, 6.5, 0x3a3a3c);
  addSolid(1.8, 6.8, 1.2, 0.35);
  addSolid(4.5, 6.5, 0.3, 0.3);
  addBox(0.5, 0.6, 0.12, 2.0, 1.55, 5.06, 0x4a4d4f);
  addBox(0.05, 0.22, 0.05, 2.0, 1.55, 5.15, state.flags.powerOn ? 0x3aa14a : 0xaa2222);
  const sl = new THREE.PointLight(0xffe0b0, 0.3, 4, 2);
  sl.position.set(3, 2.5, 6);
  worldGroup.add(sl);
  // faint bulbs so each level isn't a void (only built for the level you're on)
  const px = yawObject.position.x;
  const bulbs = px >= APT_X0 ? [] : px >= 46 ? [[50.5, 2.5, 3.0], [50.5, 2.5, 9.5], [57, 2.5, 3.5]] : px >= 21 ? [[25, 2.5, 6.5], [31, 2.5, 6.5], [37, 2.5, 6.5], [43, 2.5, 6.5]] : [];
  bulbs.forEach(([x, y, z]) => {
    const l = new THREE.PointLight(0x8fa0b8, 0.09, 6, 2);
    l.position.set(x, y, z);
    worldGroup.add(l);
  });
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

  const lamp = new THREE.PointLight(0xffdca0, 1.3, 6, 2);
  lamp.position.set(x, 2.55, z);
  worldGroup.add(lamp);
  return lamp;
}

// A creepy old reception desk: a dark, worn desk with a single dim,
// flickering lamp — barely enough light to see the desk itself, let alone
// the room around it.
// Built in its own frame (x along the desk, +z = customer side), then turned so the
// customer side faces east into the lobby and the drawers/chair are on the west-wall side.
function addReceptionDesk(cx, cz) {
  const G = new THREE.Group();
  G.position.set(cx, 0, cz);
  G.rotation.y = Math.PI / 2;
  buildTarget = G;
  const x = 0;
  const z = 0;
  addSolid(cx, cz, 0.72, 1.72);
  addSolid(cx - 0.85, cz + 0.2, 0.5, 0.5); // its chair
  const open = state.flags.drawers || 0;
  addBox(1.6, 0.7, 0.6, x, 0.35, z, 0x4a3826);
  addBox(1.72, 0.05, 0.72, x, 0.725, z, 0x5d4631); // top
  const zf = z - 0.3;
  for (let i = 0; i < 3; i++) {
    const y = 0.2 + i * 0.19;
    const o = i < open ? 0.28 : 0;
    addBox(0.5, 0.16, 0.03, x + 0.45, y, zf - 0.015 - o, 0x6a5238);
    addBox(0.1, 0.02, 0.03, x + 0.45, y, zf - 0.04 - o, 0xb8963a); // pull
    if (i < open) {
      addBox(0.46, 0.03, 0.28, x + 0.45, y - 0.07, zf - 0.14, 0x1a1510);
      addBox(0.02, 0.1, 0.28, x + 0.22, y - 0.03, zf - 0.14, 0x1a1510);
      addBox(0.02, 0.1, 0.28, x + 0.68, y - 0.03, zf - 0.14, 0x1a1510);
    }
  }
  if (open >= 3 && !state.inventory.staffKey) {
    addKeyModel(x + 0.45, 0.545, zf - 0.14); // the staff key, lying in the open drawer
  }
  // things on the desk: old monitor, phone, bell, papers, pens, the guest log
  addBox(0.2, 0.03, 0.15, x - 0.55, 0.765, z - 0.15, 0x1a1a18);
  addBox(0.36, 0.28, 0.3, x - 0.55, 0.92, z - 0.15, 0x2a2a28);
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.2, 0.01), new THREE.MeshStandardMaterial({ color: 0x0a0f0c, emissive: 0x08150d }));
  screen.position.set(x - 0.55, 0.93, z);
  G.add(screen);
  addBox(0.16, 0.06, 0.2, x + 0.62, 0.78, z + 0.1, 0x15151a);
  addBox(0.14, 0.03, 0.04, x + 0.62, 0.82, z + 0.1, 0x0c0c10);
  addBox(0.07, 0.04, 0.07, x + 0.65, 0.77, z - 0.1, 0xb8963a);
  addBox(0.25, 0.04, 0.18, x - 0.05, 0.77, z - 0.15, 0xcfc6a8);
  addBox(0.05, 0.09, 0.05, x - 0.05, 0.8, z + 0.2, 0x222222);
  addBox(0.27, 0.012, 0.35, x - 0.35, 0.756, z + 0.1, 0x3a2a1c); // clipboard
  const logSheet = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.28),
    new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawPaper(document.createElement("canvas"), GUEST_PAPER.paper, GUEST_PAPER.sloppy, GUEST_PAPER.seed)), roughness: 1 })
  );
  logSheet.rotation.set(-Math.PI / 2, 0, 0.05);
  logSheet.position.set(x - 0.35, 0.766, z + 0.1);
  G.add(logSheet);

  // A proper desk lamp: round base, arm, open metal shade, glowing yellow bulb.
  const lx = x + 0.5;
  const lz = z - 0.2;
  const metal = new THREE.MeshStandardMaterial({ color: 0x1d2a22, roughness: 0.5, metalness: 0.4 });
  const lbase = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.03, 14), metal);
  lbase.position.set(lx, 0.765, lz);
  const lstem = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.3, 0.025), metal);
  lstem.position.set(lx, 0.93, lz);
  const larm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.022, 0.022), metal);
  larm.position.set(lx - 0.09, 1.08, lz);
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.15, 0.14, 14, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x1d2a22, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide })
  );
  shade.position.set(lx - 0.2, 1.06, lz);
  deskBulbMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 10), deskBulbMat);
  bulb.position.set(lx - 0.2, 1.0, lz);
  [lbase, lstem, larm, shade, bulb].forEach((m) => G.add(m));

  deskLamp = new THREE.PointLight(0xffb347, DESK_LAMP_LEVEL, 8, 2);
  deskLamp.position.set(lx - 0.2, 0.96, lz);
  G.add(deskLamp);

  // RECEPTION plate on the customer-facing side
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.18),
    new THREE.MeshStandardMaterial({ map: makePlateTexture("RECEPTION", "#b89a52", "#2a1f0c"), roughness: 0.4, metalness: 0.5 })
  );
  plate.position.set(x, 0.5, z + 0.305);
  G.add(plate);

  // office chair pushed back behind the desk
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x4a2f26, roughness: 0.9 });
  const chz = z - 0.85;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.46), seatMat);
  seat.position.set(x - 0.2, 0.5, chz);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.55, 0.07), seatMat);
  back.position.set(x - 0.2, 0.82, chz - 0.22);
  back.rotation.x = -0.12;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), metal);
  pole.position.set(x - 0.2, 0.26, chz);
  [seat, back, pole].forEach((m) => {
    m.rotation.y += 0.35;
    G.add(m);
  });
  for (let i = 0; i < 5; i++) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.04), metal);
    leg.position.set(x - 0.2, 0.05, chz);
    leg.rotation.y = (i * Math.PI * 2) / 5 + 0.35;
    leg.translateX(0.14);
    G.add(leg);
  }
  buildTarget = null;
  worldGroup.add(G);
}

// Staircase filling the back of the stairwell room: steps rise to the ceiling
// where the way up is boarded over.
// A horizontal plane covering cols x depth, with axis-aligned rectangular holes cut out of it.
function addPlaneWithHoles(y, rotX, mat, width, depth, holes) {
  const zs = [0, depth];
  holes.forEach((h) => zs.push(h.z0, h.z1));
  const zlist = [...new Set(zs.filter((z) => z >= 0 && z <= depth))].sort((a, b) => a - b);
  for (let i = 0; i < zlist.length - 1; i++) {
    const za = zlist[i];
    const zb = zlist[i + 1];
    const cuts = holes.filter((h) => h.z0 <= za + 1e-6 && h.z1 >= zb - 1e-6).sort((a, b) => a.x0 - b.x0);
    let x = 0;
    const segs = [];
    cuts.forEach((h) => {
      if (h.x0 > x) segs.push([x, h.x0]);
      x = Math.max(x, h.x1);
    });
    if (x < width) segs.push([x, width]);
    segs.forEach(([xa, xb]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(xb - xa, zb - za), mat);
      m.rotation.x = rotX;
      m.position.set((xa + xb) / 2, y, (za + zb) / 2);
      worldGroup.add(m);
    });
  }
}

// Every staircase: solid steps (or steps cut down below the floor), railings, tall shafts for the ones that climb.
function addStairs() {
  const N = STAIR_STEPS;
  const stone = 0x34343a;
  STAIRS.forEach((s) => {
    const dz = (s.z1 - s.z0) / N;
    const depth = Math.abs(dz);
    const w = s.x1 - s.x0;
    const cx = (s.x0 + s.x1) / 2;
    const zlo = Math.min(s.z0, s.z1);
    const zhi = Math.max(s.z0, s.z1);
    for (let i = 0; i < N; i++) {
      const zmid = s.z0 + dz * (i + 0.5);
      const top = (s.rise * (i + 1)) / N;
      if (s.rise > 0) addBox(w, top, depth, cx, top / 2, zmid, stone);
      else {
        const bottom = s.rise - 0.1;
        addBox(w, top - bottom, depth, cx, (top + bottom) / 2, zmid, stone);
      }
    }
    // worn steps: a lighter nosing on every tread, and a banister with posts down each side
    for (let i = 0; i < N; i++) {
      const top = (s.rise * (i + 1)) / N;
      addBox(w - 0.04, 0.03, 0.05, cx, top + 0.015, s.z0 + dz * i + (dz < 0 ? -0.025 : 0.025), 0x55555c);
    }
    const run = zhi - zlo;
    const len = Math.hypot(run, s.rise);
    [s.x0 + 0.05, s.x1 - 0.05].forEach((rx) => {
      const rail = addBox(0.05, 0.05, len, rx, s.rise / 2 + 0.95, (s.z0 + s.z1) / 2, 0x2a1a10);
      rail.rotation.x = Math.atan2(s.rise, run);
      for (let i = 0; i <= 4; i++) {
        const pz = s.z0 + ((s.z1 - s.z0) * i) / 4;
        const ph = (s.rise * i) / 4;
        addBox(0.04, 0.95, 0.04, rx, ph + 0.48, pz, 0x2a1a10);
      }
    });
    // railings you can't walk through
    addSolid(s.x0 - 0.03, (zlo + zhi) / 2, 0.06, zhi - zlo);
    addSolid(s.x1 + 0.03, (zlo + zhi) / 2, 0.06, zhi - zlo);
    entityBlock.push({ minX: s.x0 - 0.2, maxX: s.x1 + 0.2, minZ: zlo - 0.2, maxZ: zhi + 0.4 });
    if (s.rise < 0) {
      // the shaft below the floor
      const d = -s.rise + 0.1;
      addBox(0.1, d, zhi - zlo + 0.1, s.x0 - 0.05, -d / 2, (zlo + zhi) / 2, 0x1c1c1e);
      addBox(0.1, d, zhi - zlo + 0.1, s.x1 + 0.05, -d / 2, (zlo + zhi) / 2, 0x1c1c1e);
      addBox(w + 0.2, d, 0.1, cx, -d / 2, zlo - 0.05, 0x1c1c1e);
    } else {
      // a walled shaft rising through the ceiling, capped above
      const top = WALL_HEIGHT + s.rise + 0.4;
      addBox(0.1, top, zhi - zlo + 0.1, s.x0 - 0.05, top / 2, (zlo + zhi) / 2, 0x2b2a2c);
      addBox(0.1, top, zhi - zlo + 0.1, s.x1 + 0.05, top / 2, (zlo + zhi) / 2, 0x2b2a2c);
      addBox(w + 0.2, top, 0.1, cx, top / 2, zlo - 0.05, 0x2b2a2c);
      addBox(w + 0.2, top - WALL_HEIGHT, 0.1, cx, (top + WALL_HEIGHT) / 2, zhi + 0.05, 0x2b2a2c);
      const cap = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.2, zhi - zlo + 0.2), new THREE.MeshStandardMaterial({ color: 0x16161e, side: THREE.DoubleSide }));
      cap.rotation.x = Math.PI / 2;
      cap.position.set(cx, top, (zlo + zhi) / 2);
      worldGroup.add(cap);
    }
  });
  // Boards nailed across the ground-floor flight, until they're chopped.
  const up = STAIRS[0];
  if (!state.flags.boardsChopped) {
    const zb = 2.5;
    const base = floorHeight(17.75, zb);
    [0.3, 0.62, 0.94, 1.26].forEach((dy, i) => {
      const plank = addBox(1.6, 0.17, 0.05, (up.x0 + up.x1) / 2, base + dy, zb - (i % 2) * 0.05, 0x3a2a1c);
      plank.rotation.z = ((i % 3) - 1) * 0.07;
    });
    addSolid((up.x0 + up.x1) / 2, zb, up.x1 - up.x0, 0.35);
  }
  const bulb = new THREE.PointLight(0xaabbaa, 0.1, 4, 2);
  bulb.position.set(17.75, 2.5, 3.4);
  worldGroup.add(bulb);
  // a failing red emergency lamp on the stairwell wall
  const lvl = levelOf(yawObject.position.x);
  if (yawObject.position.x < 21) {
    addBox(0.2, 0.12, 0.1, 18.5, 2.7, 1.2, 0x400808);
    const red = new THREE.PointLight(0xff1a0a, 0.9, 5, 2);
    red.position.set(18.5, 2.5, 1.9);
    worldGroup.add(red);
    flickerLights.push({ light: red, base: 0.9, phase: Math.random() * 9 });
  }
}

// The basement: pipes, chains, a glowing boiler, stains and a cage, so it feels lived-in and wrong.
function addBasementDecor() {
  const rust = 0x4a2e1c;
  [2.0, 9.0].forEach((z) => addBox(8.2, 0.12, 0.12, 50.8, 2.75, z, 0x2a2624)); // ceiling pipes
  addBox(0.12, 0.12, 8.5, 53.9, 2.6, 6.5, 0x2a2624);
  addBox(0.25, 0.25, 0.25, 51.5, 2.75, 2.0, rust); // pipe joints
  addBox(0.25, 0.25, 0.25, 54.0, 2.6, 5.0, rust);
  // chains hanging from hooks, swaying
  [[52.2, 2.6], [48.6, 9.6], [51.4, 6.2]].forEach(([x, z], i) => {
    const grp = new THREE.Group();
    grp.position.set(x, 2.9, z);
    for (let k = 0; k < 7; k++) {
      const link = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.09, 0.04), new THREE.MeshStandardMaterial({ color: 0x55534f, metalness: 0.6, roughness: 0.5 }));
      link.position.y = -k * 0.1;
      grp.add(link);
    }
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x55534f, metalness: 0.6 }));
    hook.position.y = -0.72;
    grp.add(hook);
    worldGroup.add(grp);
    swayers.push({ grp, phase: i * 2.1 });
  });
  // dried stains on the floor, a smeared trail towards the dark
  [[49.8, 3.6, 0.9, 0.5], [50.9, 4.4, 0.6, 0.35], [50.4, 6.9, 0.5, 0.9], [52.0, 10.0, 1.0, 0.7]].forEach(([x, z, w, d], i) => {
    const s = addBox(w, 0.012, d, x, 0.008, z, 0x330808);
    s.rotation.y = i * 0.9;
  });
  // a rusted cage and shelving, both solid
  addBox(0.05, 1.5, 1.2, 47.3, 0.75, 10.5, rust);
  addBox(1.0, 0.05, 1.2, 47.8, 1.5, 10.5, rust);
  [10.0, 10.5, 11.0].forEach((z) => addBox(0.04, 1.5, 0.04, 48.3, 0.75, z, rust));
  addSolid(47.8, 10.5, 1.0, 1.2);
  addBox(0.5, 1.7, 1.4, 54.6, 0.85, 10.2, 0x2a2018);
  [0.5, 1.0, 1.5].forEach((h) => addBox(0.45, 0.04, 1.4, 54.6, h, 10.2, 0x3a2c1e));
  [[0.65, 9.8], [1.15, 10.3], [0.65, 10.6]].forEach(([h, z]) => addBox(0.18, 0.25, 0.18, 54.6, h + 0.1, z, 0x6a7a5a)); // jars
  addSolid(54.6, 10.2, 0.5, 1.4);
  // the boiler still glows, as if it were burning
  const fire = new THREE.PointLight(0xff6a1a, 1.4, 6, 2);
  fire.position.set(53.5, 1.0, 5.9);
  worldGroup.add(fire);
  flickerLights.push({ light: fire, base: 1.4, phase: 3 });
  addBox(0.5, 0.35, 0.05, 53.5, 0.6, 5.72, 0xff7a20); // the grate
  // a red emergency bulb over the stair
  const red = new THREE.PointLight(0xff1a0a, 0.7, 5, 2);
  red.position.set(48.0, 2.6, 4.6);
  worldGroup.add(red);
  flickerLights.push({ light: red, base: 0.7, phase: 7 });
}


// A door-looking panel stuck to the lobby side of a wall (nothing behind it).
function addFixture(f) {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(f.width + 0.12, 2.7, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.8 })
  );
  frame.position.set(f.x, 1.35, f.y + 0.025);
  if (f.style === "elevator") {
    // open frame, so you can see into the cab through the gap in the doors
    [[f.x - f.width / 2 - 0.03, 1.35, 0.06, 2.7], [f.x + f.width / 2 + 0.03, 1.35, 0.06, 2.7], [f.x, 2.63, f.width + 0.12, 0.15]].forEach(([x, y, w, h]) =>
      addBox(w, h, 0.05, x, y, f.y + 0.025, 0x1a1a1c)
    );
  } else {
    worldGroup.add(frame);
  }
  if (!fixtureTextures[f.id]) {
    fixtureTextures[f.id] = makeThreeTexture(createStyledDoorTexture(f.style, f.plate, f.baseColor));
  }
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(f.width, 2.55),
    new THREE.MeshStandardMaterial({ map: fixtureTextures[f.id], roughness: 0.6, metalness: f.style === "elevator" ? 0.3 : 0 })
  );
  if (f.style === "elevator") {
    addElevatorCab(f);
    [-1, 1].forEach((side) => {
      const tex = fixtureTextures[f.id].clone();
      tex.needsUpdate = true;
      tex.repeat.set(0.5, 1);
      tex.offset.set(side < 0 ? 0 : 0.5, 0);
      const half = new THREE.Mesh(
        new THREE.PlaneGeometry(f.width / 2, 2.55),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.3 })
      );
      half.userData = { baseX: f.x + (side * f.width) / 4, side };
      half.position.set(half.userData.baseX, 1.275, f.y + 0.052);
      worldGroup.add(half);
      elevPanels.push(half);
    });
    setElevatorOpen(state.flags.elevatorStuck ? 1 : 0);
  } else {
    panel.position.set(f.x, 1.275, f.y + 0.052);
    worldGroup.add(panel);
  }
  if (f.style === "elevator") {
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.07, 0.03),
      new THREE.MeshBasicMaterial({ color: 0x5a3810 })
    );
    lamp.position.set(f.x, 2.82, f.y + 0.05);
    worldGroup.add(lamp);
    const plate = addBox(0.11, 0.2, 0.03, f.x + 0.72, 1.1, f.y + 0.03, 0x25272a);
    const btn = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.02), new THREE.MeshBasicMaterial({ color: 0x5a3810 }));
    btn.position.set(f.x + 0.72, 1.1, f.y + 0.05);
    worldGroup.add(btn);
  }
}

let buildTarget = null; // when set, addBox/addKeyModel put meshes here instead of the world
function addBox(w, h, d, x, y, z, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 1 }));
  m.position.set(x, y, z);
  (buildTarget || worldGroup).add(m);
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
  addSolid(x, z, 2.0, 0.85);
  addBox(1.8, 0.4, 0.8, x, 0.2, z, 0x2b2220);
  addBox(1.8, 0.55, 0.2, x, 0.65, z + 0.35, 0x251d1b);
  addBox(0.2, 0.55, 0.8, x - 0.9, 0.45, z, 0x251d1b);
  addBox(0.2, 0.55, 0.8, x + 0.9, 0.45, z, 0x251d1b);
}

function addPlant(x, z) {
  addSolid(x, z, 0.4, 0.4);
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
  addSolid(x, z, 0.9, 0.6);
  addBox(0.9, 0.75, 0.6, x, 0.375, z, 0x2e2419);
}

function addChair(x, z) {
  addSolid(x, z, 0.45, 0.45);
  addBox(0.42, 0.45, 0.42, x, 0.225, z, 0x241c15);
  addBox(0.42, 0.45, 0.06, x, 0.68, z + 0.18, 0x241c15);
}

// A plain, unmade bed in John's room.
function addBed(x, z) {
  addSolid(x, z, 1.7, 0.9);
  const wood = 0x2a2320;
  [[-0.8, -0.4], [0.8, -0.4], [-0.8, 0.4], [0.8, 0.4]].forEach(([dx, dz]) => addBox(0.07, 0.34, 0.07, x + dx, 0.17, z + dz, wood));
  addBox(1.7, 0.08, 0.9, x, 0.38, z, wood); // raised, so there's room underneath
  addBox(1.6, 0.12, 0.8, x, 0.48, z, 0x59544a);
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
  if (BLOCKED_CELLS.some(([bc, br]) => bc === col && br === row)) return true;
  for (const s of solids) if (x > s.minX && x < s.maxX && y > s.minZ && y < s.maxZ) return true;
  return MAP[row][col] !== 0;
}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function tryMovePlayer(dt) {
  if (state.activeNpc || state.flags.tut === "open" || state.transition) return; // frozen mid-dialogue

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
    if (!state.flags.powerOn) {
      state.entity.mode = "done"; // ends the ground-floor chase (the other floors are separate)
      entityGroup.visible = false;
      setFear(0);
    }
  }
}

function updateDoorAnimation(dt) {
  doorList().forEach((door) => {
    const pivot = doorPivots[door.id];
    if (!pivot) return;
    const target = isDoorOpen(door) ? (door.openAngle !== undefined ? door.openAngle : DOOR_OPEN_ANGLE) : 0;
    const current = pivot.rotation.y;
    if (Math.abs(target - current) < 0.001) {
      pivot.rotation.y = target;
      return;
    }
    const step = DOOR_OPEN_SPEED * (door.creak || 1) * dt; // heavier doors swing slower, matching their creak
    pivot.rotation.y = target > current ? Math.min(target, current + step) : Math.max(target, current - step);
  });
}

// k = 0 closed, 1 = as far as the doors get before they jam (the right leaf jams crooked)
// The cab sits inside the wall block behind the doors, so you can see it through the gap — but the block stays solid.
function addElevatorCab(f) {
  const cx = f.x;
  const steel = 0x80858a;
  // back wall: steel on the cab side, plain wall facing the hallway
  const wallM = new THREE.MeshStandardMaterial({ map: interiorWallTexture, roughness: 0.95 });
  const steelM = new THREE.MeshStandardMaterial({ color: steel, roughness: 0.5, metalness: 0.3 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 0.08), [wallM, wallM, wallM, wallM, steelM, wallM]);
  back.position.set(Math.floor(cx) + 0.5, 1.5, 7.04);
  worldGroup.add(back);
  addBox(0.03, 2.6, 0.9, cx - 0.49, 1.3, 7.5, 0x6f7479); // sides
  addBox(0.03, 2.6, 0.9, cx + 0.49, 1.3, 7.5, 0x6f7479);
  addBox(0.95, 0.02, 0.9, cx, 0.01, 7.5, 0x3a3a3c); // floor
  addBox(0.95, 0.04, 0.9, cx, 2.62, 7.5, 0x9a9ea2); // cab ceiling
  addBox(1, 0.38, 1, Math.floor(cx) + 0.5, 2.81, 7.5, 0x3a3d3f); // wall above the cab
  addBox(0.8, 0.03, 0.03, cx, 1.0, 7.07, 0xb8963a); // handrail
  addBox(0.02, 0.35, 0.1, cx + 0.465, 1.1, 7.7, 0x25272a); // button panel
  addBox(0.02, 0.05, 0.05, cx + 0.455, 1.18, 7.7, 0x7a2a22);
  elevLightMat = new THREE.MeshBasicMaterial({ color: 0xe8f2e0 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.5), elevLightMat);
  panel.position.set(cx, 2.59, 7.5);
  worldGroup.add(panel);
  elevLight = new THREE.PointLight(0xe0eedd, 0, 5, 2);
  elevLight.position.set(cx, 2.3, 7.55);
  worldGroup.add(elevLight);
}

// The cab light only comes on once the power is on and the doors have been called, and it stutters.
function updateElevatorLight(dt) {
  if (!elevLight) return;
  const on = state.flags.elevatorStuck || elevAnim !== null;
  if (!on) {
    elevLight.intensity = 0;
    elevLightMat.color.setRGB(0.05, 0.05, 0.05);
    return;
  }
  elevLightTimer -= dt;
  if (elevLightTimer > 0) return;
  const r = Math.random();
  const level = r < 0.4 ? 1 : r < 0.7 ? 0.35 + Math.random() * 0.4 : r < 0.88 ? 0.08 : 0;
  elevLightTimer = 0.04 + Math.random() * 0.18;
  elevLight.intensity = 7 * 1.1 * level;
  const c = 0.1 + 0.9 * level;
  elevLightMat.color.setRGB(c * 0.91, c * 0.95, c * 0.88);
}

function setElevatorOpen(k) {
  elevPanels.forEach((m) => {
    const open = m.userData.side < 0 ? 0.22 : 0.17;
    m.position.x = m.userData.baseX + m.userData.side * open * k;
    m.rotation.z = m.userData.side > 0 ? 0.025 * k : 0;
  });
}

function playDing() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sine";
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 1.3);
}

function updateElevator(dt) {
  if (elevAnim === null) return;
  elevAnim += dt;
  const k = Math.min(1, elevAnim / 1.2);
  setElevatorOpen(k * k * (3 - 2 * k));
  if (elevAnim >= 1.3) {
    elevAnim = null;
    state.flags.elevatorStuck = true;
    setElevatorOpen(1);
    playKnock();
    setTimeout(playKnock, 160);
    addLog("The doors jam.");
  }
}

function updateStaffSign(dt) {
  if (!staffSignMat) return;
  staffSignTimer -= dt;
  if (staffSignTimer > 0) return;
  // mostly steady, with bursts of stutter and the odd full blackout
  const r = Math.random();
  const level = r < 0.55 ? 1 : r < 0.8 ? 0.45 + Math.random() * 0.4 : r < 0.92 ? 0.12 : 0;
  staffSignTimer = level === 1 ? 0.15 + Math.random() * 0.9 : 0.04 + Math.random() * 0.1;
  staffSignMat.color.setRGB(level, level, level);
  if (staffSignLight) staffSignLight.intensity = STAFF_SIGN_LEVEL * 1.1 * level;
}

function updateDeskLampFlicker(dt) {
  if (!deskLamp) return;
  deskLampNextFlicker -= dt;
  if (deskLampNextFlicker <= 0 && deskLampFlickerLeft <= 0) {
    deskLampFlickerLeft = 0.3 + Math.random() * 0.5; // a short stutter every so often
    deskLampNextFlicker = 6 + Math.random() * 10;
  }
  let level = 1;
  if (deskLampFlickerLeft > 0) {
    deskLampFlickerLeft -= dt;
    level = Math.random() < 0.55 ? 0.08 + Math.random() * 0.4 : 1;
  }
  deskLamp.intensity = DESK_LAMP_LEVEL * 1.1 * (0.85 + 0.15 * level); // the room barely changes; the bulb itself does the flashing
  if (deskBulbMat) deskBulbMat.color.setRGB(1 * (0.3 + 0.7 * level), 0.82 * (0.3 + 0.7 * level), 0.48 * (0.3 + 0.7 * level));
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
    }
  }

  let targetIntensity = hasFlashlightOn() && scareBlackout <= 0 ? FLASHLIGHT_MAX_INTENSITY : 0;

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
    if (state.inventory[item.id] || item.hidden) return;
    if (item.id === "axe" && !state.flags.powerOn) return;
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
  FIXTURES.forEach((f) => {
    const d = Math.hypot(f.x - px, f.y + 0.5 - py);
    if (d < 1.4 && d < doorDist) {
      doorDist = d;
      doorTarget = { type: "fixture", id: f.id, label: f.id === "elevator" && state.flags.elevatorStuck ? "" : f.label };
    }
  });
  HOTSPOTS.forEach((h) => {
    if (h.id === "boards" && state.flags.boardsChopped) return;
    const d = Math.hypot(h.x - px, h.y - py);
    if (d < 1.4 && d < doorDist) {
      doorDist = d;
      let label = h.label;
      if (h.id === "drawers") label = (state.flags.drawers || 0) >= 3 ? (state.inventory.staffKey ? "Empty Drawers" : "Take Key") : "Search Drawer";
      if (h.id === "breaker") label = state.flags.powerOn ? "Breaker Panel" : "Flip Breaker";
      if (h.id === "boards") label = ""; // no prompt: you have to try things
      if (h.loot && (state.flags.looted || {})[h.id]) label = ""; // already searched
      doorTarget = { type: "hotspot", id: h.id, label };
    }
  });
  return doorTarget;
}

// Walking on stairs: the camera follows the steps; reaching the far end fades out and moves you to the next level.
function updatePlayerHeight(dt) {
  const p = yawObject.position;
  if (state.transition) {
    state.transition.t += dt;
    const tr = state.transition;
    if (!tr.done && tr.t >= 0.3) {
      tr.done = true;
      travel(tr.to);
      p.y = EYE_HEIGHT + floorHeight(p.x, p.z);
    }
    if (tr.t >= 0.65) {
      state.transition = null;
      document.getElementById("transition-fade").classList.remove("active");
    }
    return;
  }
  const target = EYE_HEIGHT + floorHeight(p.x, p.z);
  p.y += (target - p.y) * Math.min(1, dt * 10);
  const s = stairAt(p.x, p.z);
  if (s && s.to && state.phase === "explore") {
    const t = (s.z0 - p.z) / (s.z0 - s.z1);
    if (t >= 0.94) startTransition(s.to);
  }
  // step through an open apartment door and you are inside the flat
  if (state.phase === "explore" && !state.transition) {
    const pt = PORTALS.find((q) => state.doorsOpen[q.door] && p.x >= q.x0 && p.x < q.x1 && p.z > 3.5 && p.z < q.z);
    if (pt) startTransition(pt.to);
  }
}
function startTransition(to) {
  state.transition = { t: 0, to, done: false };
  keys.clear();
  const f = document.getElementById("transition-fade");
  f.classList.remove("hidden");
  f.classList.add("active");
}

function travel(to) {
  playClick();
  yawObject.position.x = to.x;
  yawObject.position.z = to.y;
  yawObject.rotation.y = to.yaw;
  yawObject.position.y = EYE_HEIGHT;
  keys.clear();
  buildWorld(); // lights are built per level
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function updateTutorialBanner() {
  const b = document.getElementById("tutorial-banner");
  if (!b) return;
  b.classList.toggle("hidden", !(state.flags.tut === "open" && state.phase === "explore"));
}

function updateInteractPrompt() {
  updateTutorialBanner();
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
  if (!target.label) {
    prompt.classList.add("hidden");
    return;
  }
  prompt.textContent = `[E] ${target.label}`;
  prompt.classList.remove("hidden");
}

function handleInteract() {
  if (state.activeNpc || state.flags.tut === "open") return;
  const target = nearestInteractable();
  if (!target) return;

  if (target.type === "fixture") {
    const f = FIXTURES.find((x) => x.id === target.id);
    if (f.id === "elevator") {
      if (elevAnim !== null) return;
      if (state.flags.elevatorStuck) {
        playKnock();
        addLog("Jammed.");
      } else if (!state.flags.powerOn) {
        playClick();
        addLog("No power.");
      } else {
        playDing();
        elevAnim = 0;
      }
      return;
    }
    if (f.sound === "click") playClick();
    else playKnock();
    addLog(f.text);
  } else if (target.type === "door") {
    const door = doorList().find((d) => d.id === target.id);
    if (door.isFront) {
      state.frontDoorOpen = true;
      playDoorCreak(door);
    } else if (door.locked && !(door.keyId && state.inventory[door.keyId])) {
      playKnock();
      addLog(door.lockedText || "Locked.");
    } else {
      if (door.locked) playClick(); // key turning
      state.doorsOpen[door.id] = true;
      playDoorCreak(door);
      if (door.id === "hallDoor" && state.entity.mode === "idle") {
        state.entity.mode = "waiting";
        state.entity.timer = ENTITY_SPAWN_DELAY;
      }
    }
  } else if (target.type === "hotspot") {
    const h = HOTSPOTS.find((x) => x.id === target.id);
    if (h.id === "boards") {
      if (state.held === "axe") {
        state.flags.boardsChopped = true;
        playKnock();
        setTimeout(playKnock, 220);
        setTimeout(playKnock, 460);
        buildWorld();
      } else {
        playKnock();
        addLog("Nailed shut.");
      }
    } else if (h.id === "drawers") {
      const n = state.flags.drawers || 0;
      if (n >= 3) {
        if (state.inventory.staffKey) addLog("Nothing else.");
        else {
          state.inventory.staffKey = true;
          playClick();
          showPickup("Staff Key");
          buildWorld();
        }
      } else {
        state.flags.drawers = n + 1;
        playClick();
        addLog(["Rubber bands. A dead pager.", "Old menus and receipts.", "A brass key on a tag: STAFF."][n]);
        buildWorld();
      }
    } else if (h.id === "guestLog") {
      openPaper(GUEST_PAPER);
    } else if (h.id === "breaker") {
      if (state.flags.powerOn) addLog("The power is on.");
      else {
        state.flags.powerOn = true;
        if (state.entity.mode === "active" && levelOf(yawObject.position.x) === 0) {
          state.entity.mode = "vanishing"; // the light burns it off the ground floor
          state.entity.timer = 0.9;
          playVanish();
        } else {
          state.entity.mode = "gone"; // gone from here; it will turn up upstairs or below
          state.entity.timer = 14;
        }
        playClick();
        setTimeout(playKnock, 200);
        addLog("Power restored.");
        buildWorld();
      }
    } else if (h.exit) {
      const pt = PORTALS.find((p) => p.door === h.exit);
      playDoorCreak(DOORS.find((dr) => dr.id === h.exit));
      startTransition(pt.back);
    } else if (h.loot) {
      if (!state.flags.looted) state.flags.looted = {};
      if (state.flags.looted[h.id]) return;
      state.flags.looted[h.id] = true;
      playClick();
      if (h.loot !== "none") collectItem(h.loot);
    } else if (h.go) travel(h.go);
    else {
      playKnock();
      addLog(h.text);
    }
  } else if (target.type === "item") {
    collectItem(target.id);
    } else if (target.type === "npc") {
    openDialogue(target.id);
  }
}

function collectItem(id) {
  const item = ITEMS.find((it) => it.id === id);
  state.inventory[id] = true;
  if (!item.note) showPickup(item.name);
  if (item.note) openPaper(item);
  if (item.name === "Batteries") state.batteries += 1;
  if (id === "flashlight" || (id === "axe" && !state.held)) state.held = id;
  if (id === "flashlight") {
    state.inventory.hands = true; // empty hands, so there's always something to switch to
    state.flags.tut = "open"; // forced tutorial: open the inventory, then switch items
  }
  buildWorld(); // remove the collected item's marker from the scene
}

// ---- held items + inventory ---------------------------------------------------

const HELD_ORDER = ["flashlight", "axe", "hands"];
const HELD_NAMES = { flashlight: "Flashlight", axe: "Axe", hands: "Empty Hands" };

function equip(id) {
  if (!state.inventory[id] || state.held === id) return;
  if (state.held === "flashlight") state.flashlightOn = false;
  state.held = id;
  playClick();
  tutorialCheck();
}

// Forced tutorial after the flashlight: open the inventory, switch away, switch back.
function tutorialCheck() {
  if (state.flags.tut === "switch1" && state.held !== "flashlight") state.flags.tut = "switch2";
  else if (state.flags.tut === "switch2" && state.held === "flashlight") state.flags.tut = null;
}

function cycleHeld() {
  if (state.phase === "inventory") setTimeout(renderInventory, 0);
  const owned = HELD_ORDER.filter((id) => state.inventory[id]);
  if (owned.length < 2) return;
  const i = owned.indexOf(state.held);
  equip(owned[(i + 1) % owned.length]);
}

function renderInventory() {
  const hint = document.getElementById("inventory-hint");
  if (hint) {
    const t = state.flags.tut;
    hint.innerHTML =
      t === "switch1"
        ? "F turns the flashlight on and off.<br />Caps Lock changes the item in your hand.<br /><b>Press Caps Lock now.</b>"
        : t === "switch2"
          ? "Your hands are empty.<br /><b>Press Caps Lock again</b> to take the flashlight back out."
          : "Caps Lock: switch item in hand<br />Shift or Esc: close";
  }
  const list = document.getElementById("inventory-list");
  list.innerHTML = "";
  const add = (name, btnLabel, onClick, disabled) => {
    const row = document.createElement("div");
    row.className = "inv-row";
    const span = document.createElement("span");
    span.textContent = name;
    row.appendChild(span);
    if (btnLabel) {
      const b = document.createElement("button");
      b.className = "choice-button";
      b.textContent = btnLabel;
      b.disabled = !!disabled;
      b.addEventListener("click", onClick);
      row.appendChild(b);
    }
    list.appendChild(row);
  };
  HELD_ORDER.filter((id) => state.inventory[id]).forEach((id) => {
    const name = HELD_NAMES[id];
    add(name, state.held === id ? "In hand" : "Equip", () => { equip(id); renderInventory(); }, state.held === id);
  });
  if (state.batteries > 0) {
    add(`Batteries x${state.batteries}`, "Use", () => {
      if (state.batteries <= 0) return;
      state.batteries -= 1;
      state.batteryLevel = 100;
      playClick();
      renderInventory();
    }, state.batteryLevel >= 100);
  }
  ITEMS.filter((it) => it.note && state.inventory[it.id]).forEach((it) => add(it.name, "Read", () => {
    document.getElementById("inventory-overlay").classList.add("hidden");
    openPaper(it);
  }));
  if (state.inventory.staffKey) add("Staff Key", null);
  ITEMS.filter((it) => (it.key || it.trinket) && state.inventory[it.id]).forEach((it) => add(it.name, null));
  if (!list.children.length) add("Empty", null);
}

let pickupTimer = null;
function showPickup(name) {
  const el = document.getElementById("pickup-popup");
  el.textContent = name;
  el.classList.add("show");
  clearTimeout(pickupTimer);
  pickupTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function openReader(title, lines) {
  state.phase = "reading";
  keys.clear();
  document.getElementById("reader-title").textContent = title;
  document.getElementById("reader-body").textContent = lines.join("\n");
  document.getElementById("reader-overlay").classList.remove("hidden");
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
}

function openPaper(it) {
  state.phase = "reading";
  keys.clear();
  drawPaper(document.getElementById("paper-canvas"), it.paper, it.sloppy, it.seed);
  document.getElementById("paper-overlay").classList.remove("hidden");
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
}

function closeReader() {
  document.getElementById("paper-overlay").classList.add("hidden");
  document.getElementById("reader-overlay").classList.add("hidden");
  state.phase = "explore";
  renderer.domElement.requestPointerLock();
}

document.getElementById("reader-close").addEventListener("click", closeReader);
document.getElementById("paper-close").addEventListener("click", closeReader);
if (document.fonts && document.fonts.load) document.fonts.load('40px "Reenie Beanie"');

function openInventory() {
  if (state.flags.tut === "open") state.flags.tut = "switch1";
  state.phase = "inventory";
  keys.clear();
  renderInventory();
  document.getElementById("inventory-overlay").classList.remove("hidden");
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
}

function closeInventory() {
  document.getElementById("inventory-overlay").classList.add("hidden");
  state.phase = "explore";
  renderer.domElement.requestPointerLock();
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
    } else if (state.phase === "inventory") {
      if (!state.flags.tut) closeInventory();
    } else if (state.phase === "reading") {
      closeReader();
    }
    return;
  }

  if (key === "shift" && !e.repeat) {
    if (state.phase === "explore" && !state.activeNpc) openInventory();
    else if (state.phase === "inventory" && !state.flags.tut) closeInventory();
    return;
  }
  if (state.phase === "reading") {
    if (key === "e") closeReader();
    return;
  }
  if (state.phase === "inventory") {
    if (key === "capslock") {
      e.preventDefault();
      cycleHeld();
    }
    return;
  }
  if (state.phase !== "explore") return;
  if (key === "capslock") {
    e.preventDefault();
    cycleHeld();
    return;
  }
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
// Something walks the building (it can't pass walls or closed doors). In the dark it
// closes in, faster the longer you stay there. Light on but not on it: it hangs back.
// Light on it: it recoils. Switching the power on drives it out for good.

const ENTITY_SPAWN_DELAY = 12; // seconds after the hall door opens
const ENTITY_SPEED_DARK = 0.9; // how fast it creeps when you've only just lost the light
const ENTITY_SPEED_RUSH = 5.6; // where it ends up if you stay in the dark: far faster than you
const ENTITY_DARK_RAMP = 9; // seconds in the dark to reach full rush
const ENTITY_SPEED_WATCHING = 0.25;
const ENTITY_RETREAT_SPEED = 1.8;
const ENTITY_CATCH_DIST = 0.85;
const ENTITY_BEAM_COS = 0.96; // matches the small beam (about 16 degrees)
const ENTITY_BEAM_RANGE = 9;
const ENTITY_SPAWNS_BY_LEVEL = [
  [[3.0, 9.5], [13.5, 9.5], [8.5, 9.0], [2.0, 12.0], [17.5, 10.5], [7.5, 5.5], [12.5, 6.0], [17.5, 6.0]], // ground floor
  [[27.5, 6.5], [33.5, 6.5], [39.5, 6.5], [44.5, 6.5], [30.5, 2.5], [40.5, 2.5], [30.5, 10.5], [40.5, 10.5]], // second floor
  [[52.5, 3.5], [57.5, 3.5], [51.5, 9.5], [53.0, 10.8], [51.5, 3.0]], // basement
];
const ENTITY_SPAWNS = ENTITY_SPAWNS_BY_LEVEL[0];
// 0 = ground floor, 1 = second floor, 2 = basement (they sit side by side on the map)
function levelOf(x) {
  return x < 21 || x >= APT_X0 ? 0 : x < 46 ? 1 : 2; // the apartments (x >= 70) belong to the ground floor
}

// ---- the model: a tall, starved figure in a ragged coat, hunched, arms to its knees ----
const entityGroup = new THREE.Group();
const entityParts = {};
(function buildEntityMesh() {
  const skin = new THREE.MeshStandardMaterial({ color: 0xb4b09f, roughness: 0.9 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 1, side: THREE.DoubleSide });
  const boneMat = new THREE.MeshStandardMaterial({ color: 0xcfc9b4, roughness: 0.8 });
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const glow = new THREE.MeshBasicMaterial({ color: 0xff2a14 });
  const box = (w, h, d, mat, x, y, z, parent) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  const legL = new THREE.Group();
  legL.position.set(-0.1, 0.8, 0);
  const legR = new THREE.Group();
  legR.position.set(0.1, 0.8, 0);
  [legL, legR].forEach((l) => {
    box(0.07, 0.8, 0.07, cloth, 0, -0.4, 0, l);
    box(0.09, 0.05, 0.2, cloth, 0, -0.8, 0.06, l);
    entityGroup.add(l);
  });

  const spine = new THREE.Group();
  spine.position.set(0, 0.8, 0);
  spine.rotation.x = 0.32; // hunched forward
  entityGroup.add(spine);
  box(0.34, 0.75, 0.2, cloth, 0, 0.38, 0, spine); // torso
  for (let i = 0; i < 6; i++) {
    // ragged coat tails
    const t = box(0.07, 0.55 + (i % 3) * 0.12, 0.02, cloth, -0.14 + i * 0.056, -0.2, 0.1 - (i % 2) * 0.2, spine);
    t.rotation.z = (i - 2.5) * 0.04;
  }
  for (let i = 0; i < 5; i++) box(0.3, 0.018, 0.02, boneMat, 0, 0.2 + i * 0.1, 0.105, spine); // ribs showing

  const neck = box(0.06, 0.34, 0.06, skin, 0, 0.9, 0.04, spine);
  neck.rotation.x = 0.25;

  const head = new THREE.Group();
  head.position.set(0, 1.12, 0.14);
  spine.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), skin);
  skull.scale.set(0.78, 1.55, 0.9);
  head.add(skull);
  [-0.05, 0.05].forEach((x) => {
    const socket = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), black);
    socket.scale.set(1, 1.3, 0.6);
    socket.position.set(x, 0.07, 0.11);
    head.add(socket);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 6), glow);
    eye.position.set(x, 0.07, 0.135);
    head.add(eye);
  });
  box(0.03, 0.07, 0.03, black, 0, -0.02, 0.125, head); // nose hole
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.12, 0.04);
  head.add(jaw);
  box(0.1, 0.13, 0.08, skin, 0, -0.07, 0.03, jaw);
  box(0.075, 0.1, 0.02, black, 0, -0.04, 0.075, jaw); // open mouth
  for (let i = 0; i < 6; i++) box(0.01, 0.045, 0.01, boneMat, -0.03 + i * 0.012, -0.01, 0.08, jaw); // teeth
  const eyeLight = new THREE.PointLight(0xff2200, 0.5, 3.2, 2);
  eyeLight.position.set(0, 0.07, 0.2);
  head.add(eyeLight);

  const makeArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.22, 0.7, 0);
    spine.add(shoulder);
    box(0.05, 0.6, 0.05, skin, 0, -0.3, 0, shoulder);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.6, 0);
    shoulder.add(elbow);
    box(0.04, 0.62, 0.04, skin, 0, -0.31, 0, elbow);
    for (let f = 0; f < 4; f++) {
      const finger = box(0.012, 0.26, 0.012, boneMat, (f - 1.5) * 0.02, -0.74, 0.01, elbow);
      finger.rotation.x = 0.15 + f * 0.05;
    }
    return { shoulder, elbow };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  Object.assign(entityParts, { spine, head, jaw, legL, legR, armL, armR });
  entityGroup.visible = false;
  scene.add(entityGroup);
})();

let entityAnimT = 0;
let entityTwitch = 0;
let entityTwitchTarget = 0;
let entityTension = 0; // 0-1, drives the building music

function animateEntity(dt, speed, near) {
  const p = entityParts;
  entityAnimT += dt;
  const gait = entityAnimT * (2.2 + speed * 2.4);
  const stride = Math.min(0.7, 0.12 + speed * 0.22);
  p.legL.rotation.x = Math.sin(gait) * stride;
  p.legR.rotation.x = -Math.sin(gait) * stride;
  p.spine.rotation.z = Math.sin(entityAnimT * 1.3) * 0.05 + Math.sin(gait) * 0.03;
  p.spine.rotation.x = 0.32 + near * 0.18 + Math.sin(gait * 2) * 0.02;
  p.armL.shoulder.rotation.x = -0.15 + Math.sin(gait + Math.PI) * stride * 0.6 - near * 0.55;
  p.armR.shoulder.rotation.x = -0.15 + Math.sin(gait) * stride * 0.6 - near * 0.55;
  p.armL.shoulder.rotation.z = -0.08;
  p.armR.shoulder.rotation.z = 0.08;
  p.armL.elbow.rotation.x = -0.25 - near * 0.6;
  p.armR.elbow.rotation.x = -0.25 - near * 0.6;
  // the head twitches and snaps to one side now and then
  if (Math.random() < dt * 1.2) entityTwitchTarget = (Math.random() - 0.5) * 1.0;
  entityTwitch += (entityTwitchTarget - entityTwitch) * Math.min(1, dt * 14);
  p.head.rotation.z = entityTwitch;
  p.head.rotation.y = entityTwitch * 0.5;
  p.head.rotation.x = 0.15 + near * 0.2;
  p.jaw.rotation.x = 0.2 + near * 0.55 + Math.max(0, Math.sin(entityAnimT * 34)) * 0.08 * near;
}

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

// ---- it walks, it doesn't phase: breadth-first search over the ground-floor grid ----
function cellFree(c, r) {
  if (r < 1 || r > 12 || c < 1 || c >= MAP[0].length - 1) return false;
  if (isWall(c + 0.5, r + 0.5)) return false;
  if (entityBlock.some((s) => s.maxX > c && s.minX < c + 1 && s.maxZ > r && s.minZ < r + 1)) return false;
  return !solids.some((s) => s.maxX > c && s.minX < c + 1 && s.maxZ > r && s.minZ < r + 1); // no furniture in the cell
}

// Returns the list of cells from (sx,sz) to (gx,gz), or null if it can't get there (closed doors, etc.).
function entityPath(sx, sz, gx, gz) {
  const sc = Math.floor(sx);
  const sr = Math.floor(sz);
  const gc = Math.floor(gx);
  const gr = Math.floor(gz);
  const key = (c, r) => r * 256 + c;
  const prev = new Map([[key(sc, sr), null]]);
  const queue = [[sc, sr]];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (queue.length) {
    const [c, r] = queue.shift();
    if (c === gc && r === gr) {
      const path = [];
      let k = key(c, r);
      let cur = [c, r];
      while (cur) {
        path.push(cur);
        cur = prev.get(key(cur[0], cur[1]));
      }
      return path.reverse();
    }
    for (const [dc, dr] of dirs) {
      const nc = c + dc;
      const nr = r + dr;
      const k2 = key(nc, nr);
      if (prev.has(k2)) continue;
      const isGoal = nc === gc && nr === gr;
      if (!isGoal && !cellFree(nc, nr)) continue;
      if (dc && dr && !(cellFree(c + dc, r) && cellFree(c, r + dr))) continue; // no cutting corners
      prev.set(k2, [c, r]);
      queue.push([nc, nr]);
    }
  }
  return null;
}

function spawnEntity() {
  const p = yawObject.position;
  let best = null;
  const lvl = levelOf(p.x);
  const options = ENTITY_SPAWNS_BY_LEVEL[lvl].filter(([x, z]) => cellFree(Math.floor(x), Math.floor(z)));
  options.sort(() => Math.random() - 0.5);
  for (const [x, z] of options) {
    const path = entityPath(x, z, p.x, p.z);
    if (!path) continue;
    if (path.length >= 8) {
      best = [x, z];
      break;
    }
    if (!best) best = [x, z];
  }
  if (!best) return false; // nowhere it can reach you from yet
  state.entity.x = best[0];
  state.entity.z = best[1];
  state.entity.mode = "active";
  state.entity.level = lvl;
  state.entity.dark = 0;
  state.entity.repath = 0;
  state.entity.path = null;
  if (!state.flags.entitySeen) state.flags.entitySeen = true;
  return true;
}

function caughtByEntity() {
  state.phase = "caught";
  state.entity.mode = "done";
  keys.clear();
  playSting();
  setFear(1);
  entityTension = 0;
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  document.getElementById("caught-overlay").classList.remove("hidden");
}

// Move with wall collision (per axis, like the player), so it can never end up inside a wall.
function entityStep(e, mx, mz) {
  const r = 0.22;
  if (!isWall(e.x + mx + Math.sign(mx || 1) * r, e.z)) e.x += mx;
  if (!isWall(e.x, e.z + mz + Math.sign(mz || 1) * r)) e.z += mz;
}

function updateEntity(dt) {
  const e = state.entity;
  entityTension = 0;
  if (state.phase !== "explore" || state.flags.tut === "open") return;
  if (e.mode === "vanishing") {
    // the lights came on: it flickers, shrinks and is gone
    e.timer -= dt;
    entityGroup.visible = Math.random() > 0.35 && e.timer > 0;
    entityGroup.scale.y = Math.max(0.05, e.timer / 0.9);
    setFear(Math.max(0, e.timer / 0.9) * 0.5);
    if (e.timer <= 0) {
      e.mode = "gone";
      e.timer = 14; // it will find you again upstairs or in the basement
      entityGroup.visible = false;
      entityGroup.scale.set(1, 1, 1);
      setFear(0);
    }
    return;
  }
  // Before the power is on it haunts the ground floor. Once the lights are on it can only be
  // upstairs or in the basement.
  if (yawObject.position.x >= APT_X0) {
    entityGroup.visible = false; // the flats are safe; it waits outside
    setFear(0);
    return;
  }
  const lvl = levelOf(yawObject.position.x);
  const haunted = state.flags.powerOn ? lvl >= 1 : lvl === 0;
  if (!haunted) {
    entityGroup.visible = false;
    setFear(0);
    if (e.mode === "active") {
      e.mode = "gone"; // you left its floor; it loses you
      e.timer = 8 + Math.random() * 6;
    }
    return;
  }
  if (e.mode === "active" && e.level !== lvl) {
    entityGroup.visible = false;
    setFear(0);
    e.mode = "gone";
    e.timer = 6 + Math.random() * 6;
    return;
  }
  if (e.mode === "idle" || e.mode === "done") {
    entityGroup.visible = false;
    return;
  }
  if (e.mode === "waiting" || e.mode === "gone") {
    entityGroup.visible = false;
    setFear(0);
    e.timer -= dt;
    if (e.timer <= 0 && !spawnEntity()) e.timer = 2; // try again shortly
    return;
  }

  // active
  if (isOutside()) {
    entityGroup.visible = false;
    setFear(0);
    return;
  }
  const p = yawObject.position;
  const inBeam = entityInBeam(e);
  const lit = hasFlashlightOn() || groundLit();

  // the longer you stay in the dark, the faster it comes
  if (inBeam) e.dark = Math.max(0, (e.dark || 0) - dt * 3);
  else if (!lit) e.dark = (e.dark || 0) + dt;
  else e.dark = Math.max(0, (e.dark || 0) - dt);
  const k = Math.min(1, e.dark / ENTITY_DARK_RAMP);

  let speed;
  let dir = 1;
  if (inBeam) {
    speed = ENTITY_RETREAT_SPEED;
    dir = -1;
    state.flags.entityRecoiled = true;
  } else if (lit) {
    speed = ENTITY_SPEED_WATCHING + k * 0.5;
  } else {
    speed = ENTITY_SPEED_DARK + k * k * (ENTITY_SPEED_RUSH - ENTITY_SPEED_DARK);
  }

  const step = speed * dt;
  let faceX = p.x - e.x;
  let faceZ = p.z - e.z;
  if (dir < 0) {
    // recoil straight back, still blocked by walls
    const d0 = Math.hypot(faceX, faceZ) || 1;
    entityStep(e, (-faceX / d0) * step, (-faceZ / d0) * step);
  } else {
    // follow a path around walls, doors and furniture
    e.repath = (e.repath || 0) - dt;
    if (e.repath <= 0 || !e.path) {
      e.path = entityPath(e.x, e.z, p.x, p.z);
      e.repath = 0.2;
    }
    let tx = p.x;
    let tz = p.z;
    if (e.path && e.path.length > 1) {
      // aim for the centre of the next cell; when close to the last one, go straight for the player
      const next = e.path[1];
      tx = next[0] + 0.5;
      tz = next[1] + 0.5;
      if (e.path.length === 2 && Math.hypot(p.x - e.x, p.z - e.z) < 1.2) {
        tx = p.x;
        tz = p.z;
      }
    } else if (!e.path) {
      tx = e.x; // no way through right now (a closed door): it waits
      tz = e.z;
    }
    const mx = tx - e.x;
    const mz = tz - e.z;
    const md = Math.hypot(mx, mz);
    if (md > 0.02) {
      const s = Math.min(step, md);
      entityStep(e, (mx / md) * s, (mz / md) * s);
      faceX = mx;
      faceZ = mz;
    }
  }

  const nd = Math.hypot(p.x - e.x, p.z - e.z);
  if (inBeam && nd > ENTITY_BEAM_RANGE) {
    e.mode = "gone";
    e.timer = 8 + Math.random() * 7;
    entityGroup.visible = false;
    setFear(0);
    return;
  }
  const near = Math.max(0, Math.min(1, 1 - (nd - ENTITY_CATCH_DIST) / 6));
  entityGroup.position.set(e.x, 0, e.z);
  entityGroup.rotation.y = Math.atan2(p.x - e.x, p.z - e.z);
  entityGroup.scale.set(1, 1, 1);
  entityGroup.visible = true;
  animateEntity(dt, speed, near);

  if (nd < ENTITY_CATCH_DIST && !inBeam && hasLineOfSight(p.x, p.z, e.x, e.z)) {
    caughtByEntity();
    return;
  }

  const fear = near * (inBeam ? 0.6 : 1);
  setFear(fear);
  entityTension = Math.min(1, near * 1.05 + k * 0.25);
  e.beat -= dt;
  if (e.beat <= 0 && fear > 0.05) {
    playHeartbeat(fear);
    e.beat = 1.3 - fear * 0.85 - k * 0.2;
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

// ---- pop-out scares -----------------------------------------------------------------
function clearScares() {
  scareActive.forEach((a) => scene.remove(a.mesh));
  scareActive = [];
  scareBlackout = 0;
}
function playBang() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const n = audioCtx.createBufferSource();
  const lp = audioCtx.createBiquadFilter();
  const ng = audioCtx.createGain();
  n.buffer = noiseBuf;
  n.loop = true;
  lp.type = "lowpass";
  lp.frequency.value = 900;
  ng.gain.setValueAtTime(0.5, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  n.connect(lp).connect(ng).connect(audioCtx.destination);
  n.start(t);
  n.stop(t + 0.5);
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.setValueAtTime(90, t);
  o.frequency.exponentialRampToValueAtTime(30, t + 0.35);
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 0.45);
}
function playSkitter() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  for (let i = 0; i < 9; i++) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = 1500 + Math.random() * 1800;
    const at = t + i * 0.07 + Math.random() * 0.03;
    g.gain.setValueAtTime(0.05, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
    o.connect(g).connect(audioCtx.destination);
    o.start(at);
    o.stop(at + 0.05);
  }
}

// a pale, tall figure in a dark shroud; always turns to face you
function makeApparition() {
  const g = new THREE.Group();
  const shroud = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 1, side: THREE.DoubleSide });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc8c4b4, roughness: 0.8, emissive: 0x1c1c1a });
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.7, 10, 1, true), shroud);
  body.position.y = 0.85;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), skin);
  head.scale.set(0.8, 1.5, 0.9);
  head.position.set(0, 1.85, 0.05);
  g.add(head);
  [-0.05, 0.05].forEach((x) => {
    const sock = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), black);
    sock.position.set(x, 1.9, 0.15);
    g.add(sock);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.01, 6, 6), eyeMat);
    eye.position.set(x, 1.9, 0.18);
    g.add(eye);
  });
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.02), black);
  mouth.position.set(0, 1.74, 0.15);
  g.add(mouth);
  [-1, 1].forEach((s) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.035, 1.25, 0.035), skin);
    arm.position.set(s * 0.26, 1.15, 0.12);
    arm.rotation.z = s * 0.08;
    g.add(arm);
  });
  return g;
}
function makeCrawler() {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xb8b4a4, roughness: 0.8, emissive: 0x161614 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.6), skin);
  body.position.y = 0.3;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), skin);
  head.position.set(0, 0.34, 0.42);
  g.add(head);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff2a14 }));
  eye.position.set(0, 0.37, 0.5);
  g.add(eye);
  g.userData.limbs = [];
  [[-1, 0.2], [1, 0.2], [-1, -0.2], [1, -0.2]].forEach(([s, z]) => {
    const limb = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.4, 0.03), skin);
    limb.position.set(s * 0.22, 0.2, z);
    limb.rotation.z = s * 0.5;
    g.add(limb);
    g.userData.limbs.push(limb);
  });
  return g;
}
function makeSack() {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0x6a665a, roughness: 1 });
  const bundle = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.0, 0.3), cloth);
  g.add(bundle);
  const rope = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.2, 0.02), new THREE.MeshStandardMaterial({ color: 0x2a2018 }));
  rope.position.y = 1.0;
  g.add(rope);
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.05), new THREE.MeshStandardMaterial({ color: 0xc4bfae }));
  hand.position.set(0.24, -0.35, 0);
  g.add(hand);
  return g;
}

function startScare(sc) {
  const a = { sc, t: 0, state: "wait", vy: 0 };
  const floorY = floorHeight(sc.at.x, sc.at.z);
  if (sc.kind === "lurker" || sc.kind === "slam") {
    a.mesh = makeApparition();
    a.mesh.position.set(sc.at.x, floorY, sc.at.z);
    a.mesh.visible = false;
    if (sc.kind === "slam") {
      playBang();
      scareBlackout = sc.delay || 0.8;
    }
  } else if (sc.kind === "crawler") {
    a.mesh = makeCrawler();
    a.mesh.position.set(sc.at.x, floorY, sc.at.z);
    playSkitter();
  } else {
    a.mesh = makeSack();
    a.mesh.position.set(sc.at.x, 2.35, sc.at.z);
    a.state = "hang";
  }
  scene.add(a.mesh);
  scareActive.push(a);
}

function updateScares(dt) {
  if (state.phase !== "explore") return;
  const p = yawObject.position;
  const lvl = levelOf(p.x);
  scareBlackout = Math.max(0, scareBlackout - dt);
  if (state.flags.powerOn && !state.transition) {
    if (!state.flags.scares) state.flags.scares = {};
    SCARES.forEach((sc) => {
      if (sc.level !== lvl || state.flags.scares[sc.id]) return;
      if (Math.hypot(p.x - sc.trigger.x, p.z - sc.trigger.z) < sc.trigger.r) {
        state.flags.scares[sc.id] = true;
        startScare(sc);
      }
    });
  }
  for (let i = scareActive.length - 1; i >= 0; i--) {
    const a = scareActive[i];
    const sc = a.sc;
    a.t += dt;
    const m = a.mesh;
    let dead = false;
    if (sc.kind === "lurker" || sc.kind === "slam") {
      const d = Math.hypot(p.x - sc.at.x, p.z - sc.at.z);
      if (a.state === "wait" && a.t >= (sc.delay || 0)) {
        a.state = "shown";
        a.shownAt = a.t;
        m.visible = true;
      }
      if (a.state === "shown") {
        m.rotation.y = Math.atan2(p.x - sc.at.x, p.z - sc.at.z);
        if (d < (sc.near || 2.8) || a.t - a.shownAt > (sc.life || 5)) {
          a.state = "going";
          a.goneAt = a.t;
          if (d < (sc.near || 2.8) + 0.5) playSting();
        }
      }
      if (a.state === "going") {
        // it flickers out
        const k = (a.t - a.goneAt) / 0.3;
        m.visible = Math.random() > k;
        if (k >= 1) dead = true;
      }
      if (lvl !== sc.level) dead = true;
    } else if (sc.kind === "crawler") {
      const k = Math.min(1, a.t / sc.dur);
      m.position.x = sc.at.x + (sc.to.x - sc.at.x) * k;
      m.position.z = sc.at.z + (sc.to.z - sc.at.z) * k;
      m.rotation.y = Math.atan2(sc.to.x - sc.at.x, sc.to.z - sc.at.z);
      m.userData.limbs.forEach((l, j) => (l.rotation.x = Math.sin(a.t * 30 + j * 1.6) * 0.7));
      if (k >= 1) dead = true;
    } else {
      // drop
      if (a.state === "hang") {
        m.rotation.y += Math.sin(a.t * 2) * dt * 0.5;
        if (Math.hypot(p.x - sc.at.x, p.z - sc.at.z) < 2.0 || a.t > 9) a.state = "fall";
      } else if (a.state === "fall") {
        a.vy -= 16 * dt;
        m.position.y += a.vy * dt;
        if (m.position.y <= 0.55) {
          m.position.y = 0.55;
          m.rotation.z = 1.35; // it lands on its side
          a.state = "down";
          a.downAt = a.t;
          playBang();
        }
      } else if (a.t - a.downAt > 7) dead = true;
    }
    if (dead) {
      scene.remove(m);
      scareActive.splice(i, 1);
    }
  }
  // flickering emergency lights and swaying chains
  const T = performance.now() / 1000;
  flickerLights.forEach((f) => {
    const n = Math.sin(T * 23 + f.phase) * Math.sin(T * 7.3 + f.phase * 2);
    f.light.intensity = f.base * (n > 0.55 ? 0.1 : 0.75 + 0.25 * Math.sin(T * 3 + f.phase));
  });
  swayers.forEach((s) => {
    s.grp.rotation.z = Math.sin(T * 0.9 + s.phase) * 0.08;
    s.grp.rotation.x = Math.sin(T * 0.7 + s.phase * 1.7) * 0.06;
  });
}

// ---- main loop -----------------------------------------------------------------

const clock = new THREE.Clock();

function gameLoop() {
  const dt = Math.min(0.1, clock.getDelta());
  tryMovePlayer(dt);
  checkJohnRoom();
  updateEntity(dt);
  updateScares(dt);
  applyTension(entityTension);
  updateDoorAnimation(dt);
  updateFluorescents(dt);
  syncAmbient();
  updateDeskLampFlicker(dt);
  updateStaffSign(dt);
  updateElevator(dt);
  updatePlayerHeight(dt);
  updateElevatorLight(dt);
  updateBrokenLamp(dt);
  updateFlashlight(dt);
  updateHeldFlashlight(dt);

  const outside = isOutside();
  scene.fog.far = currentLightRange(); // indoor range; the street range is baked into the fog shader
  const bgColor = outside ? 0x0a0918 : 0x0b0a0d;
  scene.background.set(bgColor);
  scene.fog.color.set(bgColor);
  const ambientTarget = 0.03; // nearly none: only real lights and the beam show anything
  ambientLight.intensity += (ambientTarget - ambientLight.intensity) * Math.min(1, dt * 4); // no sudden jump at the door

  updateInteractPrompt();
  renderer.render(scene, camera);
}

// ---- boot --------------------------------------------------------------------

showScreen("screen-title");