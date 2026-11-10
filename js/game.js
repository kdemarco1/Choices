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
  settings: { showPrompts: true, soundOn: true, brightness: 1, sens: 1, volume: 1, binds: {} },
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
var loopOn = false; // true once the real game loop is running
var ambience = false, ambSaved = null; // settings screen: the game draws an apartment beside the menu
const EYE_HEIGHT = 1.5;
const CROUCH_DROP = 0.95; // hold C: the eyes go this much lower
let crouchK = 0; // 0 standing .. 1 crouched
const WALL_HEIGHT = 3;
const DOOR_OPEN_ANGLE = -Math.PI * 0.5; // a clean right angle: the leaf never swings back into the wall beside it
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
const BATTERY_LIFE_SECONDS = 140;
const BATTERY_DRAIN_RATE = 100 / BATTERY_LIFE_SECONDS;

function hasFlashlightOn() {
  return !!(state.inventory.flashlight && state.held === "flashlight" && state.batteryLevel > 0 && state.flashlightOn);
}

// With the breaker on, the ground floor (lobby, hall, apartments, stairwell, staff room) is lit by ceiling fluorescents.
function inApt2(x, z) {
  return x >= 5 && x < 8 && z < 4.05;
}
function groundLit() {
  const p = yawObject.position;
  if (inApt2(p.x, p.z) && !state.flags.apt2Light) return false; // apartment 2 has its own wall switch
  return !!state.flags.powerOn && levelOf(p.x) === 0 && p.z < DOOR_ROW;
}

function currentLightRange() {
  if (hasFlashlightOn() || groundLit()) return LIT_RANGE;
  if (inApt2(yawObject.position.x, yawObject.position.z)) return 4.6; // moonlight through the window
  // the flickering STAFF sign lights the lobby just enough to see the desk and the way to it
  const nearSign = Math.hypot(yawObject.position.x - 3.5, yawObject.position.z - 8.4) < 10 && yawObject.position.z > 8 && yawObject.position.x < 21;
  return nearSign ? 5.2 : DARK_RANGE;
}

function isOutside() {
  return yawObject.position.z >= DOOR_ROW && yawObject.position.x < 21;
}

// ---- audio (procedural, Web Audio) --------------------------------------------

let audioCtx = null;
let masterGain = null;
let ambientGains = [];
let footstepTimer = 0;
let noiseBuf = null;
let lockedDoorBuffer = null; // the recorded locked-door rattle
let stingBuffers = [];
let stepsBuffer = null; // sprite: 4 surfaces (tile, wood, carpet, concrete) x 4 variants, 0.6 s each
let voiceBuffer = null; // sprite of Maria's breaths: gasp, gasp2, exhale, whimper, pant, hold (1.4 s each)
const voiceOverrides = {};
let bedBuffer = null, bedSrc = null, bedGain = null, bedLp = null;
let doorCreakBuffer = null; // the recorded creak, loaded after the first click

function initAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  try {
    // one master gain in front of everything, so the volume slider covers every sound
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.settings.volume;
    masterGain.connect(audioCtx.destination);
    Object.defineProperty(audioCtx, "destination", { value: masterGain, configurable: true });
  } catch (e) {}
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
    const load = (url, cb) =>
      fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject())).then((b) => audioCtx.decodeAudioData(b)).then(cb).catch(() => {});
    for (let i = 1; i <= 4; i++) load("audio/sting-" + i + ".mp3", (d) => { stingBuffers[i - 1] = d; });
    load("audio/steps.mp3", (d) => { stepsBuffer = d; });
    load("audio/maria.mp3", (d) => { voiceBuffer = d; });
    load("audio/ambient-bed.mp3", (d) => { bedBuffer = d; ambientOn = null; syncAmbient(); });
    // real recordings win if you drop them in audio/voice/ and set window.MARIA_VOICE_FILES = true in index.html (gasp, gasp2, exhale, whimper, pant, hold)
    if (window.MARIA_VOICE_FILES) ["gasp", "gasp2", "exhale", "whimper", "pant", "hold"].forEach((id) => load("audio/voice/" + id + ".mp3", (d) => { voiceOverrides[id] = d; }));
    fetch("audio/locked-door.mp3")
      .then((r) => r.arrayBuffer())
      .then((buf) => audioCtx.decodeAudioData(buf))
      .then((decoded) => {
        lockedDoorBuffer = decoded;
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
  const want = state.settings.soundOn && (state.phase === "explore" || state.phase === "breaker") ? level : 0;
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
  ambientGains.forEach((g) => (g.gain.value = want ? (bedBuffer ? 0.008 : 0.018) : 0));
  if (bedBuffer && audioCtx && !bedSrc) {
    bedSrc = audioCtx.createBufferSource();
    bedSrc.buffer = bedBuffer;
    bedSrc.loop = true;
    bedLp = audioCtx.createBiquadFilter();
    bedLp.type = "lowpass";
    bedLp.frequency.value = 3000;
    bedGain = audioCtx.createGain();
    bedGain.gain.value = 0;
    bedSrc.connect(bedLp).connect(bedGain).connect(audioCtx.destination);
    bedSrc.start();
  }
  if (bedGain) bedGain.gain.setTargetAtTime(want ? 0.5 : 0, audioCtx.currentTime, 0.8);
}
// the bed gets darker and duller the deeper you go
function updateBed() {
  if (!bedLp) return;
  const lv = levelOf(yawObject.position.x);
  bedLp.frequency.setTargetAtTime(lv === 2 ? 700 : lv === 1 ? 1800 : 3200, audioCtx.currentTime, 1.5);
}

function surfaceAt(x, z) {
  const lv = levelOf(x);
  if (lv === 2) return z >= 14 ? 1 : 3;
  if (lv === 0) {
    if (z >= 8) return 0;
    if (z < 5) return x >= 9 && x < 13 ? 2 : 1;
    return x >= 6 && z >= 5.5 && z < 6.5 ? 2 : 1;
  }
  if (z >= 5 && z < 8) return z >= 5.5 && z < 6.5 ? 2 : 1;
  const r = typeof F2_ROOMS !== "undefined" && F2_ROOMS.find((q) => x >= q.c0 && x < q.c0 + q.w);
  const k = (r && r.floor) || "";
  return /carpet|runner/.test(k) ? 2 : /tile/.test(k) ? 0 : 1;
}

// Maria: breaths, gasps, a whimper. Real recordings in audio/voice/ replace the synthesized ones.
let voiceCool = 0;
function playVoice(id, gain, cool) {
  if (!audioReady()) return;
  const now = audioCtx.currentTime;
  if (now < voiceCool) return;
  const ids = ["gasp", "gasp2", "exhale", "whimper", "pant", "hold"];
  const buf = voiceOverrides[id];
  const src = audioCtx.createBufferSource();
  const g = audioCtx.createGain();
  g.gain.value = gain || 0.8;
  if (buf) src.buffer = buf;
  else if (voiceBuffer) {
    const i = ids.indexOf(id);
    if (i < 0) return;
    src.buffer = voiceBuffer;
    src.connect(g).connect(audioCtx.destination);
    src.start(now, i * 1.4, 1.35);
    voiceCool = now + (cool || 2.5);
    return;
  } else return;
  src.connect(g).connect(audioCtx.destination);
  src.start(now);
  voiceCool = now + (cool || 2.5);
}

function audioReady() {
  if (!audioCtx || !state.settings.soundOn) return false;
  if (audioCtx.state === "suspended") audioCtx.resume();
  return true;
}

function playFootstep(quiet) {
  if (!audioReady()) return;
  if (stepsBuffer) {
    const p = yawObject.position;
    const surf = surfaceAt(p.x, p.z);
    const src = audioCtx.createBufferSource();
    src.buffer = stepsBuffer;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = audioCtx.createGain();
    g.gain.value = (quiet ? 0.28 : 0.6) * (0.85 + Math.random() * 0.3);
    src.connect(g).connect(audioCtx.destination);
    src.start(audioCtx.currentTime, (surf * 4 + Math.floor(Math.random() * 4)) * 0.6 + 0.01, 0.58);
    return;
  }
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

let doorShake = 0; // a tiny camera jolt while a locked handle rattles
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

let stingIdx = 0;
function playSting(which) {
  if (!audioReady()) return;
  const sb = stingBuffers.filter(Boolean);
  if (sb.length) {
    const i = which != null ? which % sb.length : stingIdx++ % sb.length;
    const src = audioCtx.createBufferSource();
    const g = audioCtx.createGain();
    src.buffer = sb[i];
    g.gain.value = 0.8;
    src.connect(g).connect(audioCtx.destination);
    src.start();
    return;
  }
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

function playWhoosh() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const n = audioCtx.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  const bp = audioCtx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(2600, t);
  bp.frequency.exponentialRampToValueAtTime(420, t + 0.28);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.32, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  n.connect(bp).connect(g).connect(audioCtx.destination);
  n.start(t);
  n.stop(t + 0.32);
}
function playWoodCrack() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const n = audioCtx.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  const hp = audioCtx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 700;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  n.connect(hp).connect(g).connect(audioCtx.destination);
  n.start(t);
  n.stop(t + 0.25);
  const o = audioCtx.createOscillator();
  const og = audioCtx.createGain();
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
  og.gain.setValueAtTime(0.45, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  o.connect(og).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 0.22);
}
// Someone rattling a locked door handle: a latch clunk, then a few tinny jingles, then nothing.
function playJingle() {
  if (!audioReady()) return;
  const t0 = audioCtx.currentTime;
  if (lockedDoorBuffer) {
    const src = audioCtx.createBufferSource();
    const gn = audioCtx.createGain();
    gn.gain.value = 0.9;
    src.buffer = lockedDoorBuffer;
    src.playbackRate.value = 0.96 + Math.random() * 0.08;
    src.connect(gn).connect(audioCtx.destination);
    src.start(t0);
    return;
  }
  const clink = (at, f, v) => {
    [1, 1.51, 2.3].forEach((m, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = i ? "sine" : "triangle";
      o.frequency.value = f * m;
      g.gain.setValueAtTime(v / (i + 1), at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07 + i * 0.02);
      o.connect(g).connect(audioCtx.destination);
      o.start(at);
      o.stop(at + 0.14);
    });
  };
  const clunk = (at) => {
    const n = audioCtx.createBufferSource();
    n.buffer = noiseBuf;
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 400;
    const g = audioCtx.createGain();
    g.gain.value = 0.25;
    n.connect(lp).connect(g).connect(audioCtx.destination);
    n.start(at);
  };
  clunk(t0);
  [0.02, 0.1, 0.17, 0.3, 0.37, 0.52].forEach((dt, i) => clink(t0 + dt, 1900 + Math.random() * 1300, 0.05));
  clunk(t0 + 0.3);
  doorShake = 0.4;
}
function playKnock() {
  playFootstep(false);
  setTimeout(() => playFootstep(false), 140);
}

function toggleFlashlight() {
  if (state.flags.hints && state.flags.hints.f) hideHint();
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
  setAmbience(id === "screen-settings");
  if (id === "screen-title") {
    const cb = document.getElementById("title-continue-button");
    if (cb) cb.classList.toggle("hidden", !readSave());
  }
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
  clearHusks();
  closeBreaker();
  state.swing = null;
  walkedDist = 0;
  clearFinale();
  milestoneDone.clear();
  moveVX = moveVZ = 0;
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

// ---- settings that stick, key rebinding, gamepad, checkpoints ------------------

const ACTIONS = [
  ["forward", "Move forward", "w"],
  ["back", "Move back", "s"],
  ["left", "Move left", "a"],
  ["right", "Move right", "d"],
  ["interact", "Interact", "e"],
  ["flash", "Flashlight", "f"],
  ["crouch", "Crouch", "c"],
  ["sprint", "Run", "shift"],
  ["inv", "Inventory", "tab"],
  ["switch", "Switch item", "capslock"],
];
let rebindAction = null;
let keyMap = {};
let defaultKeys = new Set(ACTIONS.map((a) => a[2]));

function boundKey(action) {
  const a = ACTIONS.find((x) => x[0] === action);
  return (state.settings.binds && state.settings.binds[action]) || a[2];
}
function rebuildKeyMap() {
  keyMap = {};
  ACTIONS.forEach(([id, , def]) => { keyMap[boundKey(id)] = def; });
}
// what the player pressed -> the key the game logic expects. Keys that were moved away from an action do nothing.
function canonKey(k) {
  if (k === " ") k = "space";
  if (keyMap[k] !== undefined) return keyMap[k];
  if (defaultKeys.has(k)) return "__unbound";
  return k;
}
function kn(action) {
  const k = boundKey(action);
  return k === "capslock" ? "Caps Lock" : k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1);
}
function captureRebind(e) {
  e.preventDefault();
  const k = e.key === " " ? "space" : e.key.toLowerCase();
  const act = rebindAction;
  rebindAction = null;
  if (k !== "escape" && !["escape", "enter"].includes(k)) {
    // swap with whichever action already uses this key
    const other = ACTIONS.find(([id]) => id !== act && boundKey(id) === k);
    if (other) state.settings.binds[other[0]] = boundKey(act);
    state.settings.binds[act] = k;
    rebuildKeyMap();
    saveSettings();
  }
  renderSettings();
}

function saveSettings() {
  try { localStorage.setItem("hollowhouse.settings", JSON.stringify(state.settings)); } catch (e) {}
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("hollowhouse.settings") || "null");
    if (s && typeof s === "object") {
      ["showPrompts", "soundOn"].forEach((k) => { if (typeof s[k] === "boolean") state.settings[k] = s[k]; });
      ["brightness", "sens", "volume"].forEach((k) => { if (typeof s[k] === "number" && isFinite(s[k])) state.settings[k] = s[k]; });
      if (s.binds && typeof s.binds === "object") state.settings.binds = s.binds;
    }
  } catch (e) {}
  rebuildKeyMap();
}
function applySettings() {
  const b = state.settings.brightness;
  renderer.toneMappingExposure = 1.25 * b;
  ambientLight.intensity = 0.14 * b;
  if (masterGain) masterGain.gain.value = state.settings.volume;
}
loadSettings();

// ---- gamepad: left stick moves, right stick looks, A interact, X flashlight, B crouch, Y switch item,
// triggers / L3 run, Select inventory, Start pause. A also presses the main button on menu screens.
let padMoveX = 0, padMoveY = 0, padSprint = false;
let padPrev = [];
function pollGamepad(dt) {
  let gp = null;
  try { gp = (navigator.getGamepads && navigator.getGamepads()[0]) || null; } catch (e) {}
  if (!gp) { padMoveX = padMoveY = 0; padSprint = false; return; }
  const dz = (v) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
  const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
  const edge = (i) => { const now = b(i); const was = !!padPrev[i]; padPrev[i] = now; return now && !was; };
  const press = [0, 1, 2, 3, 8, 9].map((i) => [i, edge(i)]).reduce((o, [i, v]) => { o[i] = v; return o; }, {});
  const ph = state.phase;
  const click = (id) => { const el = document.getElementById(id); if (el && !el.classList.contains("hidden")) el.click(); };
  if (ph === "explore" && !state.activeNpc && !state.transition) {
    padMoveX = dz(gp.axes[0] || 0);
    padMoveY = -dz(gp.axes[1] || 0);
    padSprint = b(6) || b(7) || b(10);
    const lx = dz(gp.axes[2] || 0), ly = dz(gp.axes[3] || 0);
    yawObject.rotation.y -= lx * 2.6 * state.settings.sens * dt;
    camera.rotation.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.rotation.x - ly * 2.0 * state.settings.sens * dt));
    if (press[0]) handleInteract();
    if (press[2]) toggleFlashlight();
    if (press[1]) state.crouch = !state.crouch;
    if (press[3]) cycleHeld();
    if (press[8]) openInventory();
    if (press[9]) openPauseMenu();
  } else {
    padMoveX = padMoveY = 0;
    padSprint = false;
    if (ph === "title" && press[0]) click(readSave() ? "title-continue-button" : "title-start-button");
    else if (ph === "story" && press[0]) document.getElementById("Story-screen").click();
    else if (ph === "paused" && (press[0] || press[9])) closePauseMenu();
    else if (ph === "inventory" && (press[1] || press[8] || press[9])) closeInventory();
    else if (ph === "reading" && (press[0] || press[1])) closeReader();
    else if (ph === "caught" && press[0]) click("caught-retry-button");
    else if (ph === "ending" && press[0]) click("ending-return");
    else if (ph === "inventory" && press[3]) cycleHeld();
  }
}

// ---- checkpoints: saved at each major step; being caught, or Continue on the title screen, loads the last one
const milestoneDone = new Set();
const MILESTONES = [
  ["staff key", () => state.inventory.staffKey],
  ["power on", () => state.flags.powerOn],
  ["second floor", () => state.flags.powerOn && levelOf(yawObject.position.x) === 1],
  ["elevator key", () => state.inventory.elevKey],
];
let milestoneTick = 0;
function checkMilestones(dt) {
  milestoneTick -= dt;
  if (milestoneTick > 0) return;
  milestoneTick = 1;
  if (state.phase !== "explore" || state.transition || state.flags.finale || state.flags.finaleWon || faceScare) return;
  if (!["idle", "waiting", "gone", "done"].includes(state.entity.mode)) return; // not mid-chase
  MILESTONES.forEach(([id, test]) => {
    if (milestoneDone.has(id) || !test()) return;
    milestoneDone.add(id);
    saveCheckpoint(id);
  });
}
function saveCheckpoint(name) {
  try {
    const p = yawObject.position;
    const data = {
      v: 1, name,
      flags: state.flags, inventory: state.inventory, held: state.held, batteries: state.batteries,
      batteryLevel: state.batteryLevel, frontDoorOpen: state.frontDoorOpen, doorsOpen: state.doorsOpen,
      at: { x: p.x, z: p.z, yaw: yawObject.rotation.y },
    };
    localStorage.setItem("hollowhouse.save", JSON.stringify(data));
  } catch (e) {}
}
function readSave() {
  try {
    const s = JSON.parse(localStorage.getItem("hollowhouse.save") || "null");
    return s && s.v === 1 && s.at ? s : null;
  } catch (e) { return null; }
}
function applySave(s) {
  resetRun();
  state.flags = s.flags || {};
  state.inventory = s.inventory || {};
  state.held = s.held || null;
  state.batteries = s.batteries || 0;
  state.batteryLevel = s.batteryLevel != null ? s.batteryLevel : 100;
  state.frontDoorOpen = !!s.frontDoorOpen;
  state.doorsOpen = s.doorsOpen || {};
  state.flashlightOn = false;
  MILESTONES.forEach(([id, test]) => { try { if (test()) milestoneDone.add(id); } catch (e) {} });
  enterExplore(s.at);
}

// ---- settings screen ---------------------------------------------------------

function renderSettings() {
  const btn = document.getElementById("toggle-prompts");
  btn.textContent = state.settings.showPrompts ? "On" : "Off";
  btn.className = "toggle-button " + (state.settings.showPrompts ? "on" : "off");
  const sb = document.getElementById("toggle-sound");
  sb.textContent = state.settings.soundOn ? "On" : "Off";
  sb.className = "toggle-button " + (state.settings.soundOn ? "on" : "off");
  [["set-brightness", "brightness"], ["set-sens", "sens"], ["set-volume", "volume"]].forEach(([id, k]) => {
    const el = document.getElementById(id);
    if (el) el.value = state.settings[k];
  });
  const list = document.getElementById("bind-list");
  if (list) {
    list.innerHTML = "";
    ACTIONS.forEach(([id, label]) => {
      const row = document.createElement("div");
      row.className = "bind-row";
      const span = document.createElement("span");
      span.textContent = label;
      const bt = document.createElement("button");
      bt.className = "toggle-button on";
      bt.textContent = rebindAction === id ? "press a key..." : kn(id);
      bt.addEventListener("click", () => { rebindAction = id; renderSettings(); });
      row.appendChild(span);
      row.appendChild(bt);
      list.appendChild(row);
    });
  }
}
[["set-brightness", "brightness"], ["set-sens", "sens"], ["set-volume", "volume"]].forEach(([id, k]) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    state.settings[k] = parseFloat(el.value);
    applySettings();
    saveSettings();
  });
});
const resetBindsBtn = document.getElementById("reset-binds");
if (resetBindsBtn) resetBindsBtn.addEventListener("click", () => { state.settings.binds = {}; rebuildKeyMap(); saveSettings(); renderSettings(); });
const continueBtn = document.getElementById("title-continue-button");
if (continueBtn) continueBtn.addEventListener("click", () => {
  const sv = readSave();
  if (!sv) return;
  initAudio();
  applySave(sv);
});

document.getElementById("toggle-sound").addEventListener("click", () => {
  initAudio();
  setSoundEnabled(!state.settings.soundOn);
  saveSettings();
  renderSettings();
});

document.getElementById("toggle-prompts").addEventListener("click", () => {
  state.settings.showPrompts = !state.settings.showPrompts;
  saveSettings();
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

function enterExplore(at) {
  state.phase = "explore";
  showScreen("screen-explore");
  yawObject.position.set(at ? at.x : PLAYER_START.x, EYE_HEIGHT, at ? at.z : PLAYER_START.y);
  yawObject.rotation.y = at ? at.yaw : 0;
  camera.rotation.x = 0;
  buildWorld();
  clock.start();
  loopOn = true;
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
renderer.localClippingEnabled = true;
// filmic look: gentle tone curve, soft shadows from the flashlight
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x000000, 0.1, DARK_RANGE);
scene.background = new THREE.Color(0x0b0a0d);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 100);
const yawObject = new THREE.Object3D();
yawObject.add(camera);
scene.add(yawObject);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.14);
scene.add(ambientLight);
applySettings(); // saved brightness / volume


const flashlightLight = new THREE.SpotLight(0xffe6bc, 0, 15, 0.38, 0.9, 2); // warm, soft-edged cone that falls off with distance
flashlightLight.castShadow = true;
flashlightLight.shadow.mapSize.set(1024, 1024);
flashlightLight.shadow.camera.near = 0.1;
flashlightLight.shadow.camera.far = 15;
flashlightLight.shadow.bias = -0.0004;
flashlightLight.shadow.normalBias = 0.03;
flashlightLight.shadow.radius = 4;
flashlightLight.position.set(0, 0, 0);
camera.add(flashlightLight);
camera.add(flashlightLight.target);
flashlightLight.target.position.set(0, 0, -1);

const FLASHLIGHT_MAX_INTENSITY = 24; // tight beam with real falloff, so it needs more punch
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

// The axe swing: wind up, chop across and down, recover.
const AXE_REST = { p: [0.22, -0.2, -0.45], r: [0.5, 1.2, 0.9] };
const AXE_WIND = { p: [0.3, 0.12, -0.32], r: [0.2, 1.1, 2.3] };
const AXE_HIT = { p: [-0.05, -0.34, -0.7], r: [1.0, 1.35, -0.55] };
const SWING_TIME = { wind: 0.22, hit: 0.14, back: 0.3 };
function swingAxe() {
  if (state.phase !== "explore" || state.activeNpc || state.transition || state.flags.tut === "open") return;
  if (state.held !== "axe" || !state.inventory.axe || state.swing) return;
  state.swing = { t: 0, hit: false };
  state.flags.axeSwung = true;
  playClick();
}
function mixPose(a, b, k) {
  return { p: a.p.map((v, i) => v + (b.p[i] - v) * k), r: a.r.map((v, i) => v + (b.r[i] - v) * k) };
}
function updateSwing(dt) {
  const s = state.swing;
  if (!s) return;
  s.t += dt;
  const { wind, hit, back } = SWING_TIME;
  let pose;
  if (s.t < wind) {
    const k = s.t / wind;
    pose = mixPose(AXE_REST, AXE_WIND, k * k * (3 - 2 * k));
  } else if (s.t < wind + hit) {
    if (!s.whoosh) {
      s.whoosh = true;
      playWhoosh();
    }
    const k = (s.t - wind) / hit;
    pose = mixPose(AXE_WIND, AXE_HIT, k * k);
  } else {
    if (!s.hit) {
      s.hit = true;
      swingImpact();
    }
    const k = Math.min(1, (s.t - wind - hit) / back);
    pose = mixPose(AXE_HIT, AXE_REST, k * k * (3 - 2 * k));
  }
  heldAxe.position.set(...pose.p);
  heldAxe.rotation.set(...pose.r);
  if (s.t >= wind + hit + back) {
    state.swing = null;
    heldAxe.position.set(...AXE_REST.p);
    heldAxe.rotation.set(...AXE_REST.r);
  }
}
// What the blade hits at the bottom of the swing: boards if they're right in front of you.
function swingImpact() {
  if (hitHusk()) return;
  const p = yawObject.position;
  const boards = HOTSPOTS.find((h) => h.id === "boards");
  const fx = -Math.sin(yawObject.rotation.y);
  const fz = -Math.cos(yawObject.rotation.y);
  const bx = boards ? boards.x - p.x : 0;
  const bz = boards ? boards.y - p.z : 0;
  const bd = Math.hypot(bx, bz) || 1;
  if (boards && !state.flags.boardsChopped && bd < 1.7 && (bx * fx + bz * fz) / bd > 0.5) {
    state.flags.boardsChopped = true;
    playWoodCrack();
    setTimeout(playWoodCrack, 240);
    setTimeout(playWoodCrack, 520);
    setTimeout(() => buildWorld(), 600);
  } else {
    // a dull thud into the air or a wall
    playFootstep(false);
  }
}

function updateHeldFlashlight(dt) {
  heldAxe.visible = state.held === "axe" && !!state.inventory.axe;
  if (heldAxe.visible) {
    if (state.swing) updateSwing(dt);
    else {
      heldBobTime += dt * 2;
      heldAxe.position.y = -0.2 + Math.sin(heldBobTime) * 0.004;
    }
  } else state.swing = null;
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
let staffHaloMat = null;
let staffSignLight = null;
const STAFF_SIGN_LEVEL = 0.9;
let staffSignTimer = 0;
let deskBulbMat = null;
const DESK_LAMP_LEVEL = 0.6;
let deskLampFlickerLeft = 0;
let deskLampNextFlicker = 6;
let flickerLights = []; // {light, base} lights that stutter (emergency bulbs, boiler glow)
let swayers = []; // hanging chains
let flies = []; // flies round the staff-room drain
let scareActive = []; // pop-out apparitions in flight
let scareBlackout = 0;
let husks = [];
let deskLamp = null; // set in buildWorld(); flickers in the game loop
let deskLampFlickerTimer = 0;

let postFX = null; // bloom / light shafts / lens dirt pass (null = plain rendering)
function resizeRenderer() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (postFX) postFX.resize();
}
resizeRenderer();
window.addEventListener("resize", resizeRenderer);

// ---- textures (procedurally generated, no image files needed) -----------------

const TEXTURE_SIZE = 128;

// Handwritten paper: seeded jitter per letter, ink fade, and {scribbled-out} words nobody can read.
function drawPaper(c, text, sloppy, seed) {
  // A page from a notebook (or a torn sheet from a pad) written on in ballpoint. One person's hand:
  // neat and calm early on, frantic and wrong later.
  const w = (c.width = 512);
  const h = (c.height = 640);
  const ctx = c.getContext("2d");
  let s = seed * 9301 + 49297;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const ruled = seed % 3 !== 0; // lined notebook page, otherwise a plain sheet
  // paper
  const base = ctx.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, ruled ? "#e9e4d0" : "#e6dfc8");
  base.addColorStop(1, ruled ? "#d8cfb4" : "#d6ccb0");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 320; i++) { // paper fibres
    ctx.strokeStyle = `rgba(110,90,60,${0.03 + r() * 0.05})`;
    ctx.lineWidth = 1;
    const x = r() * w, y = r() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (r() - 0.5) * 14, y + (r() - 0.5) * 14);
    ctx.stroke();
  }
  for (let i = 0; i < 5; i++) { // age blotches
    ctx.fillStyle = `rgba(130,100,50,${0.03 + r() * 0.05})`;
    ctx.beginPath();
    ctx.arc(r() * w, r() * h, 40 + r() * 90, 0, 6.3);
    ctx.fill();
  }
  const firstLine = 98;
  const step = 52;
  if (ruled) {
    ctx.strokeStyle = "rgba(80,115,170,0.38)";
    ctx.lineWidth = 1.5;
    for (let y = firstLine + 6; y < h - 20; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y + 0.6);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(170,60,60,0.5)"; // margin
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(66, 0);
    ctx.lineTo(66, h);
    ctx.stroke();
    for (let y = 70; y < h; y += 150) { // binder holes
      ctx.fillStyle = "rgba(40,34,26,0.75)";
      ctx.beginPath();
      ctx.arc(24, y, 9, 0, 6.3);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
  const fy = h * (0.48 + r() * 0.06); // the fold
  ctx.fillStyle = "rgba(0,0,0,0.09)";
  ctx.fillRect(0, fy, w, 2);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(0, fy + 2, w, 2);
  const fx = w * (0.5 + (r() - 0.5) * 0.08);
  ctx.fillStyle = "rgba(0,0,0,0.05)";
  ctx.fillRect(fx, 0, 2, h);
  if (r() < 0.45) { // a coffee ring
    ctx.strokeStyle = "rgba(100,64,28,0.22)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(w * (0.55 + r() * 0.3), h * (0.7 + r() * 0.2), 36 + r() * 10, 0.3, 5.6);
    ctx.stroke();
  }
  const edge = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.75);
  edge.addColorStop(0, "rgba(60,40,10,0)");
  edge.addColorStop(1, "rgba(60,40,10,0.3)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);

  // handwriting
  const size = 46 - Math.min(sloppy, 1.8) * 5;
  const fam = '"Reenie Beanie","Nothing You Could Do","Segoe Script","Bradley Hand",cursive';
  ctx.textBaseline = "alphabetic";
  const ink = sloppy < 0.3 ? "#1c2340" : sloppy < 1 ? "#1a1c2a" : "#0e0d12";
  const neat = sloppy < 0.3;
  const left = ruled ? 78 : 40;
  let y = firstLine + (ruled ? 0 : r() * 10);
  text.split("\n").forEach((line, li) => {
    // shrink long lines so they stay on the page
    ctx.font = `${size}px ${fam}`;
    const plain = line.replace(/[{}]/g, "");
    const wide = ctx.measureText(plain).width * (1 + sloppy * 0.16) + plain.split(" ").length * size * 0.32;
    const sz = size * Math.min(1, (w - left - 26) / wide);
    ctx.font = `${sz}px ${fam}`;
    let x = left + r() * (neat ? 4 : 14) + (li > 0 ? sloppy * (r() - 0.3) * 8 : 0);
    const drift = (r() - 0.5) * sloppy * 0.05; // the line wanders uphill/downhill
    const startX = x;
    const heavy = sloppy > 1.1 && r() < 0.5;
    (line.match(/\{[^}]*\}|\S+/g) || []).forEach((tok) => {
      const bad = tok[0] === "{";
      const word = bad ? tok.slice(1, -1) : tok;
      if (bad) {
        // a word scribbled out so hard it tears the paper
        const len = Math.max(3, word.length) * sz * 0.34;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2 + r() * 2.5;
        ctx.beginPath();
        ctx.moveTo(x, y - sz * 0.3);
        for (let i = 1; i <= 11; i++) ctx.lineTo(x + (len * i) / 11, y - sz * 0.3 + (i % 2 ? -1 : 1) * sz * (0.1 + r() * 0.32));
        ctx.stroke();
        x += len;
      } else if (neat) {
        ctx.save();
        ctx.translate(x, y + (x - startX) * drift);
        ctx.rotate((r() - 0.5) * 0.02);
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.92;
        ctx.fillText(word, 0, 0);
        ctx.restore();
        x += ctx.measureText(word).width;
      } else {
        for (const ch of word) {
          ctx.save();
          const big = heavy ? 1 + r() * 0.4 : 1;
          ctx.translate(x, y + (r() - 0.5) * sloppy * 9 + (x - startX) * drift);
          ctx.rotate((r() - 0.5) * sloppy * 0.5);
          ctx.scale(big, big);
          ctx.globalAlpha = 1 - sloppy * r() * 0.3;
          ctx.fillStyle = ink;
          ctx.fillText(ch, 0, 0);
          if (sloppy > 0.8 && r() < 0.25) ctx.fillText(ch, 1.4, 1.2); // pressing too hard, doubling the stroke
          ctx.restore();
          x += (ctx.measureText(ch).width || sz * 0.4) * big * (0.92 + r() * 0.12 * (1 + sloppy));
        }
      }
      x += sz * 0.32;
    });
    y += step + (ruled ? (r() - 0.5) * sloppy * 4 : r() * sloppy * 10);
  });
  ctx.globalAlpha = 1;
  // creepier as it gets worse: smudges, drips, scratches
  if (sloppy > 0.6) {
    ctx.fillStyle = "rgba(20,20,40,0.2)";
    ctx.beginPath();
    ctx.ellipse(w * (0.55 + r() * 0.3), h * (0.65 + r() * 0.2), 22 + r() * 18, 14 + r() * 10, r(), 0, 6.3);
    ctx.fill();
  }
  if (sloppy > 1.0) {
    ctx.fillStyle = "rgba(90,12,10,0.55)";
    for (let i = 0; i < 3; i++) {
      const dx = w * (0.15 + r() * 0.7), dy = h * (0.2 + r() * 0.5), dl = 20 + r() * 70;
      ctx.beginPath();
      ctx.moveTo(dx, dy);
      ctx.lineTo(dx + 4, dy);
      ctx.lineTo(dx + 3, dy + dl);
      ctx.lineTo(dx + 1, dy + dl);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(dx + 2, dy + dl + 1, 3.2, 0, 6.3);
      ctx.fill();
    }
  }
  if (sloppy > 1.5) {
    for (let i = 0; i < 40; i++) { // scratched through the sheet
      ctx.strokeStyle = `rgba(30,20,20,${0.1 + r() * 0.2})`;
      ctx.lineWidth = 1 + r();
      const x = 30 + r() * (w - 60);
      ctx.beginPath();
      ctx.moveTo(x, h - 40 - r() * 90);
      ctx.lineTo(x + (r() - 0.5) * 20, h - 10);
      ctx.stroke();
    }
  }
  // the top edge is torn out of a pad (cleared, so the table shows through); tape on some
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let x = 0; x <= w; x += 8) ctx.lineTo(x, 4 + r() * 9);
  ctx.lineTo(w, 0);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  if (r() < 0.35) {
    ctx.save();
    ctx.translate(w * (r() < 0.5 ? 0.12 : 0.88), 18);
    ctx.rotate((r() - 0.5) * 0.8);
    ctx.fillStyle = "rgba(220,210,160,0.55)";
    ctx.fillRect(-34, -12, 68, 26);
    ctx.restore();
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
  flat(240, 240, cx, rows + 40, -3.15, 0x10150e); // dark ground all around (well below the floor, so it never covers the stairwells)
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
  const metal = new THREE.MeshStandardMaterial({ color: door.metal || "#b8963a", roughness: 0.55, metalness: 0.6 });
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
  staffHaloMat = null;
  staffSignLight = null;
  solids = [];
  deskLamp = null;
  flickerLights = [];
  swayers = [];
  flies = [];
  openAnims = [];
  windowRun = null;
  aptPillow = {};
  aptDoors = {};
  doorAnims = [];
  lootMeshes = {};
  bedEyes = null;
  clearScares();

  const rows = MAP.length;
  const cols = MAP[0].length;
  const interiorMat = new THREE.MeshStandardMaterial({ map: interiorWallTexture, roughness: 0.95 });
  // No moon: the street walls and roof carry a faint cold glow of their own.
  const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTexture, roughness: 0.95, emissive: 0x03050a });
  const lobbyWallMat = getWallMats().lobby; // the lobby side of the front wall matches the rest of the lobby
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
      const mesh = new THREE.Mesh(street ? facadeGeo : wallGeo, street ? faces : col >= 21 && col < 46 ? wallMatsFor(col, row) : col >= 21 ? interiorMat : wallMatsFor(col, row));
      mesh.position.set(col + 0.5, (street ? FACADE_H : WALL_HEIGHT) / 2, row + 0.5);
      worldGroup.add(mesh);
    }
  }

  for (let col = 0; col < 21; col++) {
    if (MAP[0][col] !== 0) continue; // studios open onto row 0: draw their north wall just outside the map
    const w = new THREE.Mesh(wallGeo, wallMatsFor(col, -1));
    w.position.set(col + 0.5, WALL_HEIGHT / 2, -0.5);
    worldGroup.add(w);
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
  addLobbyExtras();
  addMailboxes(19.9, 8.8);
  if (yawObject.position.x < 21) addWallDecor();
  addSofa(15.5, 11.6);
  addPlant(18.6, 8.7);
  addPlant(14.7, 8.7);
  addPlant(19.3, 12.3);
  addRunner(10.5, 5.5, 17, 1.1);
  addStairs();
  FIXTURES.forEach(addFixture);
  // One weak, cold bulb in the hallway so it isn't a total void.
  if (!state.flags.powerOn) [8.5, 12.5, 16.5].forEach((hx) => {
    const hallLight = new THREE.PointLight(0x8fa0b8, 0.3, 6, 2);
    hallLight.position.set(hx, WALL_HEIGHT * 0.9, 5.5);
    worldGroup.add(hallLight);
  });

  addLevels();
  {
    if (yawObject.position.x < 21) APT_DEFS.forEach(addApartment);
  }
  if (levelOf(yawObject.position.x) === 2) addBasementDecor();
  addFluorescents();
  worldGroup.traverse((o) => { if (o.isPointLight) o.intensity *= 1.1; }); // environment 10% brighter
  NPCS.forEach((npc) => addMarkerSprite(npc.x, npc.y, npc.color, 0.9));
  ITEMS.filter((it) => !state.inventory[it.id] && !it.hidden).forEach((it) => {
    if (it.id === "flashlight") addFlashlightModel(it.x, 0.78, it.y);
    else if (it.id === "johnKey") addKeyModel(it.x, 0.775, it.y);
    else if (it.id === "axe") addAxeModel(it.x, 0.07, it.y);
    else if (it.name === "Batteries") [0, 0.07].forEach((o) => addBox(0.05, 0.05, 0.05, it.x, it.h + 0.02, it.y + o - 0.03, 0x9a7a1a));
    else if (it.note) {
      const paper = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.28),
        new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawPaper(document.createElement("canvas"), it.paper, it.sloppy, it.seed)), roughness: 1, transparent: true, alphaTest: 0.4 })
      );
      paper.rotation.set(-Math.PI / 2, 0, it.seed * 0.7);
      paper.position.set(it.x, (it.h || 0.02) + 0.005, it.y);
      worldGroup.add(paper);
    }
    else addMarkerSprite(it.x, it.y, it.color, 0.4, it.height);
  });
  worldGroup.traverse((o) => {
    if (o.isMesh && !o.userData.noShadow) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

// Ceiling fluorescent tubes on the ground floor, switched on by the breaker.
let fluoLights = [];
let fluoTimer = 0;
const FLUORESCENTS = [
  [3.5, 10.5], [8.5, 9.5], [13.5, 10.5], [17.5, 9.5], // lobby
  [8.5, 6.0], [12.5, 6.0], [17.0, 6.0], // hallway
  [18.5, 3.4], // stairwell
  [3.0, 6.0], // staff room
];
function addFluorescents() {
  fluoLights = [];
  const px = yawObject.position.x;
  if (!state.flags.powerOn || px >= 21) return;
  // the hallway/lobby tubes, plus one small flickering tube in each studio
  const spots = FLUORESCENTS.map(([x, z]) => [x, z, 20, 14]).concat(APT_DEFS.filter((a) => a.id !== "apt2" || state.flags.apt2Light).map((a) => [a.ox + 1.5, 2.0, 9, 5]));
  const tubeMat = new THREE.MeshBasicMaterial({ color: 0xeaf6e0 });
  spots.forEach(([x, z, power, reach]) => {
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
  const W = -Math.PI / 2; // faces west (the kitchen wall faces into the room)

  flatTiles(ox + 2.3, 0.75, 0.7, 2.1); // kitchenette floor

  // ---- kitchenette along the east wall: counter + sink, stove, fridge, cabinets above
  furn(2.7, 1.2, W, [0.6, 0.9], (b) => {
    b(0.45, 0.85, 0.6, 0.225, 0.43, 0, wood); // solid half
    b(0.45, 0.85, 0.03, -0.225, 0.43, -0.285, wood); // the cupboard: back, end, floor, shelf, cans
    b(0.03, 0.85, 0.6, -0.435, 0.43, 0, wood);
    b(0.45, 0.03, 0.6, -0.225, 0.03, 0, darkwood);
    b(0.42, 0.02, 0.55, -0.225, 0.45, 0, darkwood);
    b(0.07, 0.1, 0.07, -0.3, 0.51, -0.1, 0x7a3a2a);
    b(0.07, 0.1, 0.07, -0.2, 0.51, -0.18, 0x8a8a70);
    b(0.07, 0.1, 0.07, -0.12, 0.51, -0.08, 0x4a6a3a);
    b(0.07, 0.1, 0.07, -0.3, 0.14, -0.1, 0x6a5a20);
    if (a.id === "apt2" && !((state.flags.looted || {}).apt2_under)) {
      const key = b(0.1, 0.012, 0.03, -0.2, 0.465, 0.12, 0xd4b04a); // Key 3 on the shelf
      key.rotation.y = 0.5;
      lootMeshes.apt2_under = key;
    }
    b(0.94, 0.05, 0.64, 0, 0.88, 0, 0x2a2926);
    b(0.4, 0.03, 0.36, 0.22, 0.9, 0.02, 0x15150f); // sink
    b(0.04, 0.2, 0.04, 0.22, 1.0, -0.2, 0x8a8a86);
    const pv = new THREE.Group();
    pv.position.set(-0.45, 0.43, 0.3);
    buildTarget.add(pv);
    aptDoors[a.id + "_under"] = pv;
    pv.rotation.y = ((state.flags.doorsOpenA || {})[a.id + "_under"]) ? DOOR_OPEN : 0;
    if (a.id === "apt2") {
      const lt = new THREE.PointLight(0xffe2b0, 0, 2.2, 2);
      lt.userData.on = 1.2;
      lt.intensity = pv.rotation.y ? 1.2 : 0;
      lt.position.set(-0.2, 0.55, 0.1);
      buildTarget.add(lt);
      aptDoors[a.id + "_under_light"] = lt;
    }
    const prev = buildTarget;
    buildTarget = pv;
    addBox(0.43, 0.8, 0.03, 0.215, 0, 0.015, 0x4a3524);
    addBox(0.025, 0.14, 0.03, 0.38, 0, 0.045, 0x8a8a76);
    buildTarget = prev;
  });
  furn(2.7, 1.95, W, [0.65, 0.6], (b) => {
    b(0.6, 0.88, 0.62, 0, 0.44, 0, white);
    [[-0.15, -0.14], [0.15, -0.14], [-0.15, 0.14], [0.15, 0.14]].forEach(([x, z]) => b(0.16, 0.02, 0.16, x, 0.9, z, 0x1a1a1a));
    b(0.46, 0.3, 0.02, 0, 0.42, 0.32, 0x151515); // oven window
    b(0.62, 0.2, 0.5, 0, 2.0, -0.05, 0x8a8a84); // range hood
    b(0.22, 0.45, 0.22, 0, 2.33, -0.16, 0x7a7a76);
  });
  furn(2.7, 2.55, W, [0.7, 0.6], (b) => {
    const wl = 0xa7a597;
    b(0.6, 1.5, 0.03, 0, 0.75, -0.305, wl); // hollow shell: back, sides, top, base
    b(0.03, 1.5, 0.64, -0.285, 0.75, 0, wl);
    b(0.03, 1.5, 0.64, 0.285, 0.75, 0, wl);
    b(0.6, 0.03, 0.64, 0, 1.485, 0, wl);
    b(0.6, 0.12, 0.64, 0, 0.06, 0, wl);
    [0.45, 0.85, 1.2].forEach((y) => b(0.54, 0.015, 0.58, 0, y, 0, 0xbfc4b8));
    b(0.52, 0.2, 0.5, 0, 0.26, 0, 0x7f8f88); // crisper
    b(0.09, 0.22, 0.09, -0.15, 0.97, -0.1, 0xe6e4d6); // milk, long past its date
    b(0.09, 0.05, 0.09, -0.15, 1.1, -0.1, 0x3a5a9a);
    b(0.08, 0.12, 0.08, 0.05, 0.92, -0.15, 0x6a7a3a);
    b(0.18, 0.1, 0.16, 0.12, 0.51, -0.05, 0xd8d4c4);
    b(0.1, 0.02, 0.1, 0.12, 0.57, -0.05, 0x4a6a3a); // mold
    b(0.2, 0.06, 0.12, -0.1, 0.49, -0.12, 0xc8b890);
    b(0.14, 0.1, 0.14, 0.1, 1.26, -0.1, 0x3a4a22);
    [-0.15, -0.05, 0.05].forEach((x, i) => b(0.04, 0.14, 0.04, x, 1.27, 0.1, [0x8a2a22, 0x9a8a22, 0x4a3a22][i]));
    b(0.2, 0.08, 0.14, -0.05, 0.89, 0.1, 0x6a6a5a);
    const pv = new THREE.Group();
    pv.position.set(-0.3, 0, 0.32);
    buildTarget.add(pv);
    aptDoors[a.id + "_fridge"] = pv;
    pv.rotation.y = ((state.flags.doorsOpenA || {})[a.id + "_fridge"]) ? DOOR_OPEN : 0;
    if (a.id === "apt2") {
      const lt = new THREE.PointLight(0xd8f0c8, 0, 2.6, 2);
      lt.userData.on = 1.4;
      lt.intensity = pv.rotation.y ? 1.4 : 0;
      lt.position.set(0, 0.9, 0.1);
      buildTarget.add(lt);
      aptDoors[a.id + "_fridge_light"] = lt;
    }
    const prev = buildTarget;
    buildTarget = pv;
    addBox(0.6, 1.48, 0.04, 0.3, 0.76, 0.02, 0xa7a597);
    addBox(0.03, 0.4, 0.04, 0.54, 1.1, 0.06, 0x77756e);
    addBox(0.03, 0.3, 0.04, 0.54, 0.5, 0.06, 0x77756e);
    addBox(0.62, 0.015, 0.045, 0.3, 0.98, 0.02, 0x333330);
    addBox(0.1, 0.1, 0.01, 0.2, 1.25, 0.05, 0xc84a3a);
    addBox(0.12, 0.08, 0.01, 0.38, 0.7, 0.05, 0xe0dcc8);
    buildTarget = prev;
  });
  furn(2.85, 1.2, W, null, (b) => {
    b(0.9, 0.7, 0.32, 0, 1.95, 0, wood);
    b(0.012, 0.65, 0.02, 0, 1.95, 0.17, darkwood);
    const door = b(0.4, 0.65, 0.03, 0.5, 1.95, 0.3, wood);
    door.rotation.y = 0.9; // a cabinet door hanging open
  });

  // ---- bed, nightstand, dresser
  furn(0.55, 1.5, 0, [0.9, 1.8], (b) => {
    [[-0.38, -0.8], [0.38, -0.8], [-0.38, 0.8], [0.38, 0.8]].forEach(([x, z]) => b(0.05, 0.28, 0.05, x, 0.14, z, darkwood));
    b(0.9, 0.06, 1.8, 0, 0.3, 0, darkwood);
    b(0.82, 0.14, 1.7, 0, 0.41, 0, 0x6a665a); // stained mattress
    b(0.82, 0.05, 0.95, 0, 0.5, 0.35, 0x4a2a2a);
    b(0.92, 0.65, 0.05, 0, 0.6, -0.88, darkwood);
  });
  {
    const pm = addBox(0.42, 0.1, 0.32, ox + 0.55, 0.53, 0.88, 0x8a8678);
    pm.rotation.y = 0.06;
    aptPillow[a.id] = { m: pm, bx: ox + 0.55, by: 0.53, bz: 0.88 };
  }
  // things under the bed (you have to crouch to see them)
  [[0.45, 2.0, 0.22, 0.12, 0.3, 0x7a6a50], [0.7, 1.2, 0.3, 0.06, 1.1, 0x3a3a38], [0.3, 1.4, 0.16, 0.02, 0.5, 0x4a4a46], [0.62, 2.2, 0.12, 0.03, 0.9, 0x5a2a2a]].forEach(([x, z, s, h2, r, c]) => {
    const m = addBox(s * 1.5, h2, s, ox + x, h2 / 2, z, c);
    m.rotation.y = r;
  });
  if (a.id === "apt2") {
    const eyes = new THREE.Group();
    const em = new THREE.MeshBasicMaterial({ color: 0xe8e4b0, fog: false });
    [-0.045, 0.045].forEach((dx) => {
      const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.01), em);
      e1.position.x = dx;
      eyes.add(e1);
    });
    eyes.position.set(ox + 0.55, 0.13, 2.28);
    eyes.visible = false;
    worldGroup.add(eyes);
    bedEyes = { g: eyes, t: 0, gone: false };
  }
  furn(1.25, 0.35, 0, [0.4, 0.4], (b) => {
    b(0.4, 0.5, 0.4, 0, 0.25, 0, wood);
    b(0.3, 0.12, 0.02, 0, 0.34, 0.21, darkwood);
  });
  furn(1.95, 0.3, 0, [0.7, 0.4], (b) => {
    b(0.7, 0.88, 0.4, 0, 0.44, 0, wood);
    [0.22, 0.5, 0.76].forEach((y) => { b(0.62, 0.012, 0.02, 0, y, 0.21, darkwood); b(0.05, 0.03, 0.03, 0, y - 0.09, 0.22, 0x8a8a76); });
  });

  // ---- couch (west wall, south end) and a small desk (south-east corner)
  if (a.id !== "apt2") furn(0.45, 3.05, Math.PI / 2, [0.8, 1.3], (b) => {
    b(1.3, 0.38, 0.8, 0, 0.23, 0, 0x4a4036);
    b(1.3, 0.45, 0.2, 0, 0.58, -0.3, 0x4a4036);
    b(0.18, 0.5, 0.8, -0.56, 0.35, 0, 0x3e362e);
    b(0.18, 0.5, 0.8, 0.56, 0.35, 0, 0x3e362e);
    b(0.5, 0.1, 0.55, -0.2, 0.46, 0.08, 0x554a3e);
    b(0.5, 0.1, 0.55, 0.28, 0.46, 0.08, 0x554a3e);
  });
  furn(2.45, 3.6, W, [0.5, 0.7], (b) => {
    b(0.7, 0.05, 0.5, 0, 0.74, 0, wood);
    b(0.04, 0.72, 0.46, -0.31, 0.36, 0, darkwood);
    b(0.04, 0.72, 0.46, 0.31, 0.36, 0, darkwood);
    b(0.3, 0.35, 0.4, 0.15, 0.5, 0, darkwood); // drawers
  });
  addBox(0.9, 0.012, 1.0, ox + 1.4, 0.009, 2.5, 0x3b2323); // worn rug
  if (a.id === "apt2") {
    // lived-in clutter: window with broken blinds and torn curtains, lamp, laundry, takeout, trash
    // the window on the back (north) wall: moonlight, a curtain drawn part-way, a wall switch by the door
    const wx = ox + 1.5;
    const paneMat = new THREE.MeshBasicMaterial({ color: 0x3a5486, fog: false });
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.0, 0.01), paneMat);
    pane.position.set(wx, 1.65, 0.03);
    worldGroup.add(pane);
    const moon = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.01), new THREE.MeshBasicMaterial({ color: 0xeaf0ff, fog: false }));
    moon.position.set(wx + 0.28, 1.98, 0.04);
    worldGroup.add(moon);
    addBox(1.05, 0.05, 0.05, wx, 2.17, 0.05, 0x3a2c20);
    addBox(1.05, 0.05, 0.06, wx, 1.13, 0.06, 0x3a2c20);
    addBox(0.05, 1.05, 0.05, wx - 0.5, 1.65, 0.05, 0x3a2c20);
    addBox(0.05, 1.05, 0.05, wx + 0.5, 1.65, 0.05, 0x3a2c20);
    addBox(0.03, 1.0, 0.03, wx, 1.65, 0.06, 0x3a2c20);
    addBox(0.95, 0.03, 0.03, wx, 1.65, 0.06, 0x3a2c20);
    addBox(1.5, 0.025, 0.025, wx, 2.3, 0.14, 0x2a2018); // curtain rod
    [[-0.5, 0.0], [-0.4, 0.03], [-0.31, 0.0], [0.5, 0.0], [0.41, 0.03], [0.33, 0.0]].forEach(([dx, dz], i) => {
      const cur = addBox(0.1, 1.15 - (i === 4 ? 0.2 : 0), 0.04, wx + dx, 1.72 - (i === 4 ? 0.1 : 0), 0.12 + dz, i % 2 ? 0x3f313c : 0x4a3a46);
      cur.rotation.z = (i === 1 ? 0.03 : 0);
    });
    // moonlight: a cool light from the window and a pale lattice of it on the floor
    const moonL = new THREE.PointLight(0x8aa4e0, 1.5, 5.5, 2);
    moonL.position.set(wx, 1.7, 0.5);
    worldGroup.add(moonL);
    const patchMat = new THREE.MeshBasicMaterial({ color: 0x9ab4ea, transparent: true, opacity: 0.2, depthWrite: false, fog: false });
    [[-0.22, 0.4], [0.22, 0.4], [-0.22, 0.9], [0.22, 0.9]].forEach(([dx, dz]) => {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.42), patchMat);
      q.rotation.x = -Math.PI / 2;
      q.position.set(wx + dx + 0.1, 0.02, 1.0 + dz);
      worldGroup.add(q);
    });
    // the light switch, left of the door as you come in
    addBox(0.09, 0.14, 0.015, ox + 0.9, 1.3, 3.99, 0xcfc8b4);
    addBox(0.025, 0.05, 0.02, ox + 0.9, state.flags.apt2Light ? 1.33 : 1.27, 3.98, 0x2a2a28);
    furn(1.28, 0.34, 0, null, (b) => { // lamp on the nightstand
      b(0.12, 0.03, 0.12, 0, 0.52, 0, 0x2a2a28);
      b(0.03, 0.2, 0.03, 0, 0.64, 0, 0x2a2a28);
      b(0.2, 0.15, 0.2, 0, 0.8, 0, 0x6a5a40).rotation.z = 0.12;
      b(0.1, 0.05, 0.06, 0.12, 0.54, 0.05, 0x151515); // dead alarm clock
    });
    // (floor clutter, laundry, takeout, cans, bins and dishes removed: simple rooms read better)
    const pic = addBox(0.04, 0.4, 0.3, ox + 0.04, 1.75, 1.2, 0x2a2018);
    pic.rotation.x = 0.25;
    addBox(0.02, 0.33, 0.24, ox + 0.07, 1.75, 1.2, 0x5a6a5a).rotation.x = 0.25;
    const stain = addBox(0.02, 1.0, 0.7, ox + 0.03, 1.2, 0.95, 0x1c1a14);
    stain.rotation.x = 0.02;
    addBox(0.7, 0.01, 0.5, ox + 0.9, 0.012, 1.55, 0x1f1a16).rotation.y = 0.4; // stain under the bed
  }

  // ---- writing on the wall
  WALL_WRITING.filter((w) => w.apt === a.id).forEach((w) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 1.0),
      new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawPaper(document.createElement("canvas"), w.paper, w.sloppy, w.seed)), roughness: 1 })
    );
    m.rotation.y = w.rot;
    m.position.set(ox + w.rx, 1.6, w.rz);
    worldGroup.add(m);
  });

  // ---- trim: baseboards and crown moulding make each flat look finished, in its own colour
  {
    const trim = { apt2: 0xcfc4a0, apt3: 0xd8c6cc, john: 0x1c1010 }[a.id] || 0x8a7a60;
    addBox(2.96, 0.12, 0.03, ox + 1.5, 0.06, 0.03, trim);
    addBox(0.03, 0.12, 3.94, ox + 0.03, 0.06, 2.0, trim);
    addBox(0.03, 0.12, 3.94, ox + 2.97, 0.06, 2.0, trim);
    addBox(0.95, 0.12, 0.03, ox + 0.5, 0.06, 3.97, trim);
    addBox(0.95, 0.12, 0.03, ox + 2.5, 0.06, 3.97, trim);
    addBox(2.96, 0.1, 0.06, ox + 1.5, 2.94, 0.04, trim);
    addBox(0.06, 0.1, 3.94, ox + 0.04, 2.94, 2.0, trim);
    addBox(0.06, 0.1, 3.94, ox + 2.96, 2.94, 2.0, trim);
    addBox(2.96, 0.1, 0.06, ox + 1.5, 2.94, 3.96, trim);
  }
  if (a.id === "apt3") {
    // the collector: a wall of old photographs, dolls on the dresser, a red-shaded lamp, the calendar by the desk
    const pw = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawPhotoWall()), roughness: 1 }));
    pw.position.set(ox + 1.5, 1.85, 0.045);
    worldGroup.add(pw);
    [-0.28, 0, 0.28].forEach((dx, i) => {
      const body = addBox(0.1, 0.16, 0.07, ox + 1.95 + dx, 0.96, 0.3, [0x6a3a4a, 0x3a4a6a, 0x5a5a3a][i]);
      body.rotation.y = (i - 1) * 0.5;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), new THREE.MeshStandardMaterial({ color: 0xe0d6c0, roughness: 0.6 }));
      head.position.set(ox + 1.95 + dx, 1.12, 0.3);
      worldGroup.add(head);
    });
    furn(1.4, 3.35, 0, [0.3, 0.3], (b) => {
      b(0.04, 1.5, 0.04, 0, 0.75, 0, 0x2a2018);
      b(0.2, 0.03, 0.2, 0, 0.02, 0, 0x2a2018);
      const sh = b(0.28, 0.22, 0.28, 0, 1.55, 0, 0x7a2018);
      sh.material = new THREE.MeshBasicMaterial({ color: 0x7a2418 });
    });
    const cal = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.48), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawCalendar()), roughness: 1 }));
    cal.rotation.y = -Math.PI / 2;
    cal.position.set(ox + 2.96, 1.55, 3.4);
    worldGroup.add(cal);
  }
  if (a.id === "john") {
    // red string and clippings on the north wall, newspapers piled on the floor, foil over the glass
    const sb = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.9), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawStringBoard()), roughness: 1 }));
    sb.position.set(ox + 2.35, 1.7, 0.045);
    worldGroup.add(sb);
  }
  // ---- damage
  (dmg.ceil || []).forEach(([x, z, w, d]) => {
    addBox(w, 0.02, d, ox + x, WALL_HEIGHT - 0.012, z, 0x020202);
    const flap = addBox(0.5, 0.03, 0.4, ox + x + w / 2, WALL_HEIGHT - 0.22, z, 0x5a5448);
    flap.rotation.z = 0.7;
  });
  const mess = [0x4a463e, 0x5a5448, 0x6a6558, 0x3a2a1c, 0x2c2c2a];
  for (let i = 0; i < Math.ceil(dmg.mess * 0.3); i++) {
    const rx = 0.3 + rnd() * 2.4;
    const rz = 0.3 + rnd() * 3.4;
    const wx = ox + rx;
    if (isWall(wx, rz) || solids.some((s) => wx > s.minX - 0.05 && wx < s.maxX + 0.05 && rz > s.minZ - 0.05 && rz < s.maxZ + 0.05)) continue;
    const s = 0.05 + rnd() * 0.1;
    const m = addBox(s, s * (0.2 + rnd() * 0.5), s * (0.6 + rnd()), wx, s * 0.15, rz, rnd() < 0.3 ? 0x9a9688 : mess[i % mess.length]);
    m.rotation.y = rnd() * 3;
  }
}


// ---- drawers and the fridge open on screen when you search them ------------------------------------
let openAnims = [];
let aptPillow = {};
let aptDoors = {}; // each fridge / cupboard door (they swing open)
let lootMeshes = {};
let doorAnims = [];
function spotOf(h) {
  const parts = h.id.split("_");
  const apt = APT_DEFS.find((a) => a.id === parts[0]);
  const sp = apt && APT_SPOTS.find((s) => s.k === parts[1]);
  return sp ? { apt, sp } : null;
}
function isDoorSpot(so) {
  return !!so && (so.sp.anim === "fridge" || so.sp.anim === "cabdoor");
}
const DOOR_OPEN = -1.9;
function toggleDoor(h) {
  const pv = aptDoors[h.id];
  if (!pv) return;
  if (!state.flags.doorsOpenA) state.flags.doorsOpenA = {};
  const f = state.flags.doorsOpenA;
  f[h.id] = !f[h.id];
  doorAnims = doorAnims.filter((d) => d.pv !== pv);
  doorAnims.push({ pv, from: pv.rotation.y, to: f[h.id] ? DOOR_OPEN : 0, t: 0, id: h.id });
  playDrawerSound(true);
  if (!state.flags.looted) state.flags.looted = {};
  if (f[h.id] && !state.flags.looted[h.id]) {
    state.flags.looted[h.id] = true;
    if (lootMeshes[h.id]) { const lm = lootMeshes[h.id]; setTimeout(() => { lm.visible = false; }, 900); }
    lootList(h).forEach((lid, n) => setTimeout(() => collectItem(lid), 900 + n * 1100));
  }
}
function updateDoorAnims(dt) {
  for (let i = doorAnims.length - 1; i >= 0; i--) {
    const d = doorAnims[i];
    d.t += dt / 0.55;
    const k = Math.min(1, d.t);
    d.pv.rotation.y = d.from + (d.to - d.from) * (k * k * (3 - 2 * k));
    if (k >= 1) {
      const lt = aptDoors[d.id + "_light"];
      if (lt) lt.intensity = d.to ? lt.userData.on : 0;
      doorAnims.splice(i, 1);
    }
  }
}
let bedEyes = null; // each bed's pillow (it lifts when you check under it)
function playDrawerSound(fridge) {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const n = audioCtx.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  const bp = audioCtx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 3;
  bp.frequency.setValueAtTime(fridge ? 300 : 700, t);
  bp.frequency.linearRampToValueAtTime(fridge ? 520 : 380, t + 0.4);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.16, t + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  n.connect(bp).connect(g).connect(audioCtx.destination);
  n.start(t);
  n.stop(t + 0.5);
  const o = audioCtx.createOscillator();
  const og = audioCtx.createGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(95, t + 0.42);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.55);
  og.gain.setValueAtTime(0.0001, t + 0.4);
  og.gain.linearRampToValueAtTime(0.22, t + 0.43);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  o.connect(og).connect(audioCtx.destination);
  o.start(t + 0.4);
  o.stop(t + 0.65);
}
function lootList(h) {
  return (Array.isArray(h.loot) ? h.loot : [h.loot]).filter((x) => x && x !== "none");
}
// what you see inside while it's open
function buildContents(ids) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
  ids.forEach((id, i) => {
    const it = ITEMS.find((x) => x.id === id) || {};
    const o = i * 0.14 - (ids.length - 1) * 0.07;
    if (it.note) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.008, 0.32), mat(0xf2eedb));
      m.position.set(o, 0.03, 0.02);
      m.rotation.x = 0.55;
      m.rotation.y = 0.12;
      g.add(m);
    } else if (it.key) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.012, 0.025), mat(0xd4b04a));
      m.position.set(o, 0.01, 0);
      m.rotation.y = 0.5;
      const ring = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.04), mat(0xd4b04a));
      ring.position.set(-0.06, 0, 0);
      m.add(ring);
      g.add(m);
    } else if (id === "a2Cans") {
      [[-0.07, 0], [0.02, 0.04], [0.09, -0.03]].forEach(([x, z], k) => {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 10), mat([0x7a3a2a, 0x8a8a70, 0x4a6a3a][k]));
        c.position.set(x, 0.05, z);
        g.add(c);
      });
    } else {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.06), mat(0x8a8068));
      m.position.set(o, 0.02, 0);
      g.add(m);
    }
  });
  return g;
}
function startOpenAnim(h) {
  const parts = h.id.split("_");
  const apt = APT_DEFS.find((a) => a.id === parts[0]);
  const sp = apt && APT_SPOTS.find((s) => s.k === parts[1]);
  if (!sp || !sp.anim) return false;
  const ids = lootList(h);
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 });
  const G = new THREE.Group();
  let mover = null;
  let pillow = null;
  if (sp.anim === "pillow") {
    pillow = aptPillow[apt.id];
    if (!pillow) return false;
    G.position.set(pillow.bx, pillow.by - 0.04, pillow.bz);
    G.add(buildContents(ids));
  } else {
    G.position.set(apt.ox + sp.fx, sp.y, sp.fz);
    G.rotation.y = sp.rot;
  }
  if (sp.anim === "drawer") {
    mover = new THREE.Group();
    const front = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.17, 0.03), mat(0x5a432e));
    front.position.z = 0.015;
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.4), mat(0x0c0a08));
    tray.position.set(0, -0.01, -0.2);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.04), mat(0x9a9a86));
    knob.position.set(0, 0, 0.045);
    const inner = buildContents(ids);
    inner.position.set(0, 0.06, -0.2);
    mover.add(front, tray, knob, inner);
  } else if (sp.anim === "fridge" || sp.anim === "cabdoor") {
    mover = aptDoors[apt.id + "_" + parts[1]];
    if (!mover) return false;
  }
  const isDoor = sp.anim === "fridge" || sp.anim === "cabdoor";
  const gl = new THREE.PointLight(isDoor && sp.anim === "fridge" ? 0xd8f0c8 : 0xffe2b0, isDoor ? 1.4 : 0.9, isDoor ? 2.4 : 1.8, 2);
  gl.position.set(0, isDoor ? (sp.anim === "fridge" ? 0.9 : 0.15) : 0.35, isDoor ? 0.1 : 0.3);
  G.add(gl);
  if (mover && !isDoor) G.add(mover);
  worldGroup.add(G);
  playDrawerSound(sp.anim === "fridge" || sp.anim === "cabdoor");
  openAnims.push({ G, mover, kind: sp.anim, t: 0, pillow });
  return true;
}
function updateOpenAnims(dt) {
  for (let i = openAnims.length - 1; i >= 0; i--) {
    const a = openAnims[i];
    a.t += dt;
    const k = a.t < 0.4 ? a.t / 0.4 : a.t < 2.4 ? 1 : Math.max(0, 1 - (a.t - 2.4) / 0.4);
    const e = k * k * (3 - 2 * k);
    if (a.kind === "drawer") a.mover.position.z = 0.36 * e;
    else if (a.kind === "pillow") {
      const p = a.pillow;
      p.m.position.set(p.bx, p.by + 0.22 * e, p.bz - 0.12 * e);
      p.m.rotation.x = -0.9 * e;
    } else a.mover.rotation.y = -1.9 * e;
    if (a.t > 2.8) {
      if (a.pillow) {
        a.pillow.m.position.set(a.pillow.bx, a.pillow.by, a.pillow.bz);
        a.pillow.m.rotation.x = 0;
      }
      worldGroup.remove(a.G);
      openAnims.splice(i, 1);
    }
  }
}


// ---- something runs past apartment 2's window the moment the light comes on ------------------------
let windowRun = null;
function startWindowRun() {
  windowRun = { t: 0, g: null };
}
function updateWindowRun(dt) {
  const w = windowRun;
  if (!w) return;
  w.t += dt;
  if (!w.g && w.t >= 0.35) {
    const x0 = 6.5 - 0.47, x1 = 6.5 + 0.47;
    const clip = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -x0), new THREE.Plane(new THREE.Vector3(-1, 0, 0), x1)];
    const m = new THREE.MeshBasicMaterial({ color: 0x000000, clippingPlanes: clip, fog: false });
    const G = new THREE.Group();
    const part = (sx, sy, sz, x, y, z, rz) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
      b.position.set(x, y, z);
      b.rotation.z = rz || 0;
      G.add(b);
      return b;
    };
    part(0.2, 0.34, 0.06, 0, 0.62, 0, 0.35); // hunched torso
    part(0.13, 0.15, 0.06, -0.06, 0.88, 0, 0); // head
    part(0.05, 0.55, 0.04, -0.14, 0.62, 0, 1.0); // long arms
    part(0.05, 0.55, 0.04, 0.12, 0.7, 0, -0.9);
    w.l1 = part(0.07, 0.5, 0.05, -0.04, 0.25, 0, 0);
    w.l2 = part(0.07, 0.5, 0.05, 0.08, 0.25, 0, 0);
    G.position.set(6.5 + 1.2, 1.2, 0.045);
    worldGroup.add(G);
    w.g = G;
    w.t0 = w.t;
    playSkitter();
    playKnock();
  }
  if (w.g) {
    const k = (w.t - w.t0) / 0.3;
    w.g.position.x = 6.5 + 1.2 - k * 2.4; // right to left, very fast
    w.l1.rotation.z = Math.sin(k * 30) * 0.9;
    w.l2.rotation.z = -Math.sin(k * 30) * 0.9;
    if (k >= 1) {
      worldGroup.remove(w.g);
      windowRun = null;
    }
  }
}


// something under apartment 2's bed looks back at you, but only if you crouch down to look
function updateBedEyes(dt) {
  const b = bedEyes;
  if (!b || b.gone) return;
  const p = yawObject.position;
  const d = Math.hypot(p.x - b.g.position.x, p.z - b.g.position.z);
  b.t += dt;
  const watching = crouchK > 0.7 && d < 3.6 && state.phase === "explore";
  b.g.visible = watching && Math.sin(b.t * 2.3) > -0.85 && !(b.t % 4 > 3.7);
  if (watching && d < 1.15) {
    b.gone = true;
    b.g.visible = false;
    playSkitter();
  }
}


// ---- the score: a dark generative piece (music box, bowed swells, a heartbeat) and random things in the walls ----
let musicBus = null;
let musicTimer = 3;
let musicStep = 0;
let beatTimer = 0;
let eventTimer = 25;
const MUSIC_SCALE = [220, 261.63, 311.13, 329.63, 369.99, 440]; // A minor with a flat fifth and a major seventh pull
const MUSIC_CHORDS = [[110, 130.81, 164.81], [87.31, 130.81, 174.61], [82.41, 123.47, 155.56], [110, 138.59, 164.81]];
function ensureMusicBus() {
  if (musicBus || !audioCtx) return;
  const input = audioCtx.createGain();
  const out = audioCtx.createGain();
  out.gain.value = 0.9;
  input.connect(out);
  // a cheap cavern: two feedback delays through a lowpass
  [[0.37, 0.45], [0.53, 0.4]].forEach(([dtm, fb]) => {
    const d = audioCtx.createDelay(1);
    d.delayTime.value = dtm;
    const f = audioCtx.createGain();
    f.gain.value = fb;
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    input.connect(d);
    d.connect(lp).connect(f).connect(d);
    lp.connect(out);
  });
  out.connect(audioCtx.destination);
  musicBus = input;
}
function musicNote(f, t, vol, dur) {
  [[1, 0.5], [2.01, 0.22], [3.02, 0.1]].forEach(([m, v]) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = f * m * (1 + (Math.random() - 0.5) * 0.004);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol * v, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur / m);
    o.connect(g).connect(musicBus);
    o.start(t);
    o.stop(t + dur / m + 0.05);
  });
}
function musicSwell(chord, t, vol, dur) {
  const lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.linearRampToValueAtTime(900, t + dur * 0.6);
  lp.frequency.linearRampToValueAtTime(240, t + dur);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + dur * 0.5);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  lp.connect(g).connect(musicBus);
  chord.forEach((f, i) => {
    const o = audioCtx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f * (1 + (i - 1) * 0.003);
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.1);
  });
}
function playScoreBeat(vol) {
  const t = audioCtx.currentTime;
  [0, 0.2].forEach((off, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(70 - i * 12, t + off);
    o.frequency.exponentialRampToValueAtTime(34, t + off + 0.18);
    g.gain.setValueAtTime(0.0001, t + off);
    g.gain.linearRampToValueAtTime(vol * (i ? 0.7 : 1), t + off + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.2);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + off);
    o.stop(t + off + 0.25);
  });
}
let lastEventKind = "";
let lastScareT = -999;
function markScare() { lastScareT = performance.now() / 1000; }
function sinceScare() { return performance.now() / 1000 - lastScareT; }
// a heavy door shutting somewhere far off in the building
function playDistantSlam() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  [[0, 0.2], [0.18, 0.08]].forEach(([off, gain]) => {
    const n = audioCtx.createBufferSource();
    const lp = audioCtx.createBiquadFilter();
    const g = audioCtx.createGain();
    n.buffer = noiseBuf;
    n.loop = true;
    lp.type = "lowpass";
    lp.frequency.value = 260;
    g.gain.setValueAtTime(gain, t + off);
    g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.6);
    n.connect(lp).connect(g).connect(audioCtx.destination);
    n.start(t + off);
    n.stop(t + off + 0.7);
  });
}
// slow footsteps on the floor above: they cross the ceiling, then stop
function playOverhead() {
  if (!audioReady()) return;
  const count = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      if (!audioReady()) return;
      const t = audioCtx.currentTime;
      const n = audioCtx.createBufferSource();
      const lp = audioCtx.createBiquadFilter();
      const g = audioCtx.createGain();
      n.buffer = noiseBuf;
      lp.type = "lowpass";
      lp.frequency.value = 150;
      g.gain.value = 0.2 * (1 - i / (count + 2));
      n.connect(lp).connect(g).connect(audioCtx.destination);
      n.start(t);
    }, i * (620 + Math.random() * 120));
  }
}
function updateMusic(dt) {
  if (!audioReady() || state.phase !== "explore" && state.phase !== "breaker") return;
  ensureMusicBus();
  if (!musicBus) return;
  const tension = typeof entityTension === "number" ? entityTension : 0;
  const lvl = levelOf(yawObject.position.x);
  const dark = !state.flags.powerOn || lvl === 2 ? 1 : 0.55;
  // music box notes, sparser when it's quiet and busier as the thing closes in
  musicTimer -= dt;
  if (musicTimer <= 0) {
    const t = audioCtx.currentTime + 0.05;
    const chord = MUSIC_CHORDS[Math.floor(musicStep / 4) % MUSIC_CHORDS.length];
    if (musicStep % 4 === 0) musicSwell(chord, t, 0.05 * dark, 7);
    const n = MUSIC_SCALE[Math.floor(Math.random() * MUSIC_SCALE.length)] * (Math.random() < 0.25 ? 2 : 1);
    if (Math.random() < 0.8) musicNote(n, t, 0.09 * dark, 2.6);
    if (tension > 0.4 && Math.random() < 0.5) musicNote(n * 1.06, t + 0.12, 0.05, 1.6); // a note a semitone off
    musicStep++;
    musicTimer = (2.4 - tension * 1.6) * (0.7 + Math.random() * 0.8);
  }
  // things in the building: a slam far off, footsteps overhead, a knock in the pipes, a light stutter.
  // Random kind and timing each run, never right after a real scare, and never the same thing twice in a row.
  eventTimer -= dt;
  if (eventTimer <= 0 && state.phase === "explore" && !state.transition) {
    if (sinceScare() < 20) eventTimer = 5;
    else {
      eventTimer = 20 + Math.random() * 35 - tension * 12;
      const lv = levelOf(yawObject.position.x);
      const kinds = ["slam", "knock", "skitter", "dark", "sting", "steps", "creak"].filter((k) => k !== lastEventKind && !(k === "steps" && lv === 2));
      const k = kinds[Math.floor(Math.random() * kinds.length)];
      lastEventKind = k;
      if (k === "slam") playDistantSlam();
      else if (k === "knock") { playKnock(); setTimeout(playKnock, 420 + Math.random() * 300); }
      else if (k === "skitter") playSkitter();
      else if (k === "dark") scareBlackout = 0.35 + Math.random() * 0.3;
      else if (k === "steps") playOverhead();
      else if (k === "creak") playDoorCreak({ creak: 0.7, creakGain: 0.35, creakTone: 1500 });
      else { playSting(); markScare(); }
    }
  }
}


// ---- atmosphere: dust drifting in the flashlight beam, and film grain over everything ----
const DUST_N = 160;
let dustPts = null;
const dustPos = new Float32Array(DUST_N * 3);
const dustCol = new Float32Array(DUST_N * 3);
const dustVel = new Float32Array(DUST_N * 3);
let dustPosAttr = null;
let dustColAttr = null;
function respawnDust(i) {
  const p = yawObject.position;
  for (let tries = 0; tries < 6; tries++) {
    const dist = 1.5 + Math.random() * 4.6;
    const ang = yawObject.rotation.y + (Math.random() - 0.5) * 0.9;
    const x = p.x - Math.sin(ang) * dist;
    const z = p.z - Math.cos(ang) * dist;
    if (isWall(x, z)) continue;
    dustPos[i * 3] = x;
    dustPos[i * 3 + 1] = 0.3 + Math.random() * 2.4;
    dustPos[i * 3 + 2] = z;
    return;
  }
  dustPos[i * 3 + 1] = -50;
}
function dustSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const x = c.getContext("2d");
  const gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = gr;
  x.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
function initDust() {
  try {
    for (let i = 0; i < DUST_N; i++) {
      dustVel[i * 3] = (Math.random() - 0.5) * 0.06;
      dustVel[i * 3 + 1] = -0.01 - Math.random() * 0.03;
      dustVel[i * 3 + 2] = (Math.random() - 0.5) * 0.06;
      dustPos[i * 3 + 1] = -50;
    }
    const geo = new THREE.BufferGeometry();
    dustPosAttr = new THREE.BufferAttribute(dustPos, 3);
    dustColAttr = new THREE.BufferAttribute(dustCol, 3);
    geo.setAttribute("position", dustPosAttr);
    geo.setAttribute("color", dustColAttr);
    dustPts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.013, map: dustSprite(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    dustPts.frustumCulled = false;
    scene.add(dustPts);
  } catch (e) {
    dustPts = null;
  }
}
initDust();
function updateDust(dt) {
  if (!dustPts || !dustPosAttr) return;
  const p = yawObject.position;
  const on = state.flashlightOn && flashlightCurrentIntensity > 1 && state.phase === "explore";
  const fx = -Math.sin(yawObject.rotation.y);
  const fz = -Math.cos(yawObject.rotation.y);
  for (let i = 0; i < DUST_N; i++) {
    const k = i * 3;
    dustPos[k] += dustVel[k] * dt + Math.sin(performance.now() / 900 + i) * 0.0006;
    dustPos[k + 1] += dustVel[k + 1] * dt;
    dustPos[k + 2] += dustVel[k + 2] * dt;
    const dx = dustPos[k] - p.x, dz = dustPos[k + 2] - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 6.5 || dustPos[k + 1] < 0.1 || d < 1.0 || (dx * fx + dz * fz) / (d || 1) < 0.55 || isWall(dustPos[k], dustPos[k + 2])) respawnDust(i);
    // lit only inside the beam, brighter nearer the light
    let b = 0;
    if (on) {
      const dir = (dx * fx + dz * fz) / (d || 1);
      const cone = Math.max(0, (dir - 0.78) / 0.22);
      b = cone * Math.max(0, 1 - d / 6.5) * 0.4;
    }
    dustCol[k] = b; dustCol[k + 1] = b * 0.95; dustCol[k + 2] = b * 0.85;
  }
  dustPosAttr.needsUpdate = true;
  dustColAttr.needsUpdate = true;
}
(function initGrain() {
  try {
    const cv = document.getElementById("grain");
    if (!cv || !cv.getContext) return;
    cv.width = 480;
    cv.height = 270;
    const ctx = cv.getContext("2d");
    const frames = [];
    for (let f = 0; f < 5; f++) {
      const img = ctx.createImageData(480, 270);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 90 + Math.random() * 110;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      frames.push(img);
    }
    let n = 0;
    const timer = setInterval(() => ctx.putImageData(frames[(n = (n + 1) % frames.length)], 0, 0), 85);
    if (timer && timer.unref) timer.unref();
  } catch (e) {}
})();

// ---- post-processing: bloom, light shafts from the flashlight, lens dirt, a touch of chromatic fringe ----
function initPost() {
  try {
    const V = THREE.Vector2;
    const size = renderer.getDrawingBufferSize(new V());
    const mkRT = (w, h, ms) => new THREE.WebGLRenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), { type: THREE.HalfFloatType, samples: ms ? 4 : 0, depthBuffer: !!ms });
    const rtScene = mkRT(size.x, size.y, true);
    const rtA = mkRT(size.x / 2, size.y / 2, false);
    const rtB = mkRT(size.x / 2, size.y / 2, false);
    const vert = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
    const mat = (frag, uniforms, extra) => new THREE.ShaderMaterial(Object.assign({ vertexShader: vert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false }, extra || {}));
    const bright = mat("varying vec2 vUv; uniform sampler2D tIn; void main(){ vec3 c = texture2D(tIn, vUv).rgb; float l = dot(c, vec3(0.299, 0.587, 0.114)); gl_FragColor = vec4(c * smoothstep(0.9, 2.0, l), 1.0); }", { tIn: { value: null } });
    const blur = mat("varying vec2 vUv; uniform sampler2D tIn; uniform vec2 dir; void main(){ vec3 s = texture2D(tIn, vUv).rgb * 0.227027; s += (texture2D(tIn, vUv + dir * 1.3846).rgb + texture2D(tIn, vUv - dir * 1.3846).rgb) * 0.316216; s += (texture2D(tIn, vUv + dir * 3.2308).rgb + texture2D(tIn, vUv - dir * 3.2308).rgb) * 0.070270; gl_FragColor = vec4(s, 1.0); }", { tIn: { value: null }, dir: { value: new V() } });
    const shaft = mat("varying vec2 vUv; uniform sampler2D tIn; uniform vec2 center; void main(){ vec2 d = (center - vUv) / 22.0; vec2 p = vUv; vec3 acc = vec3(0.0); float w = 1.0; for (int i = 0; i < 22; i++) { p += d; acc += texture2D(tIn, p).rgb * w; w *= 0.93; } gl_FragColor = vec4(acc / 9.0, 1.0); }", { tIn: { value: null }, center: { value: new V(0.5, 0.5) } });
    // lens dirt: soft smudges and a couple of streaks
    const dc = document.createElement("canvas");
    dc.width = dc.height = 512;
    const dx = dc.getContext("2d");
    dx.fillStyle = "#000";
    dx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 46; i++) {
      const px = Math.random() * 512, py = Math.random() * 512, r = 18 + Math.random() * 70;
      const gr = dx.createRadialGradient(px, py, 0, px, py, r);
      const a = 0.12 + Math.random() * 0.4;
      gr.addColorStop(0, "rgba(255,255,255," + a + ")");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      dx.fillStyle = gr;
      dx.fillRect(px - r, py - r, r * 2, r * 2);
    }
    dx.strokeStyle = "rgba(255,255,255,0.12)";
    dx.lineWidth = 3;
    for (let i = 0; i < 8; i++) { dx.beginPath(); dx.moveTo(Math.random() * 512, Math.random() * 512); dx.lineTo(Math.random() * 512, Math.random() * 512); dx.stroke(); }
    const dirt = new THREE.CanvasTexture(dc);
    const compFrag = [
      "varying vec2 vUv; uniform sampler2D tScene, tBloom, tShaft, tDirt; uniform float uShaft, uBloom;",
      "void main(){",
      "  vec2 off = (vUv - 0.5) * 0.0035;",
      "  vec3 col = vec3(texture2D(tScene, vUv + off).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - off).b);",
      "  vec3 bl = texture2D(tBloom, vUv).rgb;",
      "  float dirtV = texture2D(tDirt, vUv).r;",
      "  col += bl * uBloom * (1.0 + dirtV * 3.2);",
      "  col += texture2D(tShaft, vUv).rgb * uShaft * vec3(1.0, 0.93, 0.8);",
      "  gl_FragColor = vec4(col, 1.0);",
      "#include <tonemapping_fragment>",
      "#include <colorspace_fragment>",
      "}",
    ].join("\n");
    const comp = mat(compFrag, { tScene: { value: rtScene.texture }, tBloom: { value: rtA.texture }, tShaft: { value: rtB.texture }, tDirt: { value: dirt }, uShaft: { value: 0 }, uBloom: { value: 0.5 } }, { toneMapped: true });
    const quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), comp);
    quad.frustumCulled = false;
    quadScene.add(quad);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    let shaftK = 0;
    const pass = (m, target) => {
      quad.material = m;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
    };
    return {
      resize() {
        const s = renderer.getDrawingBufferSize(new V());
        rtScene.setSize(Math.max(2, s.x | 0), Math.max(2, s.y | 0));
        rtA.setSize(Math.max(2, (s.x / 2) | 0), Math.max(2, (s.y / 2) | 0));
        rtB.setSize(Math.max(2, (s.x / 2) | 0), Math.max(2, (s.y / 2) | 0));
      },
      render(dt) {
        renderer.setRenderTarget(rtScene);
        renderer.render(scene, camera);
        const w = rtA.width, h = rtA.height;
        bright.uniforms.tIn.value = rtScene.texture;
        pass(bright, rtA);
        for (let i = 0; i < 2; i++) { // two soft blur passes, wider the second time
          blur.uniforms.tIn.value = rtA.texture;
          blur.uniforms.dir.value.set((1 + i) / w, 0);
          pass(blur, rtB);
          blur.uniforms.tIn.value = rtB.texture;
          blur.uniforms.dir.value.set(0, (1 + i) / h);
          pass(blur, rtA);
        }
        shaftK += ((state.flashlightOn && state.phase === "explore" ? 1 : 0) - shaftK) * Math.min(1, dt * 5);
        shaft.uniforms.tIn.value = rtA.texture;
        shaft.uniforms.center.value.set(0.5, 0.52);
        pass(shaft, rtB);
        comp.uniforms.uShaft.value = 0.5 * shaftK * (1 - 0.9 * beamClose);
        comp.uniforms.uBloom.value = 0.5 * (1 - 0.6 * beamClose);
        pass(comp, null);
      },
    };
  } catch (e) {
    console.warn("post-processing unavailable", e);
    return null;
  }
}
postFX = initPost();

// ---- the ending: the elevator's second ride, a room under the cellar, and something that hates the light ----
const FINALE = { start: { x: 51.7, y: 16.5, yaw: -Math.PI / 2 }, lamp: { x: 60.5, z: 16.5 }, boss: { x: 62.1, z: 16.5 } };
let finale = null;
function startFinale() {
  playDing();
  state.flags.finale = true;
  state.entity.mode = "done";
  entityGroup.visible = false;
  husks.forEach((h) => { h.mesh.visible = false; });
  clearFinaleBoss();
  finale = { mode: "arrive", t: 0, stare: 0, frozen: 0, x: FINALE.boss.x, z: FINALE.boss.z, path: null, repath: 0, speed: 2.3, mesh: null };
  startTransition(FINALE.start);
}
function clearFinaleBoss() {
  if (finale && finale.mesh) scene.remove(finale.mesh);
}
function clearFinale() {
  clearFinaleBoss();
  finale = null;
}
function addFinale() {
  const wallC = 0x80706a;
  floorPatch("plankDark", 50, 14, 13, 5, 1.0, 0.006);
  addBox(13.2, 0.2, 5.2, 56.5, 3.1, 16.5, 0x4a4a52); // ceiling
  addBox(13.4, 3, 0.2, 56.5, 1.5, 13.9, wallC); // walls
  addBox(13.4, 3, 0.2, 56.5, 1.5, 19.1, wallC);
  addBox(0.2, 3, 5.4, 49.9, 1.5, 16.5, wallC);
  addBox(0.2, 3, 5.4, 63.1, 1.5, 16.5, wallC);
  [[54.5, 15.3], [54.5, 17.7], [58.0, 16.5]].forEach(([x, z]) => { // pillars to run around
    addBox(0.7, 3, 0.7, x, 1.5, z, 0x8a7a70);
    addSolid(x, z, 0.7, 0.7);
  });
  // eyes in the walls
  [1, 2, 3].forEach((s, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawEyesTex(s + 7)), transparent: true, roughness: 1 }));
    m.position.set(53 + i * 3.6, 1.7, 14.02);
    worldGroup.add(m);
    const m2 = m.clone();
    m2.position.set(55 + i * 3.6, 1.7, 18.98);
    m2.rotation.y = Math.PI;
    worldGroup.add(m2);
  });
  // the elevator you came down in: its light only comes back once the room is quiet
  const won = !!state.flags.finaleWon;
  addBox(0.05, 2.3, 1.1, 50.04, 1.15, 16.5, won ? 0xc8d4c0 : 0x2a2c2e);
  const el = new THREE.PointLight(0xbfd8ff, won ? 1.4 : 0.15, 6, 2);
  el.position.set(50.8, 2.2, 16.5);
  worldGroup.add(el);
  // a table, a lamp, a note
  addBox(1.2, 0.7, 0.8, FINALE.lamp.x, 0.35, FINALE.lamp.z, 0x3a2a1c);
  addSolid(FINALE.lamp.x, FINALE.lamp.z, 1.2, 0.8);
  addBox(0.12, 0.3, 0.12, FINALE.lamp.x + 0.3, 0.85, FINALE.lamp.z - 0.1, 0x6a6a5a);
  addBox(0.2, 0.012, 0.28, FINALE.lamp.x - 0.2, 0.71, FINALE.lamp.z + 0.05, 0xd6cfb6);
  addBox(0.3, 0.4, 0.03, FINALE.lamp.x, 1.1, FINALE.lamp.z - 0.35, 0x2a2018); // a framed photograph
  const lamp = new THREE.PointLight(0xffb060, won ? 1.0 : 1.7, 8, 2);
  lamp.position.set(FINALE.lamp.x + 0.3, 1.2, FINALE.lamp.z);
  worldGroup.add(lamp);
  flickerLights.push({ light: lamp, base: won ? 1.0 : 1.7, phase: 0.7 });
}
function updateFinale(dt) {
  if (!finale || state.phase !== "explore" || state.transition) return;
  const p = yawObject.position;
  finale.t += dt;
  if (finale.mode === "arrive") {
    finale.mode = "lurk";
    finale.t = 0;
    return;
  }
  if (finale.mode === "lurk") {
    if (Math.hypot(p.x - FINALE.lamp.x, p.z - FINALE.lamp.z) < 4.6) {
      if (!finale.mesh) {
        finale.mesh = makeCreature(1.55);
        scene.add(finale.mesh);
      }
      finale.x = FINALE.boss.x; finale.z = FINALE.boss.z; finale.stare = 0; finale.frozen = 0; finale.path = null;
      finale.mesh.visible = true;
      finale.mode = "chase";
      finale.speed = 2.3;
      playScreech();
      playBang();
      scareBlackout = 0.9;
      doorShake = 0.5;
    }
    return;
  }
  const m = finale.mesh;
  if (finale.mode === "dying") {
    finale.die -= dt;
    m.visible = Math.random() > 0.3 && finale.die > 0;
    m.scale.y = Math.max(0.05, finale.die / 1.4);
    if (finale.die <= 0) {
      m.visible = false;
      finale.mode = "won";
      state.flags.finaleWon = true;
      playSting();
      buildWorld(); // the elevator lights up
      showMessage("The elevator hums.");
    }
    return;
  }
  if (finale.mode !== "chase") return;
  const dx = p.x - finale.x, dz = p.z - finale.z, d = Math.hypot(dx, dz);
  const lit = entityInBeam(finale);
  if (lit) finale.stare += dt;
  else finale.stare = Math.max(0, finale.stare - dt * 0.5);
  if (finale.stare >= ENTITY_STARE_LIMIT) {
    finale.mode = "dying";
    finale.die = 1.4;
    setTimeout(() => playVoice("exhale", 0.8, 1), 1500);
    m.scale.y = 1;
    return;
  }
  finale.speed = Math.min(3.3, finale.speed + dt * 0.03);
  m.rotation.y = Math.atan2(dx, dz);
  if (!lit) {
    finale.repath -= dt;
    if (finale.repath <= 0 || !finale.path) { finale.path = entityPath(finale.x, finale.z, p.x, p.z); finale.repath = 0.25; }
    let tx = p.x, tz = p.z;
    if (finale.path && finale.path.length > 1) {
      tx = finale.path[1][0] + 0.5; tz = finale.path[1][1] + 0.5;
      if (finale.path.length === 2 && d < 1.2 && hasLineOfSight(finale.x, finale.z, p.x, p.z)) { tx = p.x; tz = p.z; }
    }
    const mx = tx - finale.x, mz = tz - finale.z, md = Math.hypot(mx, mz);
    if (md > 0.02) {
      const s = Math.min(finale.speed * dt, md);
      entityStep(finale, (mx / md) * s, (mz / md) * s);
    }
    m.position.set(finale.x, 0, finale.z);
  } else {
    m.position.set(finale.x + (Math.random() - 0.5) * 0.03, 0, finale.z + (Math.random() - 0.5) * 0.03);
  }
  animateCreature(m.userData, finale.t, lit ? 0 : finale.speed, 0.8, lit);
  const near = Math.max(0, 1 - d / 8);
  entityTension = Math.max(entityTension, near);
  const v = document.getElementById("fear-vignette");
  setFear(Math.max(parseFloat(v.style.opacity) || 0, near * 0.8));
  if (!lit && d < 1.0) {
    // caught: back to the elevator, and it goes back to waiting
    playSting();
    m.visible = false;
    finale.mode = "lurk";
    finale.stare = 0;
    startTransition(FINALE.start);
  }
}
function startEnding() {
  state.phase = "ending";
  try { localStorage.removeItem("hollowhouse.save"); } catch (e) {}
  keys.clear();
  setFear(0);
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  const ov = document.getElementById("ending-overlay");
  // two endings: how much of John's story you pieced together decides which one you get
  const STORY_IDS = ["nSep2", "nSep3", "nSep9", "nSep14", "nSep25", "nOct1", "nOct3", "nOct4", "note5", "johnNote", "mazeNote0", "mazeNote1", "nestNote"];
  const found = STORY_IDS.filter((id) => state.inventory[id]).length;
  const knowsAll = found >= 8 && state.inventory.nestNote;
  const lines = knowsAll
    ? [
        "The elevator carries you up through the dark.",
        "You read every page he left. You know whose coat it wore.",
        "In the shaft something says your name, in his voice. Then it lets you go.",
        state.inventory.jPhoto ? "You set his photograph on the reception desk, where the lamp can find it." : "You set the lamp on the reception desk, where he can find it.",
        "The front door stands open. Morning is coming up grey on the street.",
        "You leave the light on for him.",
      ]
    : [
        "The elevator carries you up through the dark.",
        "The lobby is quiet. The front door stands open to the street.",
        "Behind you the shaft hums once, and then it is still.",
        "You came here looking for John. You never learn what he became.",
        "You walk out. You do not look back.",
      ];
  const box = document.getElementById("ending-lines");
  box.innerHTML = "";
  document.getElementById("ending-title").classList.add("hidden");
  document.getElementById("ending-stats").textContent = "";
  document.getElementById("ending-return").classList.add("hidden");
  ov.classList.remove("hidden");
  lines.forEach((t, i) => {
    setTimeout(() => {
      const p = document.createElement("p");
      p.textContent = t;
      box.appendChild(p);
    }, 800 + i * 3200);
  });
  setTimeout(() => {
    document.getElementById("ending-title").classList.remove("hidden");
    const kills = state.flags.huskKills || 0;
    document.getElementById("ending-stats").textContent = "Pages found: " + found + " / " + STORY_IDS.length + "   Husks destroyed: " + kills;
    document.getElementById("ending-return").classList.remove("hidden");
  }, 800 + lines.length * 3200 + 1200);
}
const endingReturnBtn = document.getElementById("ending-return");
if (endingReturnBtn) endingReturnBtn.addEventListener("click", () => {
  document.getElementById("ending-overlay").classList.add("hidden");
  resetRun();
  state.phase = "title";
  showScreen("screen-title");
});

// ---- the face behind apartment 2's door -------------------------------------------------------------
let faceScare = null;
function drawCreepyFace(c) {
  const S = (c.width = c.height = 512);
  const x = c.getContext("2d");
  x.fillStyle = "#000";
  x.fillRect(0, 0, S, S);
  // wild hair
  x.strokeStyle = "#050505";
  x.lineWidth = 3;
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * 6.3;
    x.beginPath();
    x.moveTo(256 + Math.cos(a) * 150, 256 + Math.sin(a) * 190);
    x.quadraticCurveTo(256 + Math.cos(a) * 230, 256 + Math.sin(a) * 260, 256 + Math.cos(a + 0.3) * 330, 256 + Math.sin(a + 0.3) * 330);
    x.stroke();
  }
  // the head
  const g = x.createRadialGradient(256, 230, 20, 256, 256, 260);
  g.addColorStop(0, "#e9e7dc");
  g.addColorStop(0.7, "#b9b8a8");
  g.addColorStop(1, "#4a4a44");
  x.fillStyle = g;
  x.beginPath();
  x.ellipse(256, 262, 150, 205, 0, 0, 6.3);
  x.fill();
  // cracks
  x.strokeStyle = "rgba(40,30,25,0.6)";
  x.lineWidth = 1.5;
  for (let i = 0; i < 14; i++) {
    let px = 140 + Math.random() * 230, py = 80 + Math.random() * 360;
    x.beginPath();
    x.moveTo(px, py);
    for (let j = 0; j < 5; j++) { px += (Math.random() - 0.5) * 30; py += Math.random() * 25; x.lineTo(px, py); }
    x.stroke();
  }
  // sunken eye sockets, one bigger than the other
  x.fillStyle = "#000";
  x.beginPath(); x.ellipse(195, 205, 48, 62, -0.25, 0, 6.3); x.fill();
  x.beginPath(); x.ellipse(325, 195, 40, 74, 0.2, 0, 6.3); x.fill();
  x.fillStyle = "#f4f2e6";
  x.beginPath(); x.arc(198, 212, 7, 0, 6.3); x.fill();
  x.beginPath(); x.arc(322, 200, 6, 0, 6.3); x.fill();
  // nose
  x.fillStyle = "#1a1612";
  x.beginPath(); x.ellipse(250, 285, 7, 16, 0.1, 0, 6.3); x.fill();
  x.beginPath(); x.ellipse(272, 287, 6, 14, -0.1, 0, 6.3); x.fill();
  // the grin, far too wide
  x.fillStyle = "#000";
  x.beginPath();
  x.moveTo(135, 330);
  x.quadraticCurveTo(256, 520, 385, 322);
  x.quadraticCurveTo(256, 380, 135, 330);
  x.fill();
  x.fillStyle = "#e8e6d4";
  for (let i = 0; i < 17; i++) {
    const t = i / 16;
    const px = 140 + t * 240;
    const py = 332 + Math.sin(t * Math.PI) * 78 - 6;
    x.beginPath();
    x.moveTo(px - 6, py - 4); x.lineTo(px, py + 20 + Math.random() * 12); x.lineTo(px + 6, py - 4);
    x.fill();
  }
  return c;
}
function playScreamMusic() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  // a music box, out of tune, that slows down
  const notes = [659, 622, 659, 622, 659, 494, 587, 523, 440];
  let tt = 0;
  notes.forEach((f, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.02);
    const st = t + tt;
    g.gain.setValueAtTime(0.0001, st);
    g.gain.linearRampToValueAtTime(0.14, st + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, st + 0.7);
    o.connect(g).connect(audioCtx.destination);
    o.start(st);
    o.stop(st + 0.75);
    tt += 0.26 + i * 0.03;
  });
  // low drone creeping in
  const d = audioCtx.createOscillator();
  const dg = audioCtx.createGain();
  d.type = "sawtooth";
  d.frequency.setValueAtTime(55, t);
  d.frequency.linearRampToValueAtTime(48, t + 2.4);
  dg.gain.setValueAtTime(0.0001, t);
  dg.gain.linearRampToValueAtTime(0.1, t + 2.3);
  dg.gain.setValueAtTime(0.0001, t + 2.4);
  d.connect(dg).connect(audioCtx.destination);
  d.start(t);
  d.stop(t + 2.5);
}
function playScreech() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime + 0.0;
  [880, 1175, 1480, 1865].forEach((f, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (i % 2 ? 1.8 : 0.5), t + 0.9);
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 1.05);
  });
  const n = audioCtx.createBufferSource();
  const ng = audioCtx.createGain();
  n.buffer = noiseBuf;
  n.loop = true;
  ng.gain.setValueAtTime(0.45, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
  n.connect(ng).connect(audioCtx.destination);
  n.start(t);
  n.stop(t + 0.85);
  playBang();
}
function startFaceScare() {
  if (faceScare) return;
  markScare();
  playScreamMusic();
  playVoice("gasp", 0.9, 1);
  faceScare = { t: 0, shown: false, el: null };
}
function updateFaceScare(dt) {
  const f = faceScare;
  if (!f) return;
  f.t += dt;
  const HIT = 2.5; // the music builds, then it hits
  if (!f.shown && f.t >= HIT) {
    f.shown = true;
    playScreech();
    try {
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:fixed;inset:0;z-index:9999;background:#000;display:flex;align-items:center;justify-content:center;pointer-events:none;overflow:hidden";
      const cv = document.createElement("canvas");
      cv.style.cssText = "height:100vh;max-width:100vw;object-fit:contain";
      drawCreepyFace(cv);
      wrap.appendChild(cv);
      document.body.appendChild(wrap);
      f.el = wrap;
      f.cv = cv;
    } catch (e) {}
  }
  if (f.shown) {
    const k = f.t - HIT;
    if (f.cv) {
      const s = 0.7 + Math.min(k / 0.25, 1) * 0.9 + k * 0.25;
      f.cv.style.transform = `translate(${(Math.random() - 0.5) * 30}px,${(Math.random() - 0.5) * 30}px) scale(${s})`;
      f.cv.style.filter = "contrast(1.4) saturate(0)";
      if (f.el) f.el.style.filter = Math.random() < 0.12 ? "invert(1)" : "none";
    }
    if (k > 0.85) {
      if (f.el && f.el.parentNode) f.el.parentNode.removeChild(f.el);
      faceScare = null;
    }
  }
}

// ---- walls and floors: wallpaper, wainscot, tile, wood, carpet, and things hanging on the walls --------------
function seededRng(seed) {
  let s = seed || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}
function makeWallTexture(style, seed) {
  const W = 128, H = 384;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  const r = seededRng(seed);
  const P = {
    hall: { base: "#38483f", pat: "#2e3c35", wain: "#2b1e17", rail: "#7a6642", kind: "stripe" },
    lobby: { base: "#6a5a44", pat: "#5a4c38", wain: "#3a2c20", rail: "#9a8458", kind: "stripe" },
    apt2: { base: "#6e6a3e", pat: "#5c5832", wain: null, kind: "diamond" },
    apt3: { base: "#523d50", pat: "#72506a", wain: "#2a2028", rail: "#8a6a7a", kind: "dots" },
    john: { base: "#3e1a1a", pat: "#150808", wain: "#1c0f0f", rail: "#4a2a2a", kind: "vines" },
    staff: { base: "#5c6a5e", pat: null, wain: "#38423b", rail: "#9aa49a", kind: "plain" },
  }[style];
  x.fillStyle = P.base;
  x.fillRect(0, 0, W, H);
  x.fillStyle = P.pat || P.base;
  if (P.kind === "stripe") {
    for (let i = 0; i < W; i += 16) x.fillRect(i, 0, 8, H);
  } else if (P.kind === "diamond") {
    for (let yy = 0; yy < H; yy += 32) for (let xx = 0; xx < W; xx += 32) {
      x.beginPath(); x.moveTo(xx + 16, yy + 4); x.lineTo(xx + 28, yy + 16); x.lineTo(xx + 16, yy + 28); x.lineTo(xx + 4, yy + 16); x.closePath(); x.fill();
    }
  } else if (P.kind === "dots") {
    for (let yy = 8; yy < H; yy += 24) for (let xx = (yy / 24) % 2 ? 8 : 20; xx < W; xx += 24) { x.beginPath(); x.arc(xx, yy, 4, 0, 6.3); x.fill(); x.fillRect(xx - 1, yy + 4, 2, 8); }
  } else if (P.kind === "vines") {
    x.strokeStyle = P.pat; x.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      x.beginPath();
      let px = 10 + i * 22;
      x.moveTo(px, 0);
      for (let yy = 0; yy < H; yy += 40) { px += (r() - 0.5) * 40; x.quadraticCurveTo(px + 20, yy + 20, px, yy + 40); }
      x.stroke();
    }
  }
  if (P.wain) { // wainscot: panelled wood on the lower third, a rail on top
    x.fillStyle = P.wain;
    x.fillRect(0, 252, W, H - 252);
    x.strokeStyle = "rgba(0,0,0,0.5)"; x.lineWidth = 2;
    x.strokeRect(10, 266, W - 20, 90);
    x.fillStyle = P.rail;
    x.fillRect(0, 248, W, 6);
  }
  x.fillStyle = "#120d0a"; // baseboard
  x.fillRect(0, H - 14, W, 14);
  // age: water stains, mold, peeling
  for (let i = 0; i < 6; i++) {
    const sx = r() * W, sw = 6 + r() * 18, sy = r() * 60, sh = 80 + r() * 160;
    const g = x.createLinearGradient(0, sy, 0, sy + sh);
    g.addColorStop(0, "rgba(25,18,8,0.4)"); g.addColorStop(1, "rgba(25,18,8,0)");
    x.fillStyle = g; x.fillRect(sx, sy, sw, sh);
  }
  for (let i = 0; i < 5; i++) { x.fillStyle = `rgba(20,45,25,${0.2 + r() * 0.2})`; x.beginPath(); x.arc(r() * W, H - 30 - r() * 40, 8 + r() * 14, 0, 6.3); x.fill(); }
  for (let i = 0; i < 2; i++) { const px = r() * 90, py = 20 + r() * 150; x.fillStyle = "rgba(190,175,140,0.35)"; x.fillRect(px, py, 18, 34); x.fillStyle = "rgba(0,0,0,0.35)"; x.fillRect(px + 16, py + 4, 3, 32); }
  const top = x.createLinearGradient(0, 0, 0, 50);
  top.addColorStop(0, "rgba(0,0,0,0.65)"); top.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = top; x.fillRect(0, 0, W, 50);
  if (style === "john") { // scratches
    x.strokeStyle = "rgba(120,20,20,0.6)"; x.lineWidth = 1.5;
    for (let i = 0; i < 4; i++) { const sx = 10 + r() * 100, sy = 90 + r() * 80; for (let k = 0; k < 4; k++) { x.beginPath(); x.moveTo(sx + k * 5, sy); x.lineTo(sx + k * 5 + 6, sy + 40); x.stroke(); } }
  }
  return c;
}
let wallMatCache = null;
function getWallMats() {
  if (wallMatCache) return wallMatCache;
  const mk = (style, seed) => {
    const t = new THREE.CanvasTexture(makeWallTexture(style, seed));
    return new THREE.MeshStandardMaterial({ map: t, bumpMap: t, bumpScale: 1.6, roughness: 0.92 });
  };
  wallMatCache = { f2a: mk("apt2", 71), f2b: mk("apt3", 73), f2c: mk("hall", 75), f2d: mk("john", 77), hall: mk("hall", 11), lobby: mk("lobby", 23), apt2: mk("apt2", 37), apt3: mk("apt3", 41), john: mk("john", 53), staff: mk("staff", 61) };
  return wallMatCache;
}
function aptStyleOfCol(col) {
  const W = getWallMats();
  if (col >= 5 && col <= 7) return W.apt2;
  if (col >= 9 && col <= 11) return W.apt3;
  if (col >= 13 && col <= 15) return W.john;
  return null;
}
// materials for the six faces of one wall block (+x, -x, +y, -y, +z south, -z north)
function wallMatsFor(col, row) {
  const W = getWallMats();
  if (col >= 21 && col < 46) {
    // second floor: each room has its own wall colour; the corridor is plain
    const room = (c, side) => F2_ROOMS.find((r) => r.side === side && c >= r.c0 && c < r.c0 + r.w);
    const m = (r) => (r ? W[r.wall] : W.hall);
    const h = W.hall;
    if (row === 0) return [h, h, h, h, m(room(col, "N")), h];
    if (row === 12) return [h, h, h, h, h, m(room(col, "S"))];
    if (row >= 1 && row <= 3) return [m(room(col + 1, "N")), m(room(col - 1, "N")), h, h, h, h];
    if (row === 4) return [h, h, h, h, h, m(room(col, "N"))];
    if (row === 8) return [h, h, h, h, m(room(col, "S")), h];
    if (row >= 9 && row <= 11) return [m(room(col + 1, "S")), m(room(col - 1, "S")), h, h, h, h];
    return h;
  }
  if (row === -1) return aptStyleOfCol(col) || W.hall;
  if (row <= 3) return [aptStyleOfCol(col + 1) || W.hall, aptStyleOfCol(col - 1) || W.hall, W.hall, W.hall, W.hall, W.hall];
  if (row === 4) return [W.hall, W.hall, W.hall, W.hall, W.hall, aptStyleOfCol(col) || W.hall];
  if (row <= 6) return col <= 4 ? W.staff : col === 5 ? [W.hall, W.staff, W.hall, W.hall, W.hall, W.hall] : W.hall;
  if (row === 7) return [W.hall, W.hall, W.hall, W.hall, W.lobby, col <= 5 ? W.staff : W.hall];
  if (row <= 12) return W.lobby;
  return W.hall;
}

function makeFloorTexture(kind, seed) {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  const r = seededRng(seed);
  if (kind === "tile") { // black and cream checker, cracked and filthy
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const dark = (i + j) % 2 === 0;
      const v = dark ? 30 + r() * 12 : 138 + r() * 22;
      x.fillStyle = `rgb(${v},${v - 3},${v - 12})`;
      x.fillRect(i * 64, j * 64, 64, 64);
    }
    x.strokeStyle = "#16130f"; x.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { x.beginPath(); x.moveTo(i * 64, 0); x.lineTo(i * 64, S); x.moveTo(0, i * 64); x.lineTo(S, i * 64); x.stroke(); }
    x.strokeStyle = "rgba(20,15,10,0.7)"; x.lineWidth = 1;
    for (let i = 0; i < 4; i++) { let px = r() * S, py = r() * S; x.beginPath(); x.moveTo(px, py); for (let k = 0; k < 5; k++) { px += (r() - 0.5) * 30; py += r() * 22; x.lineTo(px, py); } x.stroke(); }
  } else if (kind === "carpet") { // teal-grey carpet with a faint pattern
    x.fillStyle = "#3b5254"; x.fillRect(0, 0, S, S);
    x.fillStyle = "rgba(255,255,255,0.05)";
    for (let i = 0; i < S; i += 32) for (let j = 0; j < S; j += 32) { x.fillRect(i + 12, j, 8, 32); x.fillRect(i, j + 12, 32, 8); }
    for (let i = 0; i < 3000; i++) { const v = 40 + r() * 50; x.fillStyle = `rgba(${v},${v + 14},${v + 14},0.35)`; x.fillRect(r() * S, r() * S, 2, 2); }
  } else if (kind === "runner") { // red hall runner with a gold border
    x.fillStyle = "#5a1a1c"; x.fillRect(0, 0, S, S);
    x.fillStyle = "#8a6a2a"; x.fillRect(0, 10, S, 6); x.fillRect(0, S - 16, S, 6);
    x.fillStyle = "#7a2a2a";
    for (let i = 0; i < S; i += 64) { x.beginPath(); x.moveTo(i + 32, 60); x.lineTo(i + 56, 128); x.lineTo(i + 32, 196); x.lineTo(i + 8, 128); x.closePath(); x.fill(); }
    for (let i = 0; i < 2500; i++) { x.fillStyle = `rgba(0,0,0,${r() * 0.25})`; x.fillRect(r() * S, r() * S, 2, 2); }
  } else { // wood planks
    const dark = kind === "plankDark";
    const rows = 7, h = S / rows;
    for (let j = 0; j < rows; j++) {
      let px = -r() * 120;
      while (px < S) {
        const len = 110 + r() * 90;
        const v = (dark ? 36 : 76) + r() * 26;
        x.fillStyle = `rgb(${v + 16},${v + 4},${v - 10})`;
        x.fillRect(px, j * h, len, h);
        x.strokeStyle = "rgba(0,0,0,0.3)"; x.lineWidth = 1;
        for (let g = 0; g < 4; g++) { x.beginPath(); x.moveTo(px, j * h + r() * h); x.lineTo(px + len, j * h + r() * h); x.stroke(); }
        x.fillStyle = "#0e0a07"; x.fillRect(px, j * h, 2, h);
        px += len;
      }
      x.fillStyle = "#0e0a07"; x.fillRect(0, j * h, S, 2);
    }
    for (let i = 0; i < 4; i++) { x.fillStyle = "rgba(10,8,4,0.3)"; x.beginPath(); x.ellipse(r() * S, r() * S, 12 + r() * 24, 6 + r() * 12, r() * 3, 0, 6.3); x.fill(); }
  }
  return c;
}
const floorTexCache = {};
function floorPatch(kind, x0, z0, w, d, tile, y) {
  if (!floorTexCache[kind]) {
    const t = new THREE.CanvasTexture(makeFloorTexture(kind, kind.length * 13));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    floorTexCache[kind] = t;
  }
  const t = floorTexCache[kind].clone();
  t.repeat.set(w / tile, d / tile);
  t.needsUpdate = true;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: t, bumpMap: t, bumpScale: 1.2, roughness: 0.78 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x0 + w / 2, y || 0.004, z0 + d / 2);
  worldGroup.add(m);
}

// ---- original paintings inspired by the reference pictures (nothing here is a copy of them) ----
const NEWART = (() => {
  const mk = (W, H, f) => () => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    f(x, W, H);
    return c;
  };
  const ell = (x, cx, cy, rx, ry, col, rot) => { x.fillStyle = col; x.beginPath(); x.ellipse(cx, cy, rx, ry, rot || 0, 0, 6.3); x.fill(); };
  const vig = (x, W, H, a) => { const g = x.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.8); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${a})`); x.fillStyle = g; x.fillRect(0, 0, W, H); };
  const rng = (s) => () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const cracks = (x, r, cx, cy, n, col) => { x.strokeStyle = col; x.lineWidth = 1.3; for (let i = 0; i < n; i++) { let px = cx + (r() - 0.5) * 80, py = cy + (r() - 0.5) * 120; x.beginPath(); x.moveTo(px, py); for (let k = 0; k < 4; k++) { px += (r() - 0.5) * 22; py += r() * 18; x.lineTo(px, py); } x.stroke(); } };
  const drips = (x, r, xs, y0, col) => { x.strokeStyle = col; x.lineCap = "round"; xs.forEach((px) => { x.lineWidth = 2 + r() * 3; x.beginPath(); x.moveTo(px, y0); x.lineTo(px + (r() - 0.5) * 6, y0 + 25 + r() * 50); x.stroke(); }); };
  const glow = (x, cx, cy, rad, col) => { const g = x.createRadialGradient(cx, cy, 2, cx, cy, rad); g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.fillRect(cx - rad, cy - rad, rad * 2, rad * 2); };
  return {
    // a cracked mask-face in the dark, lit from below by one candle
    maskA: mk(256, 320, (x, W, H) => {
      const r = rng(3); x.fillStyle = "#050505"; x.fillRect(0, 0, W, H);
      x.fillStyle = "#6a6a66"; x.beginPath(); x.moveTo(30, H); x.lineTo(70, 215); x.lineTo(186, 215); x.lineTo(226, H); x.fill();
      x.fillStyle = "#0e0e0e"; x.beginPath(); x.moveTo(104, 215); x.lineTo(152, 215); x.lineTo(128, 300); x.fill();
      ell(x, 128, 130, 62, 84, "#9a968a");
      cracks(x, r, 128, 120, 14, "rgba(20,16,12,0.7)");
      ell(x, 98, 108, 22, 30, "#060606"); ell(x, 160, 108, 22, 30, "#060606");
      drips(x, r, [92, 100, 156, 164], 128, "#0a0808");
      ell(x, 128, 150, 9, 13, "#2a2622");
      x.strokeStyle = "#0a0808"; x.lineWidth = 4; x.beginPath(); x.moveTo(94, 190); x.quadraticCurveTo(128, 208, 162, 188); x.stroke();
      drips(x, r, [110, 128, 146], 196, "#0a0808");
      glow(x, 128, 298, 150, "rgba(255,190,90,0.55)");
      ell(x, 128, 296, 5, 11, "#fff2c0");
      vig(x, W, H, 0.7);
    }),
    // a hatted figure, one eye pit and a long stitched smile, in blue moonlight
    maskB: mk(256, 320, (x, W, H) => {
      const r = rng(5); const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#10182a"); g.addColorStop(1, "#05070c"); x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.fillStyle = "#07080c"; x.fillRect(40, 232, 176, 100); x.fillStyle = "#b8bcc0"; x.fillRect(110, 232, 36, 40);
      x.fillStyle = "#0a0a0e"; x.fillRect(70, 40, 116, 70); x.fillRect(46, 104, 164, 14);
      ell(x, 128, 160, 52, 66, "#a8aeb0");
      cracks(x, r, 128, 150, 9, "rgba(10,12,16,0.6)");
      ell(x, 106, 150, 14, 18, "#050608"); ell(x, 152, 150, 5, 5, "#e8ecef");
      x.strokeStyle = "#050608"; x.lineWidth = 3; x.beginPath(); x.moveTo(78, 186); x.quadraticCurveTo(128, 232, 180, 184); x.stroke();
      for (let i = 0; i < 12; i++) { const px = 84 + i * 8; x.beginPath(); x.moveTo(px, 186 + Math.sin(i / 11 * 3.1) * 28 - 6); x.lineTo(px, 186 + Math.sin(i / 11 * 3.1) * 28 + 8); x.stroke(); }
      vig(x, W, H, 0.65);
    }),
    // a flat-headed stitched fellow with bolts, standing in a purple room
    stitched: mk(256, 320, (x, W, H) => {
      const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#1c0a3a"); g.addColorStop(0.6, "#4a1a7a"); g.addColorStop(1, "#b030d8"); x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.fillStyle = "rgba(20,0,30,0.4)"; x.beginPath(); x.ellipse(128, 296, 50, 8, 0, 0, 6.3); x.fill();
      x.fillStyle = "#1a1418"; x.fillRect(114, 190, 8, 96); x.fillRect(136, 190, 8, 96); x.fillStyle = "#3a2418"; x.fillRect(108, 284, 18, 12); x.fillRect(134, 284, 18, 12);
      x.fillStyle = "#5a3a2a"; x.beginPath(); x.moveTo(82, 150); x.lineTo(176, 150); x.lineTo(170, 205); x.lineTo(88, 205); x.fill();
      x.fillStyle = "#a89ab0"; x.fillRect(100, 160, 56, 40);
      x.fillStyle = "#6a9a3a"; x.fillRect(64, 160, 8, 62); x.fillRect(184, 160, 8, 62);
      x.fillStyle = "#5a8a32"; x.beginPath(); x.moveTo(94, 40); x.lineTo(162, 40); x.lineTo(170, 150); x.quadraticCurveTo(128, 170, 86, 150); x.fill();
      x.fillStyle = "#8a8a94"; x.fillRect(74, 92, 14, 10); x.fillRect(168, 92, 14, 10);
      ell(x, 112, 90, 9, 8, "#f0d8d8"); ell(x, 146, 90, 9, 8, "#f0d8d8"); ell(x, 114, 91, 3, 3, "#201018"); ell(x, 144, 91, 3, 3, "#201018");
      x.strokeStyle = "#2a4a18"; x.lineWidth = 4; x.beginPath(); x.moveTo(112, 80); x.lineTo(124, 76); x.moveTo(146, 80); x.lineTo(134, 76); x.stroke();
      x.lineWidth = 3; x.beginPath(); x.moveTo(110, 130); x.quadraticCurveTo(128, 120, 148, 130); x.stroke();
    }),
    // the same sort of face, but the eyes have been crossed out and the mouth sewn shut
    stitchedB: mk(256, 320, (x, W, H) => {
      const r = rng(9); x.fillStyle = "#08040c"; x.fillRect(0, 0, W, H);
      x.fillStyle = "#4e7430"; x.beginPath(); x.moveTo(60, 50); x.lineTo(196, 50); x.lineTo(204, 250); x.quadraticCurveTo(128, 300, 52, 250); x.fill();
      x.fillStyle = "#7a7a84"; x.fillRect(32, 130, 28, 16); x.fillRect(196, 130, 28, 16);
      ell(x, 98, 120, 18, 14, "#e8d0d0"); ell(x, 160, 120, 18, 14, "#e8d0d0");
      x.strokeStyle = "#8a0e0e"; x.lineWidth = 6; [[98, 120], [160, 120]].forEach(([px, py]) => { x.beginPath(); x.moveTo(px - 20, py - 18); x.lineTo(px + 20, py + 18); x.moveTo(px + 20, py - 18); x.lineTo(px - 20, py + 18); x.stroke(); });
      x.strokeStyle = "#101010"; x.lineWidth = 3; x.beginPath(); x.moveTo(84, 200); x.quadraticCurveTo(128, 190, 176, 200); x.stroke();
      for (let i = 0; i < 9; i++) { x.beginPath(); x.moveTo(88 + i * 10, 190); x.lineTo(90 + i * 10, 212); x.stroke(); }
      cracks(x, r, 128, 160, 6, "rgba(10,20,5,0.6)"); vig(x, W, H, 0.7);
    }),
    // a skull with bulging eyes and blood running down, red glow behind it
    skull: mk(256, 320, (x, W, H) => {
      const r = rng(11); const g = x.createRadialGradient(128, 160, 20, 128, 160, 220); g.addColorStop(0, "#7a0a0a"); g.addColorStop(1, "#080000"); x.fillStyle = g; x.fillRect(0, 0, W, H);
      ell(x, 128, 120, 88, 96, "#d8cfae"); x.fillStyle = "#d8cfae"; x.fillRect(70, 150, 116, 90);
      ell(x, 92, 140, 30, 26, "#2a1a14"); ell(x, 164, 140, 30, 26, "#2a1a14");
      ell(x, 92, 138, 22, 22, "#f4f0e8"); ell(x, 164, 138, 22, 22, "#f4f0e8"); ell(x, 94, 140, 10, 10, "#40403a"); ell(x, 162, 140, 10, 10, "#40403a");
      ell(x, 128, 185, 10, 18, "#3a2218");
      x.fillStyle = "#f0ead4"; for (let i = 0; i < 8; i++) x.fillRect(86 + i * 12, 224, 10, 16);
      for (let i = 0; i < 8; i++) x.fillRect(86 + i * 12, 242, 10, 14);
      x.strokeStyle = "#7a0606"; x.lineCap = "round";
      [[100, 40, 70], [150, 30, 140], [126, 50, 100], [80, 150, 90], [176, 150, 80]].forEach(([px, py, len]) => { x.lineWidth = 4 + r() * 3; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (r() - 0.5) * 14, py + len); x.stroke(); });
      vig(x, W, H, 0.55);
    }),
    // a skull wearing a crown of dead flowers, on old paper
    skullB: mk(256, 320, (x, W, H) => {
      const r = rng(13); x.fillStyle = "#cfc2a0"; x.fillRect(0, 0, W, H); for (let i = 0; i < 30; i++) ell(x, r() * W, r() * H, 20 + r() * 30, 14, `rgba(120,90,50,${0.05 + r() * 0.08})`);
      ell(x, 128, 170, 66, 72, "#e8e0c8"); x.fillStyle = "#e8e0c8"; x.fillRect(84, 200, 88, 60);
      ell(x, 104, 176, 18, 20, "#1a1410"); ell(x, 152, 176, 18, 20, "#1a1410"); ell(x, 128, 210, 6, 11, "#3a2e22");
      x.fillStyle = "#2a2018"; for (let i = 0; i < 7; i++) x.fillRect(96 + i * 10, 244, 7, 14);
      for (let i = 0; i < 11; i++) { const a = 3.3 + i * 0.28; const px = 128 + Math.cos(a) * 62, py = 150 + Math.sin(a) * 58; ell(x, px, py, 11, 11, ["#6a4a3a", "#8a7a6a", "#5a2a2a", "#7a7a52"][i % 4]); ell(x, px, py, 4, 4, "#2a1a10"); }
      vig(x, W, H, 0.35);
    }),
    // an ink-drawn pale head: ringed eyes, a huge black grin full of fine teeth
    grin: mk(256, 320, (x, W, H) => {
      const r = rng(17); x.fillStyle = "#6a6a68"; x.fillRect(0, 0, W, H); x.fillStyle = "#4a4a48"; x.fillRect(0, 230, W, 90);
      x.strokeStyle = "#101010"; x.lineWidth = 1.4; for (let i = 0; i < 70; i++) { const a = r() * 6.3; x.beginPath(); x.moveTo(128 + Math.cos(a) * 80, 120 + Math.sin(a) * 90); x.quadraticCurveTo(128 + Math.cos(a) * 110, 120 + Math.sin(a) * 140, 128 + Math.cos(a + 0.2) * 120, 120 + Math.sin(a + 0.2) * 150); x.stroke(); }
      x.fillStyle = "#101010"; x.fillRect(122, 200, 12, 130);
      ell(x, 128, 120, 84, 96, "#c8c8c0"); x.fillStyle = "rgba(0,0,0,0.12)"; x.beginPath(); x.ellipse(110, 110, 30, 70, 0.2, 0, 6.3); x.fill();
      [[88, 100], [168, 100]].forEach(([px, py]) => { ell(x, px, py, 28, 28, "#101010"); ell(x, px, py, 22, 22, "#f2f2ec"); ell(x, px, py + 2, 4, 4, "#101010"); });
      ell(x, 128, 132, 6, 12, "#7a7a74");
      x.fillStyle = "#050505"; x.beginPath(); x.moveTo(60, 160); x.quadraticCurveTo(128, 300, 196, 158); x.quadraticCurveTo(128, 190, 60, 160); x.fill();
      x.strokeStyle = "#6a6a64"; x.lineWidth = 1; for (let i = 0; i < 30; i++) { const px = 74 + i * 3.8; x.beginPath(); x.moveTo(px, 185 + Math.sin(i / 29 * 3.1) * 22); x.lineTo(px, 205 + Math.sin(i / 29 * 3.1) * 22); x.stroke(); }
      vig(x, W, H, 0.5);
    }),
    // a child's crayon version of it
    grinB: mk(256, 320, (x, W, H) => {
      const r = rng(19); x.fillStyle = "#ece6d0"; x.fillRect(0, 0, W, H);
      x.lineCap = "round"; x.strokeStyle = "#1a1a1a"; x.lineWidth = 6; x.beginPath(); x.arc(128, 130, 78, 0, 6.3); x.stroke();
      [[96, 110], [160, 110]].forEach(([px, py]) => { x.lineWidth = 5; x.beginPath(); x.arc(px, py, 22, 0, 6.3); x.stroke(); ell(x, px, py, 5, 5, "#1a1a1a"); });
      x.fillStyle = "#1a1a1a"; x.beginPath(); x.moveTo(70, 160); x.quadraticCurveTo(128, 250, 186, 158); x.quadraticCurveTo(128, 180, 70, 160); x.fill();
      x.strokeStyle = "#ece6d0"; x.lineWidth = 3; for (let i = 0; i < 8; i++) { x.beginPath(); x.moveTo(84 + i * 12, 170); x.lineTo(90 + i * 12, 186); x.lineTo(96 + i * 12, 170); x.stroke(); }
      x.strokeStyle = "#c82a20"; x.lineWidth = 5; x.beginPath(); x.moveTo(128, 210); x.lineTo(128, 290); x.moveTo(90, 240); x.lineTo(166, 240); x.stroke();
      x.strokeStyle = "rgba(0,0,0,0.5)"; x.lineWidth = 2; for (let i = 0; i < 14; i++) { x.beginPath(); x.moveTo(r() * W, 300 + r() * 10); x.lineTo(r() * W, 314); x.stroke(); }
    }),
    // a horned, grinning thing in a red hat and white beard, with a mouth full of needles
    krampus: mk(320, 220, (x, W, H) => {
      const r = rng(23); const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#080c14"); g.addColorStop(1, "#1a2230"); x.fillStyle = g; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 9; i++) { x.fillStyle = "#04060a"; x.fillRect(r() * W, 0, 6 + r() * 10, H); }
      x.fillStyle = "#c8d0d8"; for (let i = 0; i < 70; i++) x.fillRect(r() * W, r() * H, 2, 2);
      x.fillStyle = "#a01818"; x.beginPath(); x.moveTo(40, H); x.lineTo(70, 160); x.lineTo(250, 160); x.lineTo(280, H); x.fill();
      x.fillStyle = "#c6c2b8"; x.beginPath(); x.ellipse(160, 160, 80, 26, 0, 0, 6.3); x.fill();
      x.strokeStyle = "#8a7a30"; x.lineWidth = 9; x.lineCap = "round"; x.beginPath(); x.moveTo(104, 60); x.quadraticCurveTo(70, 40, 84, 6); x.moveTo(216, 60); x.quadraticCurveTo(250, 40, 236, 6); x.stroke();
      x.fillStyle = "#b8b4aa"; x.beginPath(); x.moveTo(104, 80); x.quadraticCurveTo(160, 190, 216, 80); x.quadraticCurveTo(160, 40, 104, 80); x.fill();
      x.fillStyle = "#a01818"; x.beginPath(); x.moveTo(110, 66); x.quadraticCurveTo(160, 0, 214, 62); x.lineTo(190, 70); x.quadraticCurveTo(160, 58, 128, 72); x.fill();
      ell(x, 206, 14, 10, 10, "#e8e4dc");
      [[134, 82], [186, 82]].forEach(([px, py]) => { ell(x, px, py, 11, 11, "#f0eee8"); ell(x, px, py, 7, 7, "#d01010"); ell(x, px, py, 3, 3, "#200000"); });
      x.fillStyle = "#1a0606"; x.beginPath(); x.ellipse(160, 128, 36, 30, 0, 0, 6.3); x.fill();
      x.fillStyle = "#f0ecdc"; for (let i = 0; i < 14; i++) { const a = i / 13 * 3.14; x.fillRect(126 + i * 5, 104 + Math.sin(a) * -2, 2.2, 20); x.fillRect(126 + i * 5, 138 + Math.sin(a) * 4, 2.2, -18); }
      ell(x, 160, 140, 12, 8, "#c0506a");
      vig(x, W, H, 0.5);
    }),
    // only the red eyes and the horns, out in the trees
    krampusB: mk(320, 220, (x, W, H) => {
      const r = rng(29); x.fillStyle = "#020304"; x.fillRect(0, 0, W, H);
      x.fillStyle = "#14181e"; x.fillRect(0, 170, W, 50); x.fillStyle = "#c8d0d8"; for (let i = 0; i < 50; i++) x.fillRect(r() * W, 172 + r() * 46, 2, 1);
      x.fillStyle = "#06080a"; for (let i = 0; i < 12; i++) { const px = r() * W; x.beginPath(); x.moveTo(px, 172); x.lineTo(px + 8, 172); x.lineTo(px + 4, 40 + r() * 60); x.fill(); }
      x.strokeStyle = "#0a0a0a"; x.lineWidth = 8; x.lineCap = "round"; x.beginPath(); x.moveTo(140, 100); x.quadraticCurveTo(116, 90, 124, 50); x.moveTo(184, 100); x.quadraticCurveTo(208, 90, 200, 50); x.stroke();
      x.fillStyle = "#050606"; x.beginPath(); x.ellipse(162, 130, 38, 52, 0, 0, 6.3); x.fill();
      [[150, 112], [176, 112]].forEach(([px, py]) => { glow(x, px, py, 24, "rgba(255,20,10,0.5)"); ell(x, px, py, 5, 5, "#ff3020"); });
      vig(x, W, H, 0.6);
    }),
    flowers: mk(256, 320, (x, W, H) => {
      const r = rng(31); x.fillStyle = "#b89a5a"; x.fillRect(0, 0, W, H); x.fillStyle = "#6a4a3a"; x.fillRect(0, 240, W, 80);
      x.fillStyle = "#3a5a6a"; x.beginPath(); x.moveTo(92, 250); x.lineTo(164, 250); x.lineTo(150, 170); x.lineTo(106, 170); x.fill();
      x.strokeStyle = "#4a5a28"; x.lineWidth = 3;
      [[0.2, "#a8402a"], [0.4, "#7a2a6a"], [0.55, "#c89a2a"], [0.75, "#4a1a1a"], [0.9, "#8a8a7a"]].forEach(([t, col], i) => { const fx = 60 + t * 140, fy = 50 + r() * 60 + i * 8; x.beginPath(); x.moveTo(128, 172); x.quadraticCurveTo(128, 120, fx, fy); x.stroke(); ell(x, fx, fy, 15, 13, col); ell(x, fx, fy, 5, 5, "#201008"); });
      for (let i = 0; i < 5; i++) ell(x, 60 + r() * 140, 262 + r() * 20, 5, 3, "#5a3a22");
      vig(x, W, H, 0.4);
    }),
    // a porcelain doll with one eye gone
    doll: mk(256, 320, (x, W, H) => {
      const r = rng(37); x.fillStyle = "#8a6a6a"; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 24; i++) { x.strokeStyle = "#3a2418"; x.lineWidth = 4; x.beginPath(); const a = 3.3 + i * 0.14; x.moveTo(128 + Math.cos(a) * 62, 140 + Math.sin(a) * 70); x.quadraticCurveTo(128 + Math.cos(a) * 92, 160 + i * 4, 128 + Math.cos(a) * 80, 250); x.stroke(); }
      x.fillStyle = "#e8e0d0"; x.beginPath(); x.moveTo(60, H); x.lineTo(80, 250); x.lineTo(176, 250); x.lineTo(196, H); x.fill();
      ell(x, 128, 140, 56, 70, "#ecdcc8"); ell(x, 98, 170, 14, 9, "rgba(200,80,80,0.5)"); ell(x, 160, 170, 14, 9, "rgba(200,80,80,0.5)");
      ell(x, 106, 128, 15, 11, "#f8f4ec"); ell(x, 106, 128, 6, 6, "#2a4a8a"); ell(x, 152, 128, 14, 12, "#080404");
      x.strokeStyle = "#8a2a2a"; x.lineWidth = 3; x.beginPath(); x.moveTo(112, 196); x.quadraticCurveTo(128, 206, 144, 196); x.stroke();
      x.strokeStyle = "#3a2a22"; x.lineWidth = 1.4; x.beginPath(); x.moveTo(150, 70); x.lineTo(142, 110); x.lineTo(158, 150); x.lineTo(150, 190); x.stroke(); vig(x, W, H, 0.5);
    }),
    // a house standing in black water, one lit window, someone in it
    house: mk(320, 220, (x, W, H) => {
      const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#20283a"); g.addColorStop(0.55, "#58607a"); g.addColorStop(0.56, "#101418"); g.addColorStop(1, "#04060a"); x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.fillStyle = "#0c0e12"; x.fillRect(110, 80, 100, 70); x.beginPath(); x.moveTo(100, 82); x.lineTo(160, 40); x.lineTo(220, 82); x.fill();
      x.fillStyle = "#e8b850"; x.fillRect(146, 98, 26, 24); x.fillStyle = "#0a0a0a"; x.fillRect(156, 106, 6, 16); ell(x, 159, 103, 4, 4, "#0a0a0a");
      x.fillStyle = "rgba(232,184,80,0.2)"; x.fillRect(146, 152, 26, 60);
      x.strokeStyle = "rgba(200,210,230,0.15)"; for (let i = 0; i < 8; i++) { x.beginPath(); x.moveTo(40 + i * 36, 160 + i % 3 * 12); x.lineTo(70 + i * 36, 160 + i % 3 * 12); x.stroke(); }
      vig(x, W, H, 0.5);
    }),
    handprints: mk(256, 320, (x, W, H) => {
      const r = rng(41); x.fillStyle = "#d8d0bc"; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 16; i++) { const px = 30 + r() * 196, py = 30 + r() * 250, s = 0.7 + r() * 0.7, a = (r() - 0.5) * 0.8; x.save(); x.translate(px, py); x.rotate(a); x.scale(s, s); x.fillStyle = `rgba(${110 + r() * 40},10,10,0.85)`; x.beginPath(); x.ellipse(0, 0, 14, 17, 0, 0, 6.3); x.fill(); for (let f = 0; f < 4; f++) x.fillRect(-13 + f * 8, -34 + (f === 1 || f === 2 ? -4 : 0), 6, 22); x.fillRect(12, -10, 18, 6); x.restore(); }
      vig(x, W, H, 0.3);
    }),
    // a long corridor with something tall at the far end
    figure: mk(256, 320, (x, W, H) => {
      const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#1a1a14"); g.addColorStop(1, "#06060a"); x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.fillStyle = "#2a281e"; x.beginPath(); x.moveTo(0, 0); x.lineTo(96, 110); x.lineTo(96, 210); x.lineTo(0, H); x.fill(); x.beginPath(); x.moveTo(W, 0); x.lineTo(160, 110); x.lineTo(160, 210); x.lineTo(W, H); x.fill();
      x.fillStyle = "#8a7a50"; x.fillRect(96, 110, 64, 100); glow(x, 128, 160, 90, "rgba(255,230,150,0.4)");
      x.fillStyle = "#040404"; x.fillRect(122, 120, 12, 76); ell(x, 128, 118, 7, 9, "#040404"); x.fillRect(116, 130, 4, 50); x.fillRect(136, 130, 4, 52);
      vig(x, W, H, 0.6);
    }),
    // stairs going down into nothing, a pale hand on the rail
    stairs: mk(256, 320, (x, W, H) => {
      x.fillStyle = "#06060a"; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 9; i++) { const y = 60 + i * 28, w = 200 - i * 18; x.fillStyle = `rgb(${70 - i * 6},${58 - i * 5},${44 - i * 4})`; x.fillRect(128 - w / 2, y, w, 24); x.fillStyle = "rgba(0,0,0,0.5)"; x.fillRect(128 - w / 2, y + 24, w, 4); }
      x.fillStyle = "#050507"; x.fillRect(0, 200, W, 120);
      x.strokeStyle = "#2a2018"; x.lineWidth = 6; x.beginPath(); x.moveTo(24, 80); x.lineTo(70, 240); x.stroke();
      x.fillStyle = "#d8d0c0"; x.fillRect(46, 160, 12, 6); for (let f = 0; f < 4; f++) x.fillRect(44 + f * 4, 150, 3, 12);
      vig(x, W, H, 0.6);
    }),
  };
})();
function drawArt(kind, seed) {
  if (NEWART[kind]) return NEWART[kind]();
  const r = seededRng(seed);
  const c = document.createElement("canvas");
  const wide = kind === "landscape";
  const W = (c.width = wide ? 320 : kind === "clock" ? 200 : 256);
  const H = (c.height = wide ? 220 : kind === "clock" ? 200 : 320);
  const x = c.getContext("2d");
  if (kind === "portrait") {
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#2a2018"); g.addColorStop(1, "#0e0a08");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = "#1a1210"; x.beginPath(); x.ellipse(128, 130, 74, 96, 0, 0, 6.3); x.fill(); // hair
    x.fillStyle = "#cbbf9f"; x.beginPath(); x.ellipse(128, 140, 50, 70, 0, 0, 6.3); x.fill(); // face
    x.fillStyle = "#050404"; x.beginPath(); x.ellipse(108, 128, 11, 15, 0, 0, 6.3); x.fill(); x.beginPath(); x.ellipse(148, 128, 11, 15, 0, 0, 6.3); x.fill(); // empty eyes
    x.strokeStyle = "#3a1a14"; x.lineWidth = 3; x.beginPath(); x.moveTo(98, 176); x.quadraticCurveTo(128, 200, 158, 176); x.stroke();
    x.fillStyle = "#1a1612"; x.fillRect(60, 232, 136, 90);
    x.strokeStyle = "rgba(0,0,0,0.5)"; x.lineWidth = 1; for (let i = 0; i < 20; i++) { x.beginPath(); x.moveTo(r() * W, r() * H); x.lineTo(r() * W, r() * H); x.stroke(); }
  } else if (kind === "landscape") {
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#2a2048"); g.addColorStop(0.6, "#8a4a38"); g.addColorStop(1, "#1a1a20");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = "#101418"; x.fillRect(0, 150, W, 70);
    for (let i = 0; i < 14; i++) { const px = r() * W, hh = 40 + r() * 60; x.fillStyle = "#0a0e0c"; x.beginPath(); x.moveTo(px - 14, 150); x.lineTo(px, 150 - hh); x.lineTo(px + 14, 150); x.fill(); }
    x.fillStyle = "#d8d4c8"; x.fillRect(214, 128, 3, 22); x.beginPath(); x.arc(215.5, 125, 3, 0, 6.3); x.fill(); // someone standing there
  } else if (kind === "family") {
    x.fillStyle = "#cfc6a8"; x.fillRect(0, 0, W, H);
    x.fillStyle = "#6a5a3e"; x.fillRect(14, 14, W - 28, H - 28);
    [[80, 150, 1], [128, 140, 1.1], [176, 170, 0.7]].forEach(([px, py, s], i) => {
      x.fillStyle = "#2a2018"; x.beginPath(); x.ellipse(px, py + 70 * s, 30 * s, 60 * s, 0, 0, 6.3); x.fill();
      x.fillStyle = "#b8a98a"; x.beginPath(); x.arc(px, py, 20 * s, 0, 6.3); x.fill();
      if (i === 1) { x.strokeStyle = "#1a0606"; x.lineWidth = 5; for (let k = 0; k < 14; k++) { x.beginPath(); x.moveTo(px - 24 + r() * 48, py - 24 + r() * 48); x.lineTo(px - 24 + r() * 48, py - 24 + r() * 48); x.stroke(); } }
    });
  } else if (kind === "child") {
    x.fillStyle = "#e0d8bc"; x.fillRect(0, 0, W, H);
    x.lineWidth = 4;
    x.strokeStyle = "#c8a020"; x.beginPath(); x.arc(210, 50, 22, 0, 6.3); x.stroke();
    x.strokeStyle = "#a03020"; x.strokeRect(30, 150, 80, 60); x.beginPath(); x.moveTo(24, 150); x.lineTo(70, 110); x.lineTo(116, 150); x.stroke();
    x.strokeStyle = "#2060a0";
    [[60, 250], [100, 250], [140, 260]].forEach(([px, py]) => { x.beginPath(); x.arc(px, py - 30, 9, 0, 6.3); x.moveTo(px, py - 21); x.lineTo(px, py + 10); x.moveTo(px - 12, py - 6); x.lineTo(px + 12, py - 6); x.moveTo(px, py + 10); x.lineTo(px - 8, py + 26); x.moveTo(px, py + 10); x.lineTo(px + 8, py + 26); x.stroke(); });
    x.strokeStyle = "#0a0a0a"; x.lineWidth = 6; // the tall black one standing behind them
    x.beginPath(); x.moveTo(210, 90); x.lineTo(210, 230); x.moveTo(210, 120); x.lineTo(160, 200); x.moveTo(210, 120); x.lineTo(250, 210); x.stroke();
    x.beginPath(); x.arc(210, 76, 14, 0, 6.3); x.stroke();
    x.strokeStyle = "#0a0a0a"; x.lineWidth = 2; for (let i = 0; i < 40; i++) { x.beginPath(); x.moveTo(190 + r() * 40, 62 + r() * 28); x.lineTo(190 + r() * 40, 62 + r() * 28); x.stroke(); }
  } else if (kind === "eyes") {
    x.fillStyle = "#050505"; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 26; i++) {
      const px = 20 + r() * 216, py = 20 + r() * 280, s = 0.6 + r() * 1.1;
      x.fillStyle = "#e6e2cc"; x.beginPath(); x.ellipse(px, py, 20 * s, 10 * s, 0, 0, 6.3); x.fill();
      x.fillStyle = "#050505"; x.beginPath(); x.arc(px + (r() - 0.5) * 8, py, 6 * s, 0, 6.3); x.fill();
    }
  } else if (kind === "mirror") {
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#1c2024"); g.addColorStop(1, "#080a0c");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = "rgba(210,215,225,0.1)"; x.beginPath(); x.ellipse(170, 150, 22, 34, 0, 0, 6.3); x.fill(); x.fillRect(150, 180, 40, 140); // someone standing behind you
    x.strokeStyle = "rgba(200,200,210,0.25)"; x.lineWidth = 1;
    for (let i = 0; i < 3; i++) { let px = r() * W, py = r() * 80; x.beginPath(); x.moveTo(px, py); for (let k = 0; k < 6; k++) { px += (r() - 0.5) * 40; py += 40; x.lineTo(px, py); } x.stroke(); }
  } else if (kind === "clock") {
    x.fillStyle = "#d8d2bc"; x.beginPath(); x.arc(100, 100, 92, 0, 6.3); x.fill();
    x.strokeStyle = "#1a1612"; x.lineWidth = 4; x.stroke();
    for (let i = 0; i < 12; i++) { const a = i * 0.5236; x.beginPath(); x.moveTo(100 + Math.sin(a) * 78, 100 - Math.cos(a) * 78); x.lineTo(100 + Math.sin(a) * 88, 100 - Math.cos(a) * 88); x.stroke(); }
    x.lineWidth = 6; x.beginPath(); x.moveTo(100, 100); x.lineTo(100, 38); x.stroke(); // stuck at 12
    x.beginPath(); x.moveTo(100, 100); x.lineTo(100, 28); x.stroke();
  }
  return c;
}
function addArt(kind, x, y, z, rot, h, seed, tilt) {
  const cv = drawArt(kind, seed);
  const w = h * (cv.width / cv.height);
  const nx = Math.sin(rot), nz = Math.cos(rot);
  const G = new THREE.Group();
  G.position.set(x + nx * 0.02, y, z + nz * 0.02);
  G.rotation.y = rot;
  G.rotation.z = tilt || 0;
  worldGroup.add(G);
  const frameCol = kind === "mirror" ? 0x7a7a74 : kind === "family" ? 0x1a1410 : 0x3a2a1a;
  const fr = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.03), new THREE.MeshStandardMaterial({ color: frameCol, roughness: 0.8 }));
  G.add(fr);
  const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cv), roughness: kind === "mirror" ? 0.2 : 1 }));
  pic.position.z = 0.017;
  G.add(pic);
}
function addWallDecor() {
  const P = Math.PI;
  // every picture is different: no kind is hung twice
  // hallway (north wall faces south; south wall faces north)
  addArt("maskA", 8.5, 1.65, 5.0, 0, 0.7, 1);
  addArt("house", 12.5, 1.6, 5.0, 0, 0.45, 2, 0.04);
  addArt("family", 16.5, 1.6, 5.0, 0, 0.6, 7);
  addArt("eyes", 11.0, 1.6, 7.0, P, 0.7, 8);
  addArt("clock", 14.2, 2.0, 7.0, P, 0.35, 9);
  addArt("mirror", 17.2, 1.6, 7.0, P, 0.75, 10);
  addArt("stitched", 6.0, 1.65, 6.0, P / 2, 0.65, 12, -0.05);
  // lobby (it runs from z 8 to z 13)
  addArt("krampus", 6.0, 1.7, 8.0, 0, 0.5, 14);
  addArt("skull", 14.5, 1.7, 8.0, 0, 0.8, 15);
  addArt("portrait", 17.5, 1.7, 8.0, 0, 0.6, 16, 0.05);
  addArt("grin", 1.0, 1.7, 9.2, P / 2, 0.7, 17);
  addArt("doll", 1.0, 1.7, 11.2, P / 2, 0.6, 18);
  addArt("maskB", 3.0, 1.7, 13.0, P, 0.7, 19);
  addArt("krampusB", 12.0, 1.7, 13.0, P, 0.5, 20);
  // apartment 2 (olive)
  addArt("child", 7.95, 1.6, 3.0, -P / 2, 0.45, 22);
  addArt("figure", 5.0, 1.9, 3.2, P / 2, 0.45, 23);
  addArt("grinB", 7.4, 1.7, 4.0, P, 0.38, 24);
  // apartment 3 (mauve)
  addArt("landscape", 9.0, 1.7, 1.5, P / 2, 0.45, 26);
  addArt("flowers", 10.8, 1.7, 0.0, 0, 0.5, 27, -0.04);
  addArt("skullB", 9.5, 1.7, 4.0, P, 0.5, 28);
  // John's (dark red)
  addArt("handprints", 16.0, 1.6, 1.4, -P / 2, 0.5, 30);
  addArt("stitchedB", 13.0, 1.5, 1.1, P / 2, 0.45, 31, 0.1);
  addArt("stairs", 13.5, 1.6, 4.0, P, 0.5, 32);
  // floors: wood, carpet, tile where it belongs
  floorPatch("tile", 1, 8, 19, 5, 1.0, 0.004); // lobby
  floorPatch("plankDark", 6, 5, 14, 2, 1.0, 0.004); // hallway boards
  floorPatch("runner", 6.4, 5.5, 13.2, 1.0, 1.0, 0.007); // runner down the middle
  floorPatch("plank", 5, 0, 3, 4, 1.0, 0.004); // apartment 2
  floorPatch("carpet", 9, 0, 3, 4, 1.0, 0.004); // apartment 3
  floorPatch("plankDark", 13, 0, 3, 4, 1.0, 0.004); // John's
}


function drawPhotoWall() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = "#00000000"; x.clearRect(0, 0, 512, 256);
  for (let i = 0; i < 6; i++) {
    const px = 14 + (i % 3) * 164, py = 12 + Math.floor(i / 3) * 124;
    x.fillStyle = "#2a1c12"; x.fillRect(px, py, 150, 112);
    x.fillStyle = ["#b8a888", "#a89878", "#c0b090"][i % 3]; x.fillRect(px + 8, py + 8, 134, 96);
    x.fillStyle = "#3a2e22"; x.beginPath(); x.arc(px + 75, py + 48, 22, 0, 6.3); x.fill(); x.fillRect(px + 45, py + 70, 60, 34);
    x.fillStyle = "#d8cdb0"; x.beginPath(); x.arc(px + 75, py + 46, 17, 0, 6.3); x.fill();
    x.fillStyle = "#14100c"; x.fillRect(px + 66, py + 42, 5, 6); x.fillRect(px + 80, py + 42, 5, 6);
    if (i === 4) { x.fillStyle = "#b8a888"; x.fillRect(px + 8, py + 8, 134, 96); } // an empty frame
    if (i === 2) { x.strokeStyle = "#120c08"; x.lineWidth = 4; for (let k = 0; k < 9; k++) { x.beginPath(); x.moveTo(px + 40 + k * 8, py + 20); x.lineTo(px + 30 + k * 9, py + 90); x.stroke(); } }
  }
  return c;
}
function drawCalendar() {
  const c = document.createElement("canvas");
  c.width = 180; c.height = 240;
  const x = c.getContext("2d");
  x.fillStyle = "#e6dfc8"; x.fillRect(0, 0, 180, 240);
  x.fillStyle = "#8a1f1f"; x.fillRect(0, 0, 180, 36);
  x.fillStyle = "#e6dfc8"; x.font = "bold 20px Courier New"; x.fillText("SEPTEMBER", 28, 25);
  x.fillStyle = "#222"; x.font = "14px Courier New";
  for (let i = 0; i < 30; i++) x.fillText(String(i + 1), 10 + (i % 7) * 24, 62 + Math.floor(i / 7) * 36);
  x.strokeStyle = "#8a1010"; x.lineWidth = 2;
  [14, 20].forEach((n) => { const cx = 16 + ((n - 1) % 7) * 24, cy = 57 + Math.floor((n - 1) / 7) * 36; x.beginPath(); x.moveTo(cx - 8, cy - 8); x.lineTo(cx + 8, cy + 8); x.moveTo(cx + 8, cy - 8); x.lineTo(cx - 8, cy + 8); x.stroke(); });
  for (let k = 0; k < 3; k++) { const cx = 16 + 6 * 24, cy = 57 + 3 * 36; x.beginPath(); x.ellipse(cx, cy, 13 + k * 3, 11 + k * 3, k * 0.4, 0, 6.3); x.stroke(); }
  return c;
}
function drawStringBoard() {
  const c = document.createElement("canvas");
  c.width = 320; c.height = 360;
  const x = c.getContext("2d");
  x.fillStyle = "#6a5030"; x.fillRect(0, 0, 320, 360);
  const pins = [[60, 60], [240, 70], [70, 200], [250, 210], [160, 300], [160, 150]];
  x.strokeStyle = "#a01414"; x.lineWidth = 2;
  [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [0, 1], [2, 4]].forEach(([p, q]) => { x.beginPath(); x.moveTo(pins[p][0], pins[p][1]); x.lineTo(pins[q][0], pins[q][1]); x.stroke(); });
  pins.forEach(([px, py], i) => {
    x.fillStyle = i === 5 ? "#14100c" : "#d8d0b8"; x.fillRect(px - 30, py - 26, 60, 52);
    x.fillStyle = i === 5 ? "#8a1010" : "#6a6050";
    if (i === 5) { x.font = "bold 40px Courier New"; x.fillText("?", px - 11, py + 14); } else { x.fillRect(px - 22, py - 18, 44, 24); x.fillStyle = "#3a3228"; for (let k = 0; k < 3; k++) x.fillRect(px - 22, py + 10 + k * 5, 44, 2); }
    x.fillStyle = "#a01414"; x.beginPath(); x.arc(px, py - 24, 4, 0, 6.3); x.fill();
  });
  return c;
}

// ---- the staff room ---------------------------------------------------------------------------
let carpetTex = null;
function getCarpetTexture() {
  if (carpetTex) return carpetTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d");
  x.fillStyle = "#3d444c";
  x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 1800; i++) {
    const v = 50 + Math.floor(Math.random() * 40);
    x.fillStyle = `rgba(${v},${v + 4},${v + 10},${0.25 + Math.random() * 0.4})`;
    x.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  carpetTex = new THREE.CanvasTexture(c);
  carpetTex.wrapS = carpetTex.wrapT = THREE.RepeatWrapping;
  return carpetTex;
}

// The notice board over the desk: typed sheets and a sticky note pinned to cork. Used as the wall texture and as the close-up.
function drawStaffBoard(c) {
  const w = (c.width = 512);
  const h = (c.height = 640);
  const x = c.getContext("2d");
  let s = 4242;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  x.fillStyle = "#8b6a42";
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = `rgba(${60 + r() * 60},${40 + r() * 40},${20 + r() * 20},${0.25 + r() * 0.3})`;
    x.fillRect(r() * w, r() * h, 2 + r() * 3, 2 + r() * 3);
  }
  const sheet = (sx, sy, sw, sh, rot, lines, opt = {}) => {
    x.save();
    x.translate(sx + sw / 2, sy + sh / 2);
    x.rotate(rot);
    x.shadowColor = "rgba(0,0,0,0.5)";
    x.shadowBlur = 8;
    x.shadowOffsetY = 3;
    x.fillStyle = opt.bg || "#e7e2d2";
    x.fillRect(-sw / 2, -sh / 2, sw, sh);
    x.shadowColor = "transparent";
    x.fillStyle = "rgba(120,100,60,0.12)";
    x.fillRect(-sw / 2, -sh / 2, sw, 5);
    x.fillStyle = opt.ink || "#1d1d20";
    x.font = `${opt.size || 13}px "Courier New", monospace`;
    x.textBaseline = "top";
    lines.forEach((ln, i) => {
      if (ln[0] === "!") { x.fillStyle = "#8a1410"; ln = ln.slice(1); } else x.fillStyle = opt.ink || "#1d1d20";
      if (ln[0] === "#") { x.font = `bold ${(opt.size || 13) + 2}px "Courier New", monospace`; ln = ln.slice(1); } else x.font = `${opt.size || 13}px "Courier New", monospace`;
      x.fillText(ln, -sw / 2 + 12, -sh / 2 + 14 + i * ((opt.size || 13) + 5));
    });
    x.fillStyle = "#b02a22"; // the pin
    x.beginPath();
    x.arc(0, -sh / 2 + 9, 5, 0, 6.3);
    x.fill();
    x.restore();
  };
  sheet(22, 22, 226, 250, -0.03, ["#STAFF SCHEDULE", "", "MON  P. Dunn      7-3", "TUE  P. Dunn      7-3", "WED  (vacant)", "THU  P. Dunn      7-3", "FRI  P. Dunn      7-3", "NIGHTS  --- none ---", "", "!no one stays after dark", "!see rule #1"]);
  sheet(262, 30, 226, 262, 0.025, ["#APPOINTMENTS", "", "Sep 14  boiler inspection", "!        CANCELLED", "Sep 20  plumber, unit 4", "        'noises in walls'", "Sep 24  elevator repair", "        no show", "Sep 28  pest control", "!        refused to enter", "        'not mice'"]);
  sheet(30, 292, 250, 262, 0.02, ["#RENT - OCTOBER", "", "Apt 1   paid", "Apt 2   paid", "Apt 3   paid", "Apt 4   J. -----------", "!        2 MONTHS PAST DUE", "", "Notice sent  Sep 12", "Notice sent  Oct  1", "!no answer. lights always on"]);
  sheet(296, 322, 190, 150, -0.05, ["Don't knock on 4", "after dark.", "", "Don't open the", "cellar. Ever.", "          - Mgr"], { bg: "#e8d86a", ink: "#2a2418", size: 16 });
  sheet(280, 486, 214, 128, 0.03, ["#RULES", "1 lights stay on", "2 never the cellar", "3 if you hear it", "  walking, leave"], { size: 14 });
  // coffee stain
  x.strokeStyle = "rgba(90,56,24,0.3)";
  x.lineWidth = 6;
  x.beginPath();
  x.arc(110, 590, 30, 0.4, 5.6);
  x.stroke();
  return c;
}

let buzz = null;
const DRAIN = { x: 4.55, z: 6.55 };
function addStaffRoom() {
  const g = (rx, rz) => [rx, rz];
  // carpet
  const t = getCarpetTexture().clone();
  t.repeat.set(4 / 0.8, 2 / 0.8);
  t.needsUpdate = true;
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), new THREE.MeshStandardMaterial({ map: t, roughness: 1 }));
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(3, 0.007, 6);
  worldGroup.add(carpet);
  // stains in the carpet, worst round the drain
  [[3.7, 6.4, 0.9, 0.6, 0.4, 0x24211d], [4.3, 6.7, 0.7, 0.5, 1.2, 0x222a1e], [2.2, 6.0, 0.5, 0.35, 0.7, 0x2a1f1a], [1.9, 5.5, 0.4, 0.3, 2.2, 0x2b2a22]].forEach(([x, z, w, d, rot, col]) => {
    const m = addBox(w, 0.004, d, x, 0.01, z, col);
    m.rotation.y = rot;
  });
  // the drain in the corner: bare concrete where the carpet gives out, a rusted grate, green slime
  addBox(0.95, 0.012, 0.95, DRAIN.x, 0.012, DRAIN.z, 0x4b4a45);
  addBox(0.62, 0.016, 0.62, DRAIN.x, 0.02, DRAIN.z, 0x14110e);
  for (let i = 0; i < 5; i++) addBox(0.06, 0.02, 0.6, DRAIN.x - 0.24 + i * 0.12, 0.028, DRAIN.z, 0x6a4630);
  addBox(0.85, 0.006, 0.45, DRAIN.x - 0.05, 0.016, DRAIN.z + 0.12, 0x2b3a22).rotation.y = 0.5; // slime
  addBox(0.4, 0.006, 0.3, DRAIN.x + 0.1, 0.017, DRAIN.z - 0.2, 0x1d2a18).rotation.y = -0.4;
  // shelf of cleaning supplies on the west wall
  const sh = new THREE.Group();
  sh.position.set(1.2, 0, 6.3);
  worldGroup.add(sh);
  buildTarget = sh;
  const wood = 0x3a2a1c;
  [[0.02, 0.02, 0.66, 0.04], [0.02, 0.02, -0.66, 0.04]].forEach(() => {});
  addBox(0.04, 1.8, 0.04, 0, 0.9, -0.66, wood);
  addBox(0.04, 1.8, 0.04, 0, 0.9, 0.66, wood);
  const boards = [0.05, 0.55, 1.0, 1.45];
  boards.forEach((y) => addBox(0.34, 0.035, 1.36, 0, y, 0, wood));
  let seed = 77;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const cyl = (rt, rb, hgt, x, y, z, col) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, hgt, 8), new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 }));
    m.position.set(x, y, z);
    sh.add(m);
    return m;
  };
  const bottleCols = [0x3a6ea5, 0xb8b030, 0x4aa05a, 0xc8c8c0, 0xa03a3a, 0x7a4aa0];
  boards.forEach((y, row) => {
    for (let i = 0; i < 6; i++) {
      const z = -0.55 + i * 0.22 + (rnd() - 0.5) * 0.06;
      const kind = (row + i) % 4;
      if (kind === 0) cyl(0.05, 0.06, 0.24, 0, y + 0.14, z, bottleCols[Math.floor(rnd() * 6)]); // bottle
      else if (kind === 1) { // spray bottle
        cyl(0.045, 0.045, 0.2, 0, y + 0.12, z, bottleCols[Math.floor(rnd() * 6)]);
        addBox(0.1, 0.04, 0.05, 0.02, y + 0.26, z, 0x222222);
      } else if (kind === 2) cyl(0.07, 0.07, 0.12, 0, y + 0.08, z, 0xd9d6c8); // paper towel roll
      else addBox(0.14, 0.22, 0.1, 0, y + 0.13, z, row % 2 ? 0xd8d8d0 : 0x3a5a8a); // jug / box
    }
  });
  addBox(0.12, 0.05, 0.2, 0, 1.52, 0.1, 0xc9b020); // rubber gloves
  buildTarget = null;
  addSolid(1.2, 6.3, 0.4, 1.4);
  // a mop and bucket in the north-west corner
  cyl(0.18, 0.14, 0.3, 1.45, 0.15, 5.4, 0x6a6c70);
  const pole = cyl(0.015, 0.015, 1.5, 1.2, 0.75, 5.2, 0x8a6a40);
  pole.rotation.z = 0.12;
  addBox(0.22, 0.07, 0.16, 1.45, 0.38, 5.4, 0x8a867a);
  addSolid(1.45, 5.4, 0.35, 0.35);
  // the desk against the north wall, a chair, papers, a pile of folders
  const desk = new THREE.Group();
  desk.position.set(4.0, 0, 5.4);
  worldGroup.add(desk);
  buildTarget = desk;
  addBox(1.2, 0.05, 0.55, 0, 0.74, 0, 0x4b3a28);
  [[-0.55, -0.22], [0.55, -0.22], [-0.55, 0.22], [0.55, 0.22]].forEach(([x, z]) => addBox(0.05, 0.72, 0.05, x, 0.36, z, 0x2f2218));
  addBox(0.45, 0.3, 0.5, -0.33, 0.58, 0, 0x3a2c1e); // drawers
  addBox(0.3, 0.04, 0.24, 0.35, 0.79, 0.05, 0xc8c2ae).rotation.y = 0.2; // loose papers
  addBox(0.26, 0.05, 0.2, -0.3, 0.8, -0.08, 0x8a7a50); // folders
  addBox(0.26, 0.05, 0.2, -0.3, 0.85, -0.08, 0x5a6a50).rotation.y = 0.15;
  buildTarget = null;
  addSolid(4.0, 5.4, 1.2, 0.55);
  const chair = new THREE.Group();
  chair.position.set(4.35, 0, 6.0);
  chair.rotation.y = Math.PI + 0.25;
  worldGroup.add(chair);
  buildTarget = chair;
  addBox(0.42, 0.05, 0.42, 0, 0.46, 0, 0x2a2a30);
  addBox(0.42, 0.5, 0.05, 0, 0.78, -0.19, 0x2a2a30);
  addBox(0.05, 0.44, 0.05, 0, 0.22, 0, 0x1a1a1c);
  buildTarget = null;
  addSolid(4.35, 6.0, 0.4, 0.4);
  // the cork board behind the desk, and the sheets pinned to it
  addBox(1.08, 1.32, 0.04, 4.0, 1.7, 5.03, 0x3a2a1c);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 1.22), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawStaffBoard(document.createElement("canvas"))), roughness: 1 }));
  board.position.set(4.0, 1.7, 5.06);
  worldGroup.add(board);
  // flies round the drain
  flies = [];
  const flyMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
  for (let i = 0; i < 9; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.03), flyMat);
    worldGroup.add(f);
    flies.push({ m: f, ph: Math.random() * 20, r: 0.15 + Math.random() * 0.4, sp: 2.5 + Math.random() * 3, y: 0.2 + Math.random() * 0.5 });
  }
}
function updateFlies(dt) {
  if (!flies.length) return;
  const T = performance.now() / 1000;
  flies.forEach((f) => {
    const a = T * f.sp + f.ph;
    f.m.position.set(
      DRAIN.x + Math.cos(a) * f.r + Math.sin(a * 3.1) * 0.06,
      f.y + Math.sin(a * 1.7) * 0.12 + Math.sin(a * 9) * 0.015,
      DRAIN.z + Math.sin(a * 1.3) * f.r + Math.cos(a * 4.2) * 0.06
    );
    f.m.rotation.y = a;
  });
  // the buzzing, louder the closer you are to the drain
  if (audioCtx && state.settings.soundOn) {
    if (!buzz) {
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      const bp = audioCtx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 650;
      bp.Q.value = 1.4;
      const trem = audioCtx.createGain();
      trem.gain.value = 0.6;
      const lfo = audioCtx.createOscillator();
      lfo.frequency.value = 29;
      const lfoG = audioCtx.createGain();
      lfoG.gain.value = 0.4;
      lfo.connect(lfoG).connect(trem.gain);
      [118, 124, 131].forEach((f) => {
        const o = audioCtx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.connect(bp);
        o.start();
      });
      lfo.start();
      bp.connect(trem).connect(gain).connect(audioCtx.destination);
      buzz = gain;
    }
    const p = yawObject.position;
    const d = Math.hypot(p.x - DRAIN.x, p.z - DRAIN.z);
    const want = state.phase === "explore" && p.x < 21 && p.z < 8 ? Math.pow(Math.max(0, 1 - d / 5.5), 2) * 0.05 : 0;
    buzz.gain.setTargetAtTime(want, audioCtx.currentTime, 0.15);
  } else if (buzz) buzz.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
}

// ---- second floor: simple, detailed apartments behind real doors ----
function addFloor2() {
  const P = Math.PI;
  // corridor: boards, a runner, a few pictures, two weak sconces
  floorPatch("plankDark", 23, 5, 22, 3, 1.0, 0.004);
  floorPatch("runner", 23.4, 5.5, 21.2, 1.0, 1.0, 0.007);
  [["house", 27, 0], ["clock", 31.5, 0], ["portrait", 36.5, 0], ["flowers", 41, 0], ["landscape", 27, 1], ["eyes", 31.5, 1], ["stairs", 36.5, 1], ["child", 41, 1]].forEach(([k, x, s], i) =>
    addArt(k, x, 1.65, s ? 8.0 : 5.0, s ? P : 0, 0.5, 40 + i, (i % 3 - 1) * 0.03)
  );
  [31.5, 41].forEach((x, i) => {
    addBox(0.2, 0.14, 0.1, x, 2.3, 5.1, 0x2a2420);
    const l = new THREE.PointLight(0xffb060, 0.35, 4.2, 2);
    l.position.set(x, 2.2, 5.5);
    worldGroup.add(l);
    flickerLights.push({ light: l, base: 0.35, phase: 2 + i * 3.1 });
  });
  F2_ROOMS.forEach(buildF2Room);
}
function buildF2Room(r) {
  const N = r.side === "N";
  const X = (u) => r.c0 + u;
  const Z = (v) => (N ? 1 + v : 12 - v);
  const b = (u, v, w, d, h, y, color, solid) => {
    const m = addBox(w, h, d, X(u), y, Z(v), color);
    if (solid) addSolid(X(u), Z(v), w, d);
    return m;
  };
  const rot = N ? 0 : Math.PI; // pictures on the far wall face the door
  floorPatch(r.floor, r.c0, N ? 1 : 9, r.w, 3, 1.0, 0.004);
  // skirting along the far and side walls
  const trim = { f2a: 0xcfc4a0, f2b: 0xd8c6cc, f2c: 0x2a1c14, f2d: 0x1c1010, hall: 0x4a4038 }[r.wall] || 0x4a4038;
  b(r.w / 2, 0.04, r.w - 0.06, 0.03, 0.12, 0.06, trim);
  b(0.04, 1.5, 0.03, 2.9, 0.12, 0.06, trim);
  b(r.w - 0.04, 1.5, 0.03, 2.9, 0.12, 0.06, trim);
  const L = r.layout;
  if (L === "lobby") {
    b(2.8, 0.4, 1.2, 0.4, 0.45, 0.22, 0x3a2a1c, true); // bench
    b(2.8, 0.7, 1.2, 0.05, 0.4, 0.45, 0x2a1c12);
    b(0.4, 0.8, 0.3, 0.3, 0.3, 0.2, 0x3a2a1c); // dead plant in a pot
    for (let i = 0; i < 4; i++) { const s = b(0.3 + i * 0.025, 0.8, 0.02, 0.03, 0.7, 0.9, 0x3a3320); s.rotation.z = (i - 1.5) * 0.3; }
    addBox(0.7, 0.9, 0.04, X(2.4), 1.5, Z(0.04), 0x2a2218); // directory board
    addBox(0.62, 0.8, 0.02, X(2.4), 1.5, Z(0.065), 0xcfc6a8);
  } else if (L === "bedroom") {
    b(3.1, 1.1, 1.0, 1.95, 0.3, 0.2, 0x3a2a22, true); // bed
    b(3.1, 1.1, 0.92, 1.85, 0.14, 0.4, 0xb9b3a4);
    b(3.1, 0.3, 0.7, 0.3, 0.1, 0.52, 0xd8d4c8);
    b(3.1, 1.5, 0.92, 1.1, 0.06, 0.5, r.accent);
    b(3.1, 0.05, 1.0, 0.06, 0.8, 0.5, 0x2a1c14);
    b(2.35, 0.3, 0.4, 0.4, 0.45, 0.22, 0x3a2e24, true); // nightstand + glass
    b(2.35, 0.3, 0.07, 0.07, 0.12, 0.5, 0x8fa0a8);
    b(0.55, 0.35, 0.5, 0.9, 2.0, 1.0, 0x3a2e24, true); // wardrobe
    b(0.28, 0.62, 0.02, 0.02, 0.5, 1.0, 0x1a1410);
    b(1.7, 2.0, 1.7, 1.1, 0.012, 0.01, r.accent); // rug
    addArt("figure", X(2.0), 1.75, Z(0.03), rot, 0.4, 61);
  } else if (L === "kitchen") {
    b(0.35, 0.6, 0.6, 0.6, 0.9, 0.45, 0x2a2a2c, true); // stove
    b(0.35, 1.6, 0.6, 1.2, 0.9, 0.45, 0xcfc8b8, true); // counter
    b(0.34, 1.6, 0.62, 1.2, 0.04, 0.92, 0x2a2622);
    b(0.34, 1.6, 0.4, 0.5, 0.06, 0.95, 0x7a8286); // sink
    b(3.55, 0.45, 0.7, 0.7, 1.8, 0.9, 0xd8d6cc, true); // fridge
    b(3.18, 0.45, 0.03, 0.04, 1.2, 1.2, 0x8a8a86);
    b(2.1, 1.7, 0.9, 0.9, 0.75, 0.38, 0x5a4026, true); // table
    b(1.45, 1.7, 0.4, 0.4, 0.45, 0.22, 0x3a2a1c, true);
    b(2.75, 1.7, 0.4, 0.4, 0.45, 0.22, 0x3a2a1c, true);
    b(2.1, 1.7, 0.2, 0.2, 0.06, 0.78, 0xb8b0a0); // one plate
    addArt("clock", X(2.0), 2.0, Z(0.03), rot, 0.3, 62);
  } else if (L === "study") {
    b(1.4, 0.45, 1.3, 0.65, 0.75, 0.38, 0x4a3420, true); // desk
    b(1.4, 1.1, 0.45, 0.45, 0.5, 0.25, 0x2a1c14); // chair
    b(1.0, 0.4, 0.14, 0.14, 0.2, 0.85, 0x6a6a5a); // lamp
    b(3.2, 0.25, 1.2, 0.3, 1.9, 0.95, 0x3a2a1c, true); // bookshelf
    for (let i = 0; i < 10; i++) b(2.7 + i * 0.1, 0.25, 0.07, 0.24, 0.3, 0.55 + (i % 4) * 0.4, [0x5a2a2a, 0x2a3a4a, 0x4a4a2a, 0x3a2a3a][i % 4]);
    b(3.2, 2.0, 0.8, 0.8, 0.8, 0.4, 0x4a3a30, true); // armchair
    addArt("house", X(0.04 + 0.01), 1.7, Z(1.5), Math.PI / 2, 0.45, 63);
  } else if (L === "utility") {
    b(1.0, 0.2, 1.6, 0.35, 1.8, 0.9, 0x4a4036, true); // shelving
    [0.4, 0.9, 1.4].forEach((y, i) => { b(1.0, 0.2, 1.6, 0.4, 0.03, y, 0x2a2420); b(0.6 + i * 0.3, 0.2, 0.14, 0.14, 0.2, y + 0.1, [0x3a5a8a, 0x8a8a3a, 0x7a3a3a][i]); });
    b(0.3, 1.0, 0.32, 0.32, 0.34, 0.17, 0x6a6e70); // bucket + mop
    const mop = b(0.9, 1.2, 0.03, 0.03, 1.4, 0.7, 0x8a7a5a); mop.rotation.z = 0.12;
    addBox(0.04, 0.3, 0.45, 43.04, 1.35, Z(1.4), 0x2a2218); // key board
    addBox(0.02, 0.1, 0.05, 43.08, 1.35, Z(1.4), 0x8a7a40);
  } else if (L === "vacant") {
    b(3.4, 1.4, 0.9, 1.9, 0.18, 0.1, 0x8a8478, true); // bare mattress
    b(3.4, 1.4, 0.92, 1.1, 0.012, 0.19, 0x2a0a0a); // stain
    b(1.0, 1.2, 0.5, 0.5, 0.05, 0.45, 0x3a2a1c, true); // a chair facing the corner
    b(1.0, 1.0, 0.5, 0.05, 0.5, 0.7, 0x3a2a1c);
    b(1.0, 1.2, 0.06, 0.06, 0.4, 0.2, 0x3a2a1c);
    b(1.8, 1.0, 1.2, 1.0, 0.012, 0.01, 0x1a1210);
  } else if (L === "tv") {
    b(2.0, 0.35, 1.0, 0.5, 0.5, 0.25, 0x3a2a1c, true); // stand
    b(2.0, 0.35, 0.8, 0.45, 0.55, 0.77, 0x161618, true); // set
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.4), new THREE.MeshStandardMaterial({ color: 0x0a0c0a, emissive: 0x050805, roughness: 0.2 }));
    scr.position.set(X(2.0), 0.77, Z(0.35) + (N ? 0.23 : -0.23));
    scr.rotation.y = rot;
    worldGroup.add(scr);
    b(2.0, 2.2, 0.8, 0.8, 0.8, 0.4, 0x4a3a30, true); // armchair facing it
    b(2.0, 2.55, 0.8, 0.2, 0.5, 0.9, 0x4a3a30);
    b(3.3, 1.1, 0.4, 0.4, 0.5, 0.25, 0x3a2a1c, true); // side table + remote
    b(3.3, 1.1, 0.06, 0.16, 0.03, 0.52, 0x1a1a1a);
    b(1.8, 1.4, 2.2, 1.6, 0.012, 0.01, 0x4a2a2a);
  } else if (L === "nursery") {
    b(3.0, 1.1, 0.8, 1.3, 0.12, 0.4, 0x6a5a3a, true); // crib
    [[-0.38, -0.62], [0.38, -0.62], [-0.38, 0.62], [0.38, 0.62]].forEach(([dx, dz]) => b(3.0 + dx, 1.1 + dz, 0.05, 0.05, 0.9, 0.45, 0x6a5a3a));
    for (let i = 0; i < 7; i++) b(2.65 + i * 0.12, 1.72, 0.02, 0.02, 0.5, 0.65, 0x8a7a5a);
    b(1.2, 0.3, 1.0, 0.45, 0.9, 0.45, 0x5a4a3a, true); // dresser
    b(1.2, 0.3, 0.9, 0.04, 0.8, 0.5, 0x3a2a1c);
    b(0.5, 1.9, 0.6, 0.8, 0.7, 0.4, 0x4a3a2a, true); // rocking chair
    b(0.5, 2.15, 0.06, 0.8, 0.75, 0.9, 0x4a3a2a);
    b(2.0, 2.0, 1.8, 1.6, 0.012, 0.01, 0x8a5a6a); // rug
    const mob = new THREE.Group();
    mob.position.set(X(3.0), 2.6, Z(1.1));
    [0, 1, 2, 3].forEach((i) => { const a = i * 1.57; const s = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.08), new THREE.MeshStandardMaterial({ color: [0xcfa0a0, 0xa0b0cf, 0xcfcf90, 0xb0cfa0][i] })); s.position.set(Math.cos(a) * 0.25, -0.35, Math.sin(a) * 0.25); mob.add(s); const st = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.35, 0.01), new THREE.MeshStandardMaterial({ color: 0x555555 })); st.position.set(Math.cos(a) * 0.25, -0.17, Math.sin(a) * 0.25); mob.add(st); });
    worldGroup.add(mob);
    swayers.push({ grp: mob, phase: 1.1 });
    const nl = new THREE.PointLight(0xffb070, 0.3, 3.2, 2);
    nl.position.set(X(1.2), 1.25, Z(0.5));
    worldGroup.add(nl);
  } else if (L === "bathroom") {
    b(3.55, 1.0, 0.8, 1.9, 0.5, 0.25, 0xd8d6cc, true); // tub
    b(3.55, 1.0, 0.68, 1.75, 0.04, 0.5, 0x5a6a5a); // dirty water
    b(0.5, 0.45, 0.4, 0.6, 0.4, 0.2, 0xd8d6cc, true); // toilet
    b(0.5, 0.4, 0.36, 0.1, 0.4, 0.6, 0xd8d6cc);
    b(1.5, 0.5, 0.5, 0.35, 0.85, 0.42, 0xd8d6cc, true); // sink
    addArt("mirror", X(1.5), 1.7, Z(0.03), rot, 0.6, 64);
    b(3.55, 0.35, 0.75, 0.15, 0.04, 2.0, 0xaaaa9a); // shower rail
  } else if (L === "meters") {
    b(1.0, 0.7, 0.9, 0.1, 1.2, 1.3, 0x4a4d4f);
    for (let i = 0; i < 4; i++) { b(0.5 + i * 0.25, 0.7, 0.14, 0.04, 0.14, 1.55, 0xcfc6a8); b(0.5 + i * 0.25, 0.7, 0.02, 0.05, 0.08, 1.55, 0x8a1010); }
    b(0.2, 1.4, 0.4, 0.2, 1.0, 0.5, 0x2a2c2e, true); // a cabinet
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
  // flickering STAFF sign over the staff door, on the lobby side
  staffSignMat = new THREE.MeshBasicMaterial({ map: makeSignTexture("STAFF", "#10140f", "#d7e6a8"), fog: false }); // fog-free: you see it flicker from the front door
  const staffSign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.225), staffSignMat);
  staffSign.position.set(3.5, 2.82, 8.02);
  worldGroup.add(staffSign);
  // a soft halo round the sign so the flicker reads from across the lobby
  const hc = document.createElement("canvas");
  hc.width = hc.height = 64;
  const hx = hc.getContext("2d");
  const hg = hx.createRadialGradient(32, 32, 2, 32, 32, 32);
  hg.addColorStop(0, "rgba(215,230,168,0.9)");
  hg.addColorStop(0.4, "rgba(160,190,110,0.28)");
  hg.addColorStop(1, "rgba(0,0,0,0)");
  hx.fillStyle = hg;
  hx.fillRect(0, 0, 64, 64);
  staffHaloMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(hc), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), staffHaloMat);
  halo.position.set(3.5, 2.82, 8.04);
  worldGroup.add(halo);
  staffSignLight = new THREE.PointLight(0xd7e6a8, STAFF_SIGN_LEVEL, 8, 2);
  staffSignLight.position.set(3.5, 2.6, 8.4);
  worldGroup.add(staffSignLight);
  // staff room (west end of the hallway): shelf, mop bucket, breaker panel
  if (yawObject.position.x < 21) addStaffRoom();
  if (levelOf(yawObject.position.x) === 1) addFloor2();
  if (yawObject.position.x >= 46 && yawObject.position.z > 13.5) addFinale();
  // faint bulbs so each level isn't a void (only built for the level you're on)
  const px = yawObject.position.x;
  const bulbs = px >= 46 ? [[50.5, 2.5, 3.0], [50.5, 2.5, 9.5], [57, 2.5, 3.5]] : px >= 21 ? [[25, 2.5, 6.5], [31, 2.5, 6.5], [37, 2.5, 6.5], [43, 2.5, 6.5]] : [];
  bulbs.forEach(([x, y, z]) => {
    const l = new THREE.PointLight(0x8fa0b8, 0.3, 7, 2);
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
// a side table with an old radio, and a bank of mailboxes on the north wall
function addLobbyExtras() {
  const wood = 0x3a2a1c;
  addBox(0.8, 0.05, 0.5, 11.5, 0.72, 12.6, wood);
  addBox(0.05, 0.7, 0.46, 11.15, 0.36, 12.6, wood);
  addBox(0.05, 0.7, 0.46, 11.85, 0.36, 12.6, wood);
  addSolid(11.5, 12.6, 0.8, 0.5);
  addBox(0.32, 0.18, 0.12, 11.5, 0.84, 12.6, 0x4a3a28); // the radio
  addBox(0.1, 0.1, 0.01, 11.42, 0.84, 12.535, 0x16120e);
  addBox(0.06, 0.02, 0.01, 11.6, 0.87, 12.535, 0x9a8a60);
  addBox(0.025, 0.28, 0.025, 11.62, 1.02, 12.6, 0x8a8a84); // aerial
  addBox(2.0, 0.6, 0.08, 12.1, 1.3, 8.06, 0x44494a); // mailbox bank
  [0, 1, 2, 3].forEach((i) => {
    addBox(0.4, 0.22, 0.02, 11.4 + i * 0.5, 1.3, 8.11, i === 2 || i === 3 ? 0x5a5f58 : 0x3a3e3e);
    addBox(0.12, 0.02, 0.01, 11.4 + i * 0.5, 1.37, 8.125, 0x15171a);
  });
}

function playStatic() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const n = audioCtx.createBufferSource();
  const bp = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();
  n.buffer = noiseBuf;
  n.loop = true;
  bp.type = "bandpass";
  bp.Q.value = 2;
  bp.frequency.setValueAtTime(900, t);
  bp.frequency.linearRampToValueAtTime(2600, t + 0.5);
  bp.frequency.linearRampToValueAtTime(1200, t + 1.1);
  bp.frequency.linearRampToValueAtTime(3200, t + 1.8);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.22, t + 0.1);
  g.gain.setValueAtTime(0.22, t + 1.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
  n.connect(bp).connect(g).connect(audioCtx.destination);
  n.start(t);
  n.stop(t + 2.1);
}

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
  deskBulbMat = new THREE.MeshBasicMaterial({ color: 0x2a2418 }); // the lamp is dead
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 10), deskBulbMat);
  bulb.position.set(lx - 0.2, 1.0, lz);
  [lbase, lstem, larm, shade, bulb].forEach((m) => G.add(m));

  // a small, dim, warm desk lamp: enough to see the desk and the way on from the front door
  deskLamp = new THREE.PointLight(0xffd7a0, 0.55, 8, 2);
  deskLamp.position.set(lx - 0.2, 0.95, lz);
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
  const stone = 0x5a4632; // worn wooden stairs
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
      const edge = s.z0 + dz * i;
      addBox(w - 0.04, 0.03, 0.14, cx, top + 0.015, edge + (dz < 0 ? -0.07 : 0.07), 0xb09060); // lit tread edge
      addBox(w - 0.04, 0.03, 0.03, cx, top + 0.016, edge + (dz < 0 ? -0.16 : 0.16), 0x140c06); // dark gap before the next riser
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
  // Boards nailed across the top of the cellar stairs, until they're chopped.
  if (!state.flags.boardsChopped && yawObject.position.x < 21) {
    const zb = 3.4;
    const base = floorHeight(18.5, zb);
    [0.3, 0.62, 0.94, 1.26].forEach((dy, i) => {
      const plank = addBox(2.0, 0.17, 0.05, 18.5, base + dy, zb - (i % 2) * 0.05, 0x3a2a1c);
      plank.rotation.z = ((i % 3) - 1) * 0.07;
    });
    addSolid(18.5, zb, 2.0, 0.35);
  }
  // upstairs: the elevator is the only way back down
  if (levelOf(yawObject.position.x) === 1) {
    addBox(1.1, 2.2, 0.08, 24.5, 1.1, 1.05, 0x8a8f95);
    addBox(0.02, 2.2, 0.09, 24.5, 1.1, 1.05, 0x2a2c2e);
    addBox(1.3, 0.1, 0.1, 24.5, 2.25, 1.06, 0x55585c);
    addBox(0.08, 0.14, 0.03, 25.3, 1.2, 1.05, 0xc8a020);
    const el = new THREE.PointLight(0xc8a020, 0.5, 3, 2);
    el.position.set(24.5, 2.3, 1.6);
    worldGroup.add(el);
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
  // the main breaker panel on the cellar's north wall
  addBox(0.6, 0.75, 0.12, 53.2, 1.55, 1.06, 0x4a4d4f);
  addBox(0.5, 0.65, 0.02, 53.2, 1.55, 1.13, 0x3a3d3f);
  addBox(0.05, 0.22, 0.05, 53.2, 1.7, 1.17, state.flags.powerOn ? 0x3aa14a : 0xaa2222);
  if (!state.flags.powerOn) {
    const rl = new THREE.PointLight(0xff3322, 0.7, 3.5, 2);
    rl.position.set(53.2, 1.7, 1.5);
    worldGroup.add(rl);
  }
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
  addBox(0.5, 1.7, 1.4, 54.6, 0.85, 10.6, 0x2a2018);
  [0.5, 1.0, 1.5].forEach((h) => addBox(0.45, 0.04, 1.4, 54.6, h, 10.6, 0x3a2c1e));
  [[0.65, 10.2], [1.15, 10.7], [0.65, 11.0]].forEach(([h, z]) => addBox(0.18, 0.25, 0.18, 54.6, h + 0.1, z, 0x6a7a5a)); // jars
  addSolid(54.6, 10.6, 0.5, 1.4);
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
  addCellarMaze();
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
  if (!state.flags.gateOpen && col === CELLAR.gate.c && row === CELLAR.gate.r) return true;
  for (const s of solids) if (x > s.minX && x < s.maxX && y > s.minZ && y < s.maxZ) return true;
  return MAP[row][col] !== 0;
}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// ---- walking: smooth acceleration, a real stride (head bob + footsteps in time), sprint, solid collision ----
const WALK_ACCEL = 11; // how quickly you reach full speed / stop
const SPRINT_MULT = 1.6;
let moveVX = 0;
let moveVZ = 0;
let bobPhase = 0;
let bobAmp = 0;
let sprintK = 0;
let sprintTime = 0, bedTick = 0;
let walkedDist = 0;
let breathT = 0;
function canStand(x, z) {
  const r = PLAYER_RADIUS;
  return !(isWall(x - r, z - r) || isWall(x + r, z - r) || isWall(x - r, z + r) || isWall(x + r, z + r) || isWall(x, z - r) || isWall(x, z + r) || isWall(x - r, z) || isWall(x + r, z));
}
function tryMovePlayer(dt) {
  if (state.activeNpc || state.flags.tut === "open" || state.transition) {
    moveVX = moveVZ = 0;
    return; // frozen mid-dialogue
  }

  let forwardInput = 0;
  if (keys.has("w") || keys.has("arrowup")) forwardInput += 1;
  if (keys.has("s") || keys.has("arrowdown")) forwardInput -= 1;
  let strafeInput = 0;
  if (keys.has("d")) strafeInput += 1;
  if (keys.has("a")) strafeInput -= 1;
  forwardInput = Math.max(-1, Math.min(1, forwardInput + padMoveY));
  strafeInput = Math.max(-1, Math.min(1, strafeInput + padMoveX));
  if (keys.has("arrowleft")) yawObject.rotation.y += 1.6 * dt;
  if (keys.has("arrowright")) yawObject.rotation.y -= 1.6 * dt;

  camera.getWorldDirection(_forward);
  _forward.y = 0;
  _forward.normalize();
  _right.crossVectors(_forward, _up).normalize();

  // wanted velocity: diagonals aren't faster, backing up and strafing are slower, sprint only goes forward
  let wx = _forward.x * forwardInput + _right.x * strafeInput;
  let wz = _forward.z * forwardInput + _right.z * strafeInput;
  const wl = Math.hypot(wx, wz);
  const wantSprint = (keys.has("shift") || padSprint) && forwardInput > 0 && state.crouch !== true && wl > 0;
  sprintK += ((wantSprint ? 1 : 0) - sprintK) * Math.min(1, dt * 6);
  let spd = MOVE_SPEED * (1 - 0.55 * crouchK) * (1 + (SPRINT_MULT - 1) * sprintK);
  if (forwardInput < 0) spd *= 0.7;
  else if (forwardInput === 0) spd *= 0.85;
  if (wl > 0) { wx = (wx / wl) * spd; wz = (wz / wl) * spd; }
  const k = Math.min(1, dt * WALK_ACCEL);
  moveVX += (wx - moveVX) * k;
  moveVZ += (wz - moveVZ) * k;
  if (Math.hypot(moveVX, moveVZ) < 0.02 && wl === 0) moveVX = moveVZ = 0;

  const p = yawObject.position;
  const stuck = !canStand(p.x, p.z); // spawned tight against something: let the player walk out
  const nx = p.x + moveVX * dt;
  const nz = p.z + moveVZ * dt;
  let moved = 0;
  if (stuck || canStand(nx, p.z)) { moved += Math.abs(nx - p.x); p.x = nx; } else moveVX = 0;
  if (stuck || canStand(p.x, nz)) { moved += Math.abs(nz - p.z); p.z = nz; } else moveVZ = 0;

  // stride: the camera sways in time with the footfalls
  const speedNow = Math.hypot(moveVX, moveVZ);
  walkedDist += moved;
  const prevStep = Math.floor(bobPhase / Math.PI);
  bobPhase += dt * speedNow * 3.0;
  if (Math.floor(bobPhase / Math.PI) !== prevStep && speedNow > 0.4) playFootstep(isOutside() || crouchK > 0.5);
  if (sprintK > 0.9) { sprintTime += dt; if (sprintTime > 3.5) { sprintTime = 0; playVoice("pant", 0.5, 6); } } else sprintTime = Math.max(0, sprintTime - dt);
  bedTick += dt; if (bedTick > 1) { bedTick = 0; updateBed(); }
  const wantAmp = Math.min(1, speedNow / MOVE_SPEED) * (1 + 0.45 * sprintK) * (1 - 0.5 * crouchK);
  bobAmp += (wantAmp - bobAmp) * Math.min(1, dt * 8);
  breathT += dt;
  camera.position.y = Math.sin(bobPhase * 2) * 0.032 * bobAmp + Math.sin(breathT * 1.3) * 0.004;
  camera.position.x = Math.sin(bobPhase) * 0.022 * bobAmp;
  camera.rotation.z = Math.sin(bobPhase) * 0.005 * bobAmp;
  const fov = 75 + 6 * sprintK;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
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
    setElevatorOpen(1);
    startTransition({ x: 24.5, y: 3.3, yaw: Math.PI }); // up to the second floor
  }
}

let staffLevel = 1;
function updateStaffSign(dt) {
  if (!staffSignMat) return;
  staffSignTimer -= dt;
  if (staffSignTimer <= 0) {
    // mostly steady, with bursts of stutter and the odd full blackout
    const r = Math.random();
    staffLevel = r < 0.55 ? 1 : r < 0.8 ? 0.45 + Math.random() * 0.4 : r < 0.92 ? 0.12 : 0;
    staffSignTimer = staffLevel === 1 ? 0.15 + Math.random() * 0.9 : 0.04 + Math.random() * 0.1;
  }
  // walking up to the door: the sign, its halo and its light fade right down so nothing glares in your face
  const p = yawObject.position;
  const d = Math.hypot(p.x - 3.5, p.z - 8.0);
  const prox = Math.max(0.06, Math.min(1, (d - 0.6) / 3.2));
  const level = staffLevel;
  const c = level * (0.25 + 0.75 * prox);
  staffSignMat.color.setRGB(c, c, c);
  if (staffHaloMat) staffHaloMat.opacity = level * prox * prox;
  if (staffSignLight) staffSignLight.intensity = STAFF_SIGN_LEVEL * 1.1 * level * prox * prox;
}

// The first time you step through the front door your view drifts left, toward the flickering STAFF sign.
let entryLookLeft = 0;
function updateEntryLook(dt) {
  const p = yawObject.position;
  if (state.phase === "explore" && !state.flags.entryLook && p.z < 13.3 && p.z > 11 && p.x > 6 && p.x < 11) {
    state.flags.entryLook = true;
    entryLookLeft = 0; // no forced camera turn on entry
  }
  if (entryLookLeft > 0 && state.phase === "explore") {
    const step = Math.min(entryLookLeft, dt * 0.4);
    yawObject.rotation.y += step;
    entryLookLeft -= step;
  }
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
// How close is the thing the beam is hitting? Light is inverse-square, so a door
// half a metre away would blaze and bounce glare back; dim the beam as you get close.
let beamClose = 0, beamScale = 1, beamDist = 15, beamTick = 0, beamRay = null;
function measureBeam(dt) {
  beamTick -= dt;
  if (beamTick <= 0) {
    beamTick = 0.06;
    try {
      if (!beamRay) beamRay = new THREE.Raycaster();
      camera.getWorldPosition(_bmO || (_bmO = new THREE.Vector3()));
      camera.getWorldDirection(_bmD || (_bmD = new THREE.Vector3()));
      beamRay.set(_bmO, _bmD);
      beamRay.far = 6;
      const hit = beamRay.intersectObject(worldGroup, true).find((h) => h.object && h.object.isMesh !== false);
      beamDist = hit && hit.distance != null ? hit.distance : 15;
    } catch (e) { beamDist = 15; }
    // backup: march the view ray through the map, so walls and floors count even if the mesh test misses
    try {
      for (let t = 0.1; t < Math.min(beamDist, 6); t += 0.1) {
        const x = _bmO.x + _bmD.x * t, y = _bmO.y + _bmD.y * t, z = _bmO.z + _bmD.z * t;
        if (y < 0 || y > WALL_HEIGHT || isWall(x, z)) { beamDist = t; break; }
      }
    } catch (e) {}
  }
  // brightness on a surface falls with distance squared, so scale the beam with distance squared:
  // anything within ~3.5 m is lit about as brightly as something 4 m away, never a blown-out disc
  const want = beamDist >= 4.5 ? 1 : Math.max(0.02, Math.min(1, Math.pow(beamDist / 4, 2) * 0.8));
  beamScale += (want - beamScale) * Math.min(1, dt * 12);
  beamClose = 1 - beamScale;
}
let _bmO = null, _bmD = null;
function updateFlashlight(dt) {
  const wantsOn = hasFlashlightOn();
  measureBeam(dt);

  if (wantsOn) {
    state.batteryLevel = Math.max(0, state.batteryLevel - BATTERY_DRAIN_RATE * dt);
    if (state.batteryLevel <= 0) {
      state.batteryLevel = 0;
      state.flashlightOn = false;
    }
  }

  let targetIntensity = hasFlashlightOn() && scareBlackout <= 0 ? FLASHLIGHT_MAX_INTENSITY * beamScale : 0;

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
  yawObject.rotation.y -= e.movementX * MOUSE_SENSITIVITY * state.settings.sens;
  camera.rotation.x -= e.movementY * MOUSE_SENSITIVITY * state.settings.sens;
  camera.rotation.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.rotation.x));
}

document.addEventListener("pointerlockchange", onPointerLockChange);
document.addEventListener("mousemove", onMouseMove);
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || document.pointerLockElement !== renderer.domElement) return;
  const t = state.phase === "explore" && !state.activeNpc && !state.transition ? nearestInteractable() : null;
  if (t && t.label) handleInteract();
  else swingAxe();
});
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
    if (isDoorOpen(door)) {
      // an open door can be shut again, as long as you're not standing in it
      const dd = Math.hypot(door.x - px, door.y - py);
      if (dd > 0.9 && dd < 1.5 && dd < doorDist && !door.noClose) {
        doorDist = dd;
        doorTarget = { type: "door", id: door.id, label: "Close Door" };
      }
      return;
    }
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
      if (h.id === "breaker") label = state.flags.powerOn ? "Breaker Panel" : "Open Breaker Panel";
      if (h.id === "boards") label = ""; // no prompt: you have to try things
      if (h.loot && (state.flags.looted || {})[h.id]) label = ""; // already searched
      if (h.loot && isDoorSpot(spotOf(h))) label = (state.flags.doorsOpenA || {})[h.id] ? "Close" : h.label;
      if (h.lever !== undefined) label = (state.flags.leverSeq || []).includes(h.lever) ? "" : h.label;
      if (h.lightSwitch) label = state.flags.apt2Light ? "" : "Flip Light Switch";
      if (h.elevatorDown && state.inventory.elevKey) label = "Use Elevator Key";
      if (h.finaleExit) label = state.flags.finaleWon ? h.label : "";
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
  crouchK += ((state.phase === "explore" && state.crouch ? 1 : 0) - crouchK) * Math.min(1, dt * 9);
  const target = EYE_HEIGHT - CROUCH_DROP * crouchK + floorHeight(p.x, p.z);
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

// First-time control hints: each control is explained once, at the bottom of the screen, the first time it matters.
let hintEl = null;
let hintUntil = 0;
function hintBusy() {
  return performance.now() < hintUntil;
}
function hideHint() {
  hintUntil = 0;
  if (hintEl) hintEl.style.opacity = "0";
}
function showMessage(text) {
  try {
    if (!hintEl) {
      hintEl = document.createElement("div");
      hintEl.className = "interact-prompt";
      hintEl.style.cssText = "position:fixed;z-index:60;opacity:0;transition:opacity 0.5s";
      document.body.appendChild(hintEl);
    }
    hintEl.textContent = text;
    hintEl.style.opacity = "1";
    hintUntil = performance.now() + 1800;
    setTimeout(() => { if (performance.now() >= hintUntil - 50 && hintEl) hintEl.style.opacity = "0"; }, 1800);
  } catch (e) {}
}
function hintOnce(key, text) {
  if (!state.flags.hints) state.flags.hints = {};
  if (state.flags.hints[key] || hintBusy() || state.phase !== "explore") return false;
  state.flags.hints[key] = true;
  try {
    if (!hintEl) {
      hintEl = document.createElement("div");
      hintEl.className = "interact-prompt"; // the same box as every other instruction
      hintEl.style.cssText = "position:fixed;z-index:60;opacity:0;transition:opacity 0.5s";
      document.body.appendChild(hintEl);
    }
    hintEl.textContent = text;
    hintEl.style.opacity = "1";
    hintUntil = performance.now() + 4500;
    setTimeout(() => { if (performance.now() >= hintUntil - 50 && hintEl) hintEl.style.opacity = "0"; }, 4500);
  } catch (e) {}
  return true;
}
function updateControlHints() {
  if (!state.settings.showPrompts || state.activeNpc || state.transition || state.phase !== "explore") return;
  const p = yawObject.position;
  if (!state.inventory.flashlight || state.flags.tut) { /* movement basics only before the light is found */ }
  if (walkedDist < 1.5) hintOnce("move", "Move with " + [kn("forward"), kn("left"), kn("back"), kn("right")].join(" ") + ", look with the mouse");
  else if (walkedDist > 5) hintOnce("run", "Hold " + kn("sprint") + " to run");
  if (state.inventory.flashlight && !state.flags.tut && !state.flashlightOn && state.batteryLevel > 0) hintOnce("f", "Press " + kn("flash") + " to turn on flashlight");
  if (p.x >= 5 && p.x < 16 && p.z < 4 && !state.flags.tut) hintOnce("c", "Press " + kn("crouch") + " to crouch and look underneath things");
  if (state.batteries > 0 && state.inventory.flashlight) hintOnce("battUse", "Batteries: open inventory (" + kn("inv") + "), then press Use to recharge the flashlight");
}

function updateInteractPrompt() {
  updateTutorialBanner();
  updateControlHints();
  const prompt = document.getElementById("interact-prompt");
  if (state.activeNpc || state.phase === "breaker" || !state.settings.showPrompts) {
    prompt.classList.add("hidden");
    return;
  }
  const target = nearestInteractable();
  if (state.held === "axe" && state.inventory.axe && !state.flags.axeSwung && state.phase === "explore" && (!target || !target.label)) {
    prompt.textContent = "[Click] Swing Axe";
    prompt.classList.remove("hidden");
    return;
  }
  if (!target) {
    prompt.classList.add("hidden");
    return;
  }
  if (!target.label) {
    prompt.classList.add("hidden");
    return;
  }
  if (hintBusy()) { prompt.classList.add("hidden"); return; } // one message at a time: a hint or "No power" replaces the prompt
  prompt.textContent = "Press " + kn("interact") + " to " + target.label.toLowerCase();
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
      if (!state.flags.powerOn) {
        playClick();
        showMessage("No power");
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
    if (isDoorOpen(door)) {
      const e = state.entity;
      const blocked = (e.mode === "active" && Math.hypot(e.x - door.x, e.z - door.y) < 1.1) || husks.some((h) => h.mode !== "dead" && Math.hypot(h.x - door.x, h.z - door.y) < 1.0);
      if (blocked) {
        playClick();
        return;
      }
      if (door.isFront) state.frontDoorOpen = false;
      else state.doorsOpen[door.id] = false;
      playDoorCreak(door);
      return;
    }
    if (door.isFront) {
      state.frontDoorOpen = true;
      playDoorCreak(door);
    } else if (door.locked && !(door.keyId && state.inventory[door.keyId])) {
      playJingle();
      showMessage("Locked");
    } else {
      if (door.locked) playClick(); // key turning
      state.doorsOpen[door.id] = true;
      playDoorCreak(door);
      if (door.id === "apt2" && !(state.flags.faceSeen)) { state.flags.faceSeen = true; startFaceScare(); }
      if (door.id === "hallDoor" && state.entity.mode === "idle") {
        state.entity.mode = "waiting";
        state.entity.timer = ENTITY_SPAWN_DELAY;
      }
    }
  } else if (target.type === "hotspot") {
    const h = HOTSPOTS.find((x) => x.id === target.id);
    if (h.lever !== undefined) {
      pullLever(h);
      return;
    }
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
    } else if (h.id === "radio") {
      playStatic();
      setTimeout(() => openPaper(RADIO_PAPER), 700);
    } else if (h.id === "mail3" || h.id === "mail4") {
      const three = h.id === "mail3";
      const need = three ? "apt3Key" : "johnKey";
      if (!state.inventory[need]) {
        playKnock();
        addLog("Locked.");
      } else {
        playClick();
        openPaper(three ? MAIL3_PAPER : MAIL4_PAPER);
        if (three && !state.flags.mail3Open) {
          state.flags.mail3Open = true;
          setTimeout(() => collectItem("mailBatt"), 900);
        }
      }
    } else if (h.id === "breaker") {
      if (state.flags.powerOn) addLog("The power is on.");
      else openBreaker();
    } else if (h.exit) {
      const pt = PORTALS.find((p) => p.door === h.exit);
      playDoorCreak(DOORS.find((dr) => dr.id === h.exit));
      startTransition(pt.back);
    } else if (h.finaleExit) {
      if (state.flags.finaleWon) startEnding();
    } else if (h.elevatorDown) {
      if (state.inventory.elevKey) startFinale(); // the second ride
      else {
        playDing();
        startTransition({ x: 11.5, y: 9.2, yaw: Math.PI }); // down to the lobby
      }
    } else if (h.lightSwitch) {
      playClick();
      if (state.flags.powerOn && !state.flags.apt2Light) {
        state.flags.apt2Light = true;
        buildWorld();
        startWindowRun();
      }
    } else if (h.board) {
      openPaper({ draw: drawStaffBoard });
    } else if (h.paper) {
      openPaper(h.paper);
    } else if (h.loot && isDoorSpot(spotOf(h))) {
      toggleDoor(h);
    } else if (h.loot) {
      if (!state.flags.looted) state.flags.looted = {};
      if (state.flags.looted[h.id]) return;
      state.flags.looted[h.id] = true;
      playClick();
      const lids = lootList(h);
      if (lootMeshes[h.id]) { const lm = lootMeshes[h.id]; setTimeout(() => { lm.visible = false; }, 900); }
      const anim = startOpenAnim(h);
      lids.forEach((lid, n) => {
        if (anim) setTimeout(() => collectItem(lid), 900 + n * 1100);
        else collectItem(lid);
      });
    } else if (h.go) travel(h.go);
    else {
      playClick();
      showMessage(h.text);
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
    setTimeout(() => hintOnce("inv", kn("inv") + ": inventory   " + kn("flash") + ": flashlight   " + kn("switch") + ": switch item"), 900);
  }
  if (!item.hidden) buildWorld(); // remove the collected item's marker from the scene (hidden ones have none)
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
          : kn("switch") + ": switch item in hand<br />" + kn("inv") + " or Esc: close" + (state.batteries > 0 ? "<br /><b>Batteries: press Use to recharge the flashlight</b>" : "");
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
  const noteDate = (it) => { const m = /^(Sept|Oct)\s+(\d+)/.exec(it.paper || ""); return m ? (m[1] === "Oct" ? 100 : 0) + +m[2] : 0; }; // oldest first
  ITEMS.filter((it) => it.note && state.inventory[it.id]).sort((p, q) => noteDate(p) - noteDate(q)).forEach((it) => add(it.name, "Read", () => {
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
  if (it.draw) it.draw(document.getElementById("paper-canvas"));
  else drawPaper(document.getElementById("paper-canvas"), it.paper, it.sloppy, it.seed);
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
  if (rebindAction) { captureRebind(e); return; }
  const key = canonKey(e.key.toLowerCase());
  if (state.phase === "breaker") {
    if (key >= "1" && key <= "5") pressBreaker(+key - 1);
    return;
  }

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

  if ((key === "tab" || key === "i") && !e.repeat) {
    e.preventDefault();
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
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", "shift"].includes(key)) {
    e.preventDefault();
    keys.add(key);
  }
  if (key === "e") handleInteract();
  if (key === "c" && !e.repeat) state.crouch = !state.crouch; // press C to crouch, press again to stand
  if (key === "f") toggleFlashlight();
});

window.addEventListener("blur", () => keys.clear());
window.addEventListener("keyup", (e) => {
  keys.delete(canonKey(e.key.toLowerCase()));
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

const ENTITY_SPAWN_DELAY = 8; // seconds after the hall door opens
const ENTITY_SPEED_DARK = 1.3; // how fast it creeps when you've only just lost the light
const ENTITY_SPEED_RUSH = 6.4; // where it ends up if you stay in the dark: far faster than you
const ENTITY_DARK_RAMP = 7; // seconds in the dark to reach full rush
const ENTITY_SPEED_WATCHING = 0.25;
const ENTITY_STARE_LIMIT = 10; // seconds of staring (light on it) before it gives up and vanishes
const ENTITY_CATCH_DIST = 0.85;
const ENTITY_BEAM_COS = 0.96; // matches the small beam (about 16 degrees)
const ENTITY_BEAM_RANGE = 9;
const ENTITY_SPAWNS_BY_LEVEL = [
  [[3.0, 9.5], [13.5, 9.5], [8.5, 9.0], [2.0, 12.0], [17.5, 10.5], [7.5, 5.5], [12.5, 6.0], [17.5, 6.0]], // ground floor
  [[27.5, 6.5], [33.5, 6.5], [39.5, 6.5], [44.0, 6.5], [35.5, 5.5], [30.5, 7.5], [41.5, 5.5], [25.5, 5.5]], // second floor corridor
  [[52.5, 3.5], [56.5, 3.5], [51.5, 9.5], [53.0, 10.8], [51.5, 3.0]], // basement
];
const ENTITY_SPAWNS = ENTITY_SPAWNS_BY_LEVEL[0];
// 0 = ground floor, 1 = second floor, 2 = basement (they sit side by side on the map)
function levelOf(x) {
  return x < 21 ? 0 : x < 46 ? 1 : 2;
}

// ---- the model: a tall, starved figure in a ragged coat, hunched, arms to its knees ----
const entityGroup = new THREE.Group();
const entityParts = {};
// ---- the creature: a pale, starved crawler with two screaming faces and long black-clawed limbs ----
function makeSkinTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = "#b9b8ae";
  x.fillRect(0, 0, 256, 256);
  const blot = (n, rgb, a0, a1, r0, r1) => {
    for (let i = 0; i < n; i++) {
      const px = Math.random() * 256, py = Math.random() * 256, r = r0 + Math.random() * (r1 - r0);
      const gr = x.createRadialGradient(px, py, 0, px, py, r);
      const a = a0 + Math.random() * (a1 - a0);
      gr.addColorStop(0, "rgba(" + rgb + "," + a + ")");
      gr.addColorStop(1, "rgba(" + rgb + ",0)");
      x.fillStyle = gr;
      x.fillRect(px - r, py - r, r * 2, r * 2);
    }
  };
  blot(60, "60,60,58", 0.05, 0.16, 10, 36); // mottled grey
  blot(16, "100,70,90", 0.08, 0.18, 8, 26); // bruising
  blot(30, "225,225,215", 0.06, 0.14, 8, 28); // dry, bleached patches
  blot(12, "20,18,16", 0.12, 0.26, 4, 14); // grime
  x.lineWidth = 1;
  for (let i = 0; i < 26; i++) { // veins
    x.strokeStyle = "rgba(70,84,104," + (0.18 + Math.random() * 0.2) + ")";
    x.beginPath();
    let px = Math.random() * 256, py = Math.random() * 256;
    x.moveTo(px, py);
    for (let k = 0; k < 4; k++) { px += (Math.random() - 0.5) * 50; py += (Math.random() - 0.5) * 50; x.quadraticCurveTo(px + (Math.random() - 0.5) * 30, py + (Math.random() - 0.5) * 30, px, py); }
    x.stroke();
  }
  for (let i = 0; i < 400; i++) { x.fillStyle = "rgba(0,0,0," + Math.random() * 0.05 + ")"; x.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2); } // pores
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
let creatureSkinTex = null;
function makeCreature(s) {
  const grp = new THREE.Group();
  const body = new THREE.Group();
  grp.add(body);
  if (!creatureSkinTex) creatureSkinTex = makeSkinTexture();
  const skin = new THREE.MeshStandardMaterial({ color: 0x8e8c84, map: creatureSkinTex, bumpMap: creatureSkinTex, bumpScale: 2.2, roughness: 0.62, metalness: 0.0 });
  // a cold rim of light so its outline reads against the dark, even where the beam doesn't reach
  skin.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n float rimF = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 2.6);\n totalEmissiveRadiance += vec3(0.30, 0.42, 0.62) * rimF * 0.4;"
    );
  };
  skin.customProgramCacheKey = () => "creatureRim";
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.45, metalness: 0.2 });
  const flesh = new THREE.MeshStandardMaterial({ color: 0x7a6a68, map: creatureSkinTex, roughness: 0.7 });
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const ell = (rx, ry, rz, mat, x, y, z, parent, seg) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, seg || 16, Math.max(8, (seg || 16) - 4)), mat);
    m.scale.set(rx, ry, rz);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const cyl = (rt, rb, len, mat, x, y, z, parent) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, 8), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  // torso: ribby, with a ridge of spine down the back
  ell(0.2 * s, 0.17 * s, 0.5 * s, skin, 0, 0.72 * s, 0, body, 20);
  for (let i = 0; i < 7; i++) {
    const z = -0.34 + i * 0.115;
    const f = Math.sqrt(Math.max(0.05, 1 - Math.pow(z / 0.5, 2)));
    const rib = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 6, 18), flesh);
    rib.scale.set(0.205 * f * s, 0.175 * f * s, 1);
    rib.position.set(0, 0.72 * s, z * s);
    body.add(rib);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.022 * s, 0.075 * s, 6), skin);
    sp.position.set(0, (0.72 + 0.175 * f) * s, z * s);
    body.add(sp);
  }
  // four long limbs, elbows up high like a spider's
  const limbs = [];
  [[-1, 0.32], [1, 0.32], [-1, -0.3], [1, -0.3]].forEach(([side, z]) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.17 * s, 0.74 * s, z * s);
    shoulder.rotation.z = side * 2.2;
    body.add(shoulder);
    ell(0.06 * s, 0.06 * s, 0.06 * s, skin, 0, 0, 0, shoulder, 10);
    cyl(0.04 * s, 0.028 * s, 0.55 * s, skin, 0, -0.275 * s, 0, shoulder);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.55 * s, 0);
    elbow.rotation.z = -side * 1.95;
    shoulder.add(elbow);
    ell(0.042 * s, 0.042 * s, 0.042 * s, skin, 0, 0, 0, elbow, 10);
    cyl(0.026 * s, 0.014 * s, 0.95 * s, skin, 0, -0.475 * s, 0, elbow);
    const hand = new THREE.Group();
    hand.position.set(0, -0.95 * s, 0);
    hand.rotation.x = -0.7;
    elbow.add(hand);
    ell(0.05 * s, 0.025 * s, 0.06 * s, dark, 0, 0, 0.03 * s, hand, 10);
    for (let f = 0; f < 5; f++) { // long, black, double-jointed fingers
      const fg = new THREE.Group();
      fg.position.set((f - 2) * 0.022 * s, -0.01 * s, 0.07 * s);
      fg.rotation.z = (f - 2) * 0.2;
      fg.rotation.x = -0.25;
      hand.add(fg);
      cyl(0.009 * s, 0.007 * s, 0.1 * s, dark, 0, -0.05 * s, 0, fg);
      const tip = new THREE.Group();
      tip.position.set(0, -0.1 * s, 0);
      tip.rotation.x = -0.6;
      fg.add(tip);
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.008 * s, 0.16 * s, 6), dark);
      claw.position.y = -0.08 * s;
      claw.rotation.x = Math.PI;
      tip.add(claw);
    }
    limbs.push({ shoulder, elbow, side });
  });
  // two heads on stalks, mouths stretched in a scream
  const heads = [];
  [[-0.1, 0.78, 0.55, 0.07, 1.0], [0.19, 0.92, 0.42, -0.22, 1.12]].forEach(([x, y, z, tilt, k]) => {
    const neck = cyl(0.04 * s, 0.05 * s, 0.4 * s, skin, x * 0.6 * s, (y - 0.05) * s, (z - 0.2) * s, body);
    neck.rotation.x = Math.PI / 2 - 0.12;
    const g = new THREE.Group();
    g.position.set(x * s, y * s, z * s);
    g.rotation.z = tilt;
    g.rotation.x = 0.35;
    body.add(g);
    const K = s * k;
    ell(0.1 * K, 0.14 * K, 0.11 * K, skin, 0, 0, 0, g, 22);
    [-1, 1].forEach((sd) => ell(0.03 * K, 0.025 * K, 0.03 * K, skin, sd * 0.062 * K, -0.02 * K, 0.075 * K, g, 10)); // cheekbones
    ell(0.09 * K, 0.018 * K, 0.04 * K, flesh, 0, 0.07 * K, 0.088 * K, g, 10); // heavy brow
    [-0.042, 0.042].forEach((ex) => {
      ell(0.03 * K, 0.04 * K, 0.025 * K, black, ex * K, 0.035 * K, 0.092 * K, g, 12); // deep, empty sockets
      const tear = new THREE.Mesh(new THREE.BoxGeometry(0.008 * K, 0.1 * K, 0.006 * K), black);
      tear.position.set(ex * 1.15 * K, -0.04 * K, 0.1 * K);
      g.add(tear);
    });
    [-0.012, 0.012].forEach((nx) => ell(0.006 * K, 0.012 * K, 0.006 * K, black, nx * K, -0.02 * K, 0.108 * K, g, 6));
    const jaw = new THREE.Group();
    jaw.position.set(0, -0.06 * K, 0.03 * K);
    g.add(jaw);
    const mouth = ell(0.05 * K, 0.075 * K, 0.03 * K, black, 0, -0.04 * K, 0.07 * K, jaw, 14);
    const lips = new THREE.Mesh(new THREE.TorusGeometry(1, 0.2, 6, 16), flesh);
    lips.scale.set(0.055 * K, 0.08 * K, 0.05 * K);
    lips.position.set(0, -0.04 * K, 0.085 * K);
    jaw.add(lips);
    ell(0.07 * K, 0.04 * K, 0.06 * K, skin, 0, -0.12 * K, 0.025 * K, jaw, 12);
    heads.push({ g, jaw, mouth, tilt, twitch: 0, target: 0 });
  });
  grp.userData = { body, limbs, heads, skin };
  return grp;
}
function animateCreature(c, t, speed, near, frozen) {
  if (!c || !c.limbs) return;
  const gait = t * (3 + speed * 2.2);
  const amp = frozen ? 0 : Math.min(0.6, 0.15 + speed * 0.14);
  c.limbs.forEach((l, i) => {
    const ph = i === 0 || i === 3 ? 0 : Math.PI;
    const sw = Math.sin(gait + ph);
    l.shoulder.rotation.x = frozen ? (i < 2 ? -0.4 : 0.3) + Math.sin(t * 40 + i) * 0.015 : sw * amp;
    l.elbow.rotation.z = -l.side * (1.95 + (frozen ? 0.15 : Math.max(0, sw) * 0.3));
  });
  c.body.position.y = frozen ? 0 : Math.abs(Math.sin(gait)) * 0.03;
  c.body.rotation.z = frozen ? 0 : Math.sin(gait) * 0.03;
  c.heads.forEach((h, i) => {
    if (Math.random() < 0.02) h.target = (Math.random() - 0.5) * (frozen ? 0.15 : 0.6);
    h.twitch += (h.target - h.twitch) * 0.25;
    h.g.rotation.z = h.tilt + h.twitch;
    h.g.rotation.x = 0.35 + near * 0.2 - (frozen ? 0.5 : 0);
    const open = 0.35 + near * 0.5 + (frozen ? 0.5 : 0) + Math.max(0, Math.sin(t * (30 + i * 7))) * 0.08;
    h.jaw.rotation.x = open;
    h.mouth.scale.y = 0.075 * (0.8 + open * 0.8) * 1;
  });
}

Object.assign(entityParts, (function () {
  const c = makeCreature(1.15);
  entityGroup.add(c);
  entityGroup.visible = false;
  scene.add(entityGroup);
  return c.userData;
})());

let entityAnimT = 0;
let entityTwitch = 0;
let entityTwitchTarget = 0;
let entityTension = 0; // 0-1, drives the building music

function animateEntity(dt, speed, near, frozen) {
  entityAnimT += dt;
  animateCreature(entityParts, entityAnimT, speed, near, !!frozen);
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
      if (dc && dr && (!cellFree(c + dc, r) || !cellFree(c, r + dr))) continue; // no squeezing through wall corners
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


// ---- the breaker: a fuse panel you have to set right before the thing in the dark reaches you ----
const BREAKER_TIME = 24; // seconds until it arrives
const BREAKER_SIZE = 5;
let breakerEl = null;
function buildBreakerUI() {
  if (breakerEl) return;
  const wrap = document.createElement("div");
  wrap.id = "breaker-overlay";
  wrap.style.cssText = "position:fixed;inset:0;z-index:80;background:rgba(0,0,0,0.88);display:none;align-items:center;justify-content:center;user-select:none;";
  const panel = document.createElement("div");
  panel.style.cssText = "width:min(560px,92vw);padding:26px 26px 22px;background:linear-gradient(160deg,#4a4c47,#30322f);border:3px solid #1b1c1a;border-radius:6px;box-shadow:0 10px 40px #000,inset 0 0 40px #0008;";
  const lamps = document.createElement("div");
  lamps.style.cssText = "display:flex;justify-content:space-around;margin-bottom:22px;";
  const switches = document.createElement("div");
  switches.style.cssText = "display:flex;justify-content:space-around;";
  wrap._lamps = [];
  wrap._levers = [];
  for (let i = 0; i < BREAKER_SIZE; i++) {
    const lamp = document.createElement("div");
    lamp.style.cssText = "width:34px;height:34px;border-radius:50%;border:3px solid #151513;transition:background 0.12s,box-shadow 0.12s;";
    lamps.appendChild(lamp);
    wrap._lamps.push(lamp);
    const slot = document.createElement("div");
    slot.style.cssText = "width:56px;height:130px;background:#1b1c1a;border:3px solid #0e0e0d;border-radius:5px;position:relative;cursor:pointer;box-shadow:inset 0 0 12px #000;";
    const lever = document.createElement("div");
    lever.style.cssText = "position:absolute;left:8px;width:34px;height:56px;background:linear-gradient(90deg,#b9b6a8,#8f8c80);border-radius:4px;border:2px solid #25241f;transition:top 0.1s;box-shadow:0 3px 6px #000a;";
    slot.appendChild(lever);
    slot.addEventListener("mousedown", (e) => { e.preventDefault(); pressBreaker(i); });
    switches.appendChild(slot);
    wrap._levers.push(lever);
  }
  const barWrap = document.createElement("div");
  barWrap.style.cssText = "margin-top:22px;height:8px;background:#151513;border-radius:4px;overflow:hidden;";
  const bar = document.createElement("div");
  bar.style.cssText = "height:100%;width:100%;background:#a3201a;";
  barWrap.appendChild(bar);
  wrap._bar = bar;
  panel.append(lamps, switches, barWrap);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);
  breakerEl = wrap;
}
function renderBreaker() {
  const b = state.breaker;
  breakerEl._lamps.forEach((l, i) => {
    l.style.background = b.on[i] ? "#4fe06a" : "#4a1210";
    l.style.boxShadow = b.on[i] ? "0 0 16px #4fe06a" : "none";
  });
  breakerEl._levers.forEach((l, i) => (l.style.top = b.on[i] ? "8px" : "62px"));
}
function openBreaker() {
  buildBreakerUI();
  const p = yawObject.position;
  const e = state.entity;
  // it comes from the furthest place it can still walk to you from
  let best = null;
  let bestLen = -1;
  const blvl = levelOf(p.x);
  ENTITY_SPAWNS_BY_LEVEL[blvl].forEach(([x, z]) => {
    if (!cellFree(Math.floor(x), Math.floor(z))) return;
    const path = entityPath(x, z, p.x, p.z);
    if (path && path.length > bestLen) {
      bestLen = path.length;
      best = [x, z];
    }
  });
  if (best) {
    e.x = best[0];
    e.z = best[1];
    e.mode = "active";
    e.level = blvl;
    e.dark = 0;
    e.path = null;
    e.repath = 0;
    state.flags.entitySeen = true;
  } else {
    e.mode = "gone"; // nothing can reach you right now; only the clock is left
    e.timer = 99;
  }
  // every lamp lit is the goal. Each switch also throws its neighbours, so it takes some working out.
  const on = new Array(BREAKER_SIZE).fill(true);
  const idx = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5).slice(0, 3);
  idx.forEach((i) => [i - 1, i, i + 1].forEach((j) => { if (j >= 0 && j < BREAKER_SIZE) on[j] = !on[j]; }));
  if (on.every(Boolean)) on[2] = false;
  state.breaker = { t: 0, on, L0: Math.max(6, bestLen - 1), done: false };
  state.phase = "breaker";
  keys.clear();
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  breakerEl.style.display = "flex";
  breakerEl._bar.style.width = "100%";
  renderBreaker();
  playClick();
}
function closeBreaker() {
  if (breakerEl) breakerEl.style.display = "none";
  state.breaker = null;
}
function pressBreaker(i) {
  const b = state.breaker;
  if (!b || b.done || state.phase !== "breaker") return;
  [i - 1, i, i + 1].forEach((j) => { if (j >= 0 && j < BREAKER_SIZE) b.on[j] = !b.on[j]; });
  playClick();
  renderBreaker();
  if (b.on.every(Boolean)) {
    b.done = true;
    setTimeout(playKnock, 120);
    setTimeout(() => {
      if (state.phase !== "breaker") return;
      closeBreaker();
      state.phase = "explore";
      restorePower();
      renderer.domElement.requestPointerLock();
    }, 450);
  }
}
function updateBreaker(dt) {
  const b = state.breaker;
  if (state.phase !== "breaker" || !b || b.done) return;
  b.t += dt;
  breakerEl._bar.style.width = Math.max(0, 100 - (b.t / BREAKER_TIME) * 100) + "%";
  if (b.t >= BREAKER_TIME) {
    closeBreaker();
    caughtByEntity();
  }
}
function restorePower() {
  state.flags.powerOn = true;
  if (state.entity.mode === "active") {
    state.entity.mode = "vanishing"; // the light burns it off
    state.entity.timer = 0.9;
    playVanish();
  } else {
    state.entity.mode = "gone"; // gone from here; it will turn up upstairs or below
    state.entity.timer = 14;
  }
  playClick();
  setTimeout(playKnock, 200);
  buildWorld();
}

function caughtByEntity() {
  if (breakerEl) breakerEl.style.display = "none";
  state.breaker = null;
  state.phase = "caught";
  markScare();
  state.entity.mode = "done";
  keys.clear();
  playSting();
  voiceCool = 0;
  playVoice("whimper", 0.9, 1);
  setFear(1);
  entityTension = 0;
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  document.getElementById("caught-overlay").classList.remove("hidden");
}

// Move with wall collision (per axis, like the player), so it can never end up inside a wall.
function entityStep(e, mx, mz) {
  const r = 0.22;
  const ox = e.x, oz = e.z;
  if (!isWall(e.x + mx + Math.sign(mx || 1) * r, e.z)) e.x += mx;
  if (!isWall(e.x, e.z + mz + Math.sign(mz || 1) * r)) e.z += mz;
  if (isWall(e.x, e.z)) { e.x = ox; e.z = oz; } // never end up inside a wall
}

function updateEntity(dt) {
  const e = state.entity;
  entityTension = 0;
  const breaking = state.phase === "breaker";
  if ((state.phase !== "explore" && !breaking) || state.flags.tut === "open") return;
  if (e.mode === "vanishing") {
    // the lights came on: it flickers, shrinks and is gone
    e.timer -= dt;
    entityGroup.visible = Math.random() > 0.35 && e.timer > 0;
    entityGroup.scale.y = Math.max(0.05, e.timer / 0.9);
    setFear(Math.max(0, e.timer / 0.9) * 0.5);
    if (e.timer <= 0) {
      e.mode = "gone";
      e.timer = 12; // it will find you again
      entityGroup.visible = false;
      entityGroup.scale.set(1, 1, 1);
      setFear(0);
    }
    return;
  }
  // Before the power is on it haunts the ground floor. Once the lights are on it can only be
  // upstairs or in the basement.
  const lvl = levelOf(yawObject.position.x);
  const haunted = state.flags.powerOn ? lvl >= 1 : lvl === 0 || state.phase === "breaker";
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
  const inBeam = !breaking && entityInBeam(e); // both hands are on the panel: no light, no beam
  const lit = (!breaking && hasFlashlightOn()) || groundLit();

  // the longer you stay in the dark, the faster it comes
  if (inBeam) e.dark = Math.max(0, (e.dark || 0) - dt * 3);
  else if (!lit) e.dark = (e.dark || 0) + dt;
  else e.dark = Math.max(0, (e.dark || 0) - dt);
  const k = Math.min(1, e.dark / ENTITY_DARK_RAMP);
  // stare at it too long and it can't bear the light: it flickers out
  if (inBeam) {
    e.stare = (e.stare || 0) + dt;
    if (!e.wasBeam) playFreeze();
  } else e.stare = Math.max(0, (e.stare || 0) - dt * 0.6);
  e.wasBeam = inBeam;
  if (e.stare >= ENTITY_STARE_LIMIT) {
    e.stare = 0;
    e.mode = "vanishing";
    e.timer = 0.9;
    return;
  }

  let speed;
  let dir = 1;
  if (inBeam) {
    speed = 0; // caught in the light: it freezes, screaming
    state.flags.entityRecoiled = true;
  } else if (lit) {
    speed = ENTITY_SPEED_WATCHING + k * 0.5;
  } else {
    speed = ENTITY_SPEED_DARK + k * k * (ENTITY_SPEED_RUSH - ENTITY_SPEED_DARK);
  }

  if (breaking && state.breaker) {
    // it arrives exactly as the time runs out, getting faster the whole way
    const b = state.breaker;
    speed = (b.L0 / BREAKER_TIME) * (0.5 + Math.min(1, b.t / BREAKER_TIME));
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
      if (e.path.length === 2 && Math.hypot(p.x - e.x, p.z - e.z) < 1.2 && hasLineOfSight(e.x, e.z, p.x, p.z)) {
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
  entityGroup.position.set(e.x + (inBeam ? (Math.random() - 0.5) * 0.03 : 0), 0, e.z + (inBeam ? (Math.random() - 0.5) * 0.03 : 0));
  entityGroup.rotation.y = Math.atan2(p.x - e.x, p.z - e.z);
  entityGroup.scale.set(1, 1, 1);
  entityGroup.visible = true;
  animateEntity(dt, speed, near, inBeam);

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
  const sv = readSave();
  if (sv) applySave(sv);
  else {
    resetRun();
    enterExplore();
  }
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

// ---- the cellar maze: lever gate, wall decor, and the husks that live in it ------------------------
const LEVER_COLORS = [0xc02a22, 0x2a54c8, 0xd6b624];
function wallSpot(c, r, side, off) {
  if (side === "N") return { x: c + 0.5, z: r + off, ry: 0 };
  if (side === "S") return { x: c + 0.5, z: r + 1 - off, ry: Math.PI };
  if (side === "W") return { x: c + off, z: r + 0.5, ry: Math.PI / 2 };
  return { x: c + 1 - off, z: r + 0.5, ry: -Math.PI / 2 };
}
function closedSides(c, r) {
  const out = [];
  [["N", 0, -1], ["S", 0, 1], ["W", -1, 0], ["E", 1, 0]].forEach(([s, dc, dr]) => {
    if (MAP[r + dr] && MAP[r + dr][c + dc] === 1) out.push(s);
  });
  return out;
}
function drawEyesTex(seed) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const x = c.getContext("2d");
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 14; i++) {
    const ex = 20 + rnd() * 216, ey = 16 + rnd() * 96, w = 10 + rnd() * 14;
    x.fillStyle = "#cfc6a8"; x.beginPath(); x.ellipse(ex, ey, w, w * 0.45, 0, 0, 6.3); x.fill();
    x.fillStyle = "#7a1010"; x.beginPath(); x.arc(ex + (rnd() - 0.5) * w * 0.4, ey, w * 0.32, 0, 6.3); x.fill();
    x.fillStyle = "#050202"; x.beginPath(); x.arc(ex, ey, w * 0.14, 0, 6.3); x.fill();
  }
  return c;
}
function drawHandsTex(seed) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const x = c.getContext("2d");
  x.fillStyle = "#4a0a0a";
  for (let h = 0; h < 3; h++) {
    const hx = 22 + h * 38, hy = 56 + ((h * seed) % 3) * 8;
    x.beginPath(); x.ellipse(hx, hy + 18, 13, 16, 0.1 * h, 0, 6.3); x.fill();
    for (let f = 0; f < 4; f++) { x.fillRect(hx - 12 + f * 7, hy - 14 - (f % 3) * 4, 5, 22); }
    x.fillRect(hx - 22, hy + 6, 14, 6);
    x.fillRect(hx - 6, hy + 30, 8, 60); // a drip
  }
  return c;
}
function addCellarMaze() {
  if (typeof CELLAR === "undefined") return;
  const gate = CELLAR.gate;
  const gx = gate.c + 0.5;
  // iron gate: bars drop to the floor until the levers raise it; the lintel shows the colour order
  const bar = 0x2a2724;
  if (!state.flags.gateOpen) {
    for (let i = 0; i < 7; i++) addBox(0.05, 2.7, 0.05, gx, 1.35, gate.r + 0.1 + i * 0.133, bar);
    [0.4, 1.3, 2.2].forEach((y) => addBox(0.06, 0.06, 1.0, gx, y, gate.r + 0.5, bar));
  } else {
    for (let i = 0; i < 7; i++) addBox(0.05, 0.4, 0.05, gx, 2.5, gate.r + 0.1 + i * 0.133, bar);
  }
  addBox(0.14, 0.4, 1.0, gx, 2.7, gate.r + 0.5, 0x1e1b19);
  CELLAR.order.forEach((col, i) => addBox(0.03, 0.2, 0.2, gx - 0.09, 2.7, gate.r + 0.2 + i * 0.3, LEVER_COLORS[col]));
  const gl = new THREE.PointLight(0xffa850, 0.55, 3.6, 2);
  gl.position.set(gx - 0.6, 2.4, gate.r + 0.5);
  worldGroup.add(gl);
  flickerLights.push({ light: gl, base: 0.55, phase: 1.3 });
  [[57.5, 3.5, 0xff3a1a, 0.5], [61.5, 6.5, 0xff5a2a, 0.6]].forEach(([x, z, col, base], i) => {
    const l = new THREE.PointLight(col, base, 4.2, 2);
    l.position.set(x, 2.5, z);
    worldGroup.add(l);
    flickerLights.push({ light: l, base, phase: 4 + i * 2.7 });
    addBox(0.08, 0.2, 0.08, x, 2.6, z, 0x1a1816);
  });
  // levers: coloured handles on the dead-end walls; pulled ones are down
  const seq = state.flags.leverSeq || [];
  CELLAR.levers.forEach((lv, i) => {
    const sp = wallSpot(lv.c, lv.r, lv.side, 0.04);
    const grp = new THREE.Group();
    grp.position.set(sp.x, 1.35, sp.z);
    grp.rotation.y = sp.ry;
    grp.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.42, 0.04), new THREE.MeshStandardMaterial({ color: 0x2e2c2a, roughness: 0.7, metalness: 0.4 })));
    const arm = new THREE.Group();
    arm.position.z = 0.04;
    arm.rotation.x = seq.includes(i) ? 0.9 : -0.9;
    const stick = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.32, 0.035), new THREE.MeshStandardMaterial({ color: 0x77736c, metalness: 0.5, roughness: 0.5 }));
    stick.position.y = 0.16;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), new THREE.MeshStandardMaterial({ color: LEVER_COLORS[lv.color], roughness: 0.5 }));
    knob.position.y = 0.34;
    arm.add(stick, knob);
    grp.add(arm);
    worldGroup.add(grp);
  });
  // eyes in the walls, handprints low down
  const eyeMats = [1, 2, 3].map((s) => new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawEyesTex(s)), transparent: true, roughness: 1 }));
  const handMat = new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawHandsTex(2)), transparent: true, roughness: 1 });
  const decorCells = CELLAR.husks.concat(CELLAR.notes);
  decorCells.forEach((h, i) => {
    const sides = closedSides(h.c, h.r);
    if (!sides.length) return;
    const sp = wallSpot(h.c, h.r, sides[i % sides.length], 0.02);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.48), i % 3 === 2 ? handMat : eyeMats[i % 3]);
    if (i % 3 === 2) m.scale.set(0.8, 1.6, 1);
    m.position.set(sp.x, i % 3 === 2 ? 0.85 : 1.8, sp.z);
    m.rotation.y = sp.ry;
    worldGroup.add(m);
  });
  // things hanging in the chamber, up where the flashlight finds them
  [[60.7, 5.6], [61.9, 6.5], [60.9, 7.4]].forEach(([x, z], i) => {
    const grp = new THREE.Group();
    grp.position.set(x, 3.0, z);
    const rope = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.5, 0.02), new THREE.MeshStandardMaterial({ color: 0x2a2018 }));
    rope.position.y = -0.25;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.62, 0.2), new THREE.MeshStandardMaterial({ color: 0x5a5244, roughness: 1 }));
    body.position.y = -0.8;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), new THREE.MeshStandardMaterial({ color: 0xcbbfa6, roughness: 0.8 }));
    head.position.y = -0.44;
    grp.add(rope, body, head);
    worldGroup.add(grp);
    swayers.push({ grp, phase: i * 1.9 + 0.4 });
  });
}

// the husks: starved things that sleep in the maze. The light freezes them; the axe finishes them.
function makeHuskMesh() {
  return makeCreature(0.8);
}
function ensureHusks() {
  if (husks.length || typeof CELLAR === "undefined") return;
  CELLAR.husks.forEach((h, i) => {
    const mesh = makeHuskMesh();
    const o = { mesh, x: h.c + 0.5, z: h.r + 0.5, kind: h.kind, hp: 2, mode: "dormant", frozen: 0, stun: 0, wake: 0, y: h.kind === "hang" ? 1.4 : 0.12, vy: 0, t: Math.random() * 6, trig: i === 0 ? 3.4 : 2.5, path: null, repath: 0 };
    mesh.position.set(o.x, o.y, o.z);
    if (h.kind === "crawl") mesh.scale.y = 0.4; // curled up on the floor
    scene.add(mesh);
    husks.push(o);
  });
}
function clearHusks() {
  husks.forEach((h) => { scene.remove(h.mesh); if (h.stain) scene.remove(h.stain); });
  husks = [];
}
function playSplat() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const n = audioCtx.createBufferSource();
  const lp = audioCtx.createBiquadFilter();
  const ng = audioCtx.createGain();
  n.buffer = noiseBuf; n.loop = true;
  lp.type = "lowpass"; lp.frequency.setValueAtTime(1400, t); lp.frequency.exponentialRampToValueAtTime(200, t + 0.25);
  ng.gain.setValueAtTime(0.5, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  n.connect(lp).connect(ng).connect(audioCtx.destination);
  n.start(t); n.stop(t + 0.32);
}
function playFreeze() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const n = audioCtx.createBufferSource();
  const hp = audioCtx.createBiquadFilter();
  const ng = audioCtx.createGain();
  n.buffer = noiseBuf; n.loop = true;
  hp.type = "highpass"; hp.frequency.value = 5200;
  ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(0.18, t + 0.04); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  n.connect(hp).connect(ng).connect(audioCtx.destination);
  n.start(t); n.stop(t + 0.4);
}
function wakeHusk(h) {
  if (h.mode !== "dormant") return;
  h.mode = "waking";
  markScare();
  h.wake = h.kind === "hang" ? 0.9 : 0.5;
  playBang();
  playVoice("gasp2", 0.8, 3);
  scareBlackout = 0.5;
  doorShake = 0.4;
  if (h.kind === "crawl") playScreech();
}
function pullLever(h) {
  const seq = state.flags.leverSeq || (state.flags.leverSeq = []);
  if (seq.includes(h.lever)) return;
  seq.push(h.lever);
  playWoodCrack();
  const k = seq.length - 1;
  if (CELLAR.order[k] !== h.lever) {
    // wrong: everything slams back up, and the maze hears it
    setTimeout(() => {
      playBang();
      state.flags.leverSeq = [];
      state.flags.huskAlarm = true;
      scareBlackout = 1.1;
      doorShake = 0.5;
      buildWorld();
    }, 450);
    return;
  }
  if (seq.length === CELLAR.order.length) {
    state.flags.gateOpen = true;
    setTimeout(() => { playBang(); playWoodCrack(); }, 500);
    setTimeout(() => { doorShake = 0.6; }, 520);
  }
  buildWorld();
}
function hitHusk() {
  const p = yawObject.position;
  const fx = -Math.sin(yawObject.rotation.y);
  const fz = -Math.cos(yawObject.rotation.y);
  let hit = false;
  husks.forEach((h) => {
    if (h.mode === "dead") return;
    const dx = h.x - p.x, dz = h.z - p.z, d = Math.hypot(dx, dz) || 1;
    if (d > 1.9 || (dx * fx + dz * fz) / d < 0.45 || !hasLineOfSight(p.x, p.z, h.x, h.z)) return;
    hit = true;
    if (h.mode === "dormant") { h.mode = "awake"; h.y = 0; h.mesh.scale.y = 1; }
    h.hp -= h.frozen > 0 ? 2 : 1;
    playSplat();
    if (h.hp <= 0) {
      h.mode = "dead";
      h.mesh.scale.y = 0.22;
      h.mesh.position.set(h.x, 0, h.z);
      const st = new THREE.Mesh(new THREE.CircleGeometry(0.7, 14), new THREE.MeshBasicMaterial({ color: 0x2a0606 }));
      st.rotation.x = -Math.PI / 2;
      st.position.set(h.x, 0.012, h.z);
      scene.add(st);
      h.stain = st;
      state.flags.huskKills = (state.flags.huskKills || 0) + 1;
    } else {
      h.stun = 1.0;
      entityStep(h, (dx / d) * 0.7, (dz / d) * 0.7);
    }
  });
  return hit;
}
function updateHusks(dt) {
  if (state.phase !== "explore" || state.flags.tut === "open" || state.flags.finale) return;
  const p = yawObject.position;
  if (levelOf(p.x) !== 2) return;
  ensureHusks();
  let near = 0;
  husks.forEach((h) => {
    const m = h.mesh;
    const ud = m.userData;
    h.t += dt;
    const dx = p.x - h.x, dz = p.z - h.z, d = Math.hypot(dx, dz);
    if (h.mode === "dead") return;
    if (h.mode === "dormant") {
      if (h.kind === "hang") { m.position.y = h.y + Math.sin(h.t * 1.3) * 0.03; m.rotation.z = Math.sin(h.t * 0.9) * 0.05; }
      else m.position.y = 0.12 + Math.sin(h.t * 1.6) * 0.01; // breathing
      if ((state.flags.huskAlarm || (d < h.trig && hasLineOfSight(p.x, p.z, h.x, h.z))) && sinceScare() > 6) wakeHusk(h);
      return;
    }
    if (h.mode === "waking") {
      h.wake -= dt;
      if (h.kind === "hang") { h.vy -= 14 * dt; h.y = Math.max(0, h.y + h.vy * dt); m.position.y = h.y; }
      else m.scale.y += (1 - m.scale.y) * Math.min(1, dt * 12);
      m.rotation.y = Math.atan2(dx, dz);
      if (h.wake <= 0) { h.mode = "awake"; m.scale.y = 1; m.position.y = 0; h.y = 0; }
      return;
    }
    // awake
    const los = d < 9 && hasLineOfSight(p.x, p.z, h.x, h.z);
    if (entityInBeam(h)) {
      if (h.frozen <= 0) playFreeze();
      h.frozen = 2.6;
    }
    h.frozen = Math.max(0, h.frozen - dt);
    h.stun = Math.max(0, h.stun - dt);
    const frozen = h.frozen > 0;
    ud.skin.color.set(frozen ? 0x6f93bd : 0x8e8c84);
    if (!frozen && h.stun <= 0) {
      const speed = los && d < 4.5 ? 2.9 : 2.2;
      h.repath -= dt;
      if (h.repath <= 0 || !h.path) { h.path = entityPath(h.x, h.z, p.x, p.z); h.repath = 0.25; }
      let tx = p.x, tz = p.z;
      if (h.path && h.path.length > 1) {
        const nx = h.path[1];
        tx = nx[0] + 0.5; tz = nx[1] + 0.5;
        if (h.path.length === 2 && d < 1.2 && hasLineOfSight(h.x, h.z, p.x, p.z)) { tx = p.x; tz = p.z; }
      } else if (!h.path) { tx = h.x; tz = h.z; }
      const mx = tx - h.x, mz = tz - h.z, md = Math.hypot(mx, mz);
      if (md > 0.02) {
        const s = Math.min(speed * dt, md);
        entityStep(h, (mx / md) * s, (mz / md) * s);
        m.rotation.y = Math.atan2(mx, mz);
      }
      animateCreature(ud, h.t, 2.6, 0.7, false);
      if (los) near = Math.max(near, 1 - Math.min(1, d / 7));
      if (d < 0.9 && los) { caughtByEntity(); return; }
    } else if (frozen) {
      m.position.x = h.x + (Math.random() - 0.5) * 0.02; // shivering in the light
      m.position.z = h.z + (Math.random() - 0.5) * 0.02;
      animateCreature(ud, h.t, 0, 0.7, true);
      return;
    }
    m.position.x = h.x; m.position.z = h.z;
  });
  if (near > 0) {
    entityTension = Math.max(entityTension, near);
    const v = document.getElementById("fear-vignette");
    setFear(Math.max(parseFloat(v.style.opacity) || 0, near * 0.7));
  }
}

// ---- main loop -----------------------------------------------------------------

const clock = new THREE.Clock();

// before a run starts there is no game loop: a tiny one just draws the apartment beside the settings menu
function ambienceLoop() {
  applyAmbiencePose();
  try { if (postFX) postFX.render(0.016); else renderer.render(scene, camera); } catch (e) { renderer.render(scene, camera); }
  drawAmbience();
}
function setAmbience(on) {
  if (on === ambience) return;
  ambience = on;
  if (!loopOn) renderer.setAnimationLoop(on ? ambienceLoop : null);
  if (on) {
    if (!worldGroup.children.length) buildWorld(); // title screen has no world yet
    ambSaved = { x: yawObject.position.x, y: yawObject.position.y, z: yawObject.position.z, ry: yawObject.rotation.y, rx: camera.rotation.x };
  } else if (ambSaved) {
    yawObject.position.set(ambSaved.x, ambSaved.y, ambSaved.z);
    yawObject.rotation.y = ambSaved.ry;
    camera.rotation.x = ambSaved.rx;
    ambSaved = null;
  }
}
// a slow, drifting view of apartment 2 by moonlight, only when the player is on the ground floor
function applyAmbiencePose() {
  if (!ambSaved || levelOf(ambSaved.x) !== 0) return;
  const t = performance.now() / 1000;
  yawObject.position.set(7.2 + Math.sin(t * 0.11) * 0.15, EYE_HEIGHT, 3.3);
  yawObject.rotation.y = 0.15 + Math.sin(t * 0.17) * 0.2;
  camera.rotation.x = -0.04 + Math.sin(t * 0.13) * 0.02;
}
function drawAmbience() {
  const cv = document.getElementById("settings-view");
  if (!cv || cv.offsetWidth === 0) return;
  const w = Math.round(cv.offsetWidth * Math.min(1.5, window.devicePixelRatio || 1));
  const h = Math.round(cv.offsetHeight * Math.min(1.5, window.devicePixelRatio || 1));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const src = renderer.domElement;
  if (!src.width || !src.height) return;
  const s = Math.max(w / src.width, h / src.height); // cover
  const dw = src.width * s, dh = src.height * s;
  cv.getContext("2d").drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function gameLoop() {
  const dt = Math.min(0.1, clock.getDelta());
  if (ambience) applyAmbiencePose();
  pollGamepad(dt);
  checkMilestones(dt);
  tryMovePlayer(dt);
  checkJohnRoom();
  updateEntity(dt);
  updateHusks(dt);
  updateFinale(dt);
  updateBreaker(dt);
  updateScares(dt);
  updateFlies(dt);
  updateEntryLook(dt);
  updateOpenAnims(dt);
  updateDoorAnims(dt);
  updateWindowRun(dt);
  updateBedEyes(dt);
  updateFaceScare(dt);
  updateDust(dt);
  updateMusic(dt);
  doorShake = Math.max(0, doorShake - dt);
  if (doorShake > 0) camera.rotation.z += Math.sin(performance.now() / 18) * 0.012 * (doorShake / 0.4);
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
  const ambientTarget = Math.max(0, 0.03 + 0.05 * (state.settings.brightness - 1)); // nearly none: only real lights and the beam show anything
  ambientLight.intensity += (ambientTarget - ambientLight.intensity) * Math.min(1, dt * 4); // no sudden jump at the door

  updateInteractPrompt();
  if (postFX) {
    try {
      postFX.render(dt);
    } catch (e) {
      console.warn("post-processing failed, falling back", e);
      postFX = null;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }
  } else renderer.render(scene, camera);
  if (ambience) drawAmbience();
}

// ---- boot --------------------------------------------------------------------

showScreen("screen-title");