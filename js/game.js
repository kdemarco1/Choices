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
var loopOn = false; // true once the real game loop is running
var ambience = false, ambSaved = null; // settings screen: the game draws an apartment beside the menu
const EYE_HEIGHT = 1.5;
const CROUCH_DROP = 0.95; // hold C: the eyes go this much lower
let stamina = 1, exhausted = false, staminaDelay = 0, loudT = 0; // sprint breath, and how loud the last noise was
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
const MOON_RANGE = 42; // how far you can see out on the lit street
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
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuf;
  const lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = P[0] * (0.85 + Math.random() * 0.3);
  lp.Q.value = P[3];
  const g = audioCtx.createGain();
  const a = P[1] * (quiet ? 0.5 : 1) * (0.85 + Math.random() * 0.3);
  g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(0.001, t + P[2]);
  src.connect(lp).connect(g).connect(audioCtx.destination);
  src.start(t); src.stop(t + P[2] + 0.05);
  if (surf === 3) { // a wet slap on the cellar floor
    const s2 = audioCtx.createBufferSource(), hp = audioCtx.createBiquadFilter(), g2 = audioCtx.createGain();
    s2.buffer = noiseBuf; hp.type = "highpass"; hp.frequency.value = 2500;
    g2.gain.setValueAtTime(a * 0.35, t + 0.03); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    s2.connect(hp).connect(g2).connect(audioCtx.destination); s2.start(t + 0.03); s2.stop(t + 0.12);
  }
}

// A slow, rusty hinge: two sawtooth voices pushed through a resonant filter
// that sweeps as the door turns, chopped by a fast stick-slip pulse, with a
// latch click at the start and a soft thud when it comes to rest.
function playDoorCreak(door) {
  loudT = Math.max(loudT, 0.9);
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
}

// ---- title screen -----------------------------------------------------------

function resetRun() {
  state.transition = null;
  elevAnim = null;
  state.flags = {};
  state.log = [];
  state.inventory = {};
  state.cans = 0; thrown.forEach((t) => scene.remove(t.m)); thrown = [];
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
  state.hiding = null; stamina = 1; exhausted = false; loudT = 0;
  if (typeof resetDirector === "function") resetDirector();
  if (typeof hideEl !== "undefined" && hideEl) hideEl.style.display = "none";
  if (typeof vanishWatcher === "function") { vanishWatcher(true); watchers.cd = 14; }
  closeBreaker();
  state.swing = null;
  walkedDist = 0;
  clearFinale();
  scareBlackout = 0;
  eventTimer = 25;
  lastScareT = -999;
  lastEventKind = "";
  stingIdx = 0;
  voiceCool = 0;
  moveVX = moveVZ = 0;
  setFear(0);
  keys.clear();
  clearCaptions();
}

// repeat players: a second button that skips the story and starts with the flashlight in hand
let quickBtn = null;
function refreshQuickStart() {
  if (!quickBtn) {
    quickBtn = document.createElement("button");
    quickBtn.className = "secondary-button"; quickBtn.textContent = "Quick start (skip intro)";
    document.getElementById("title-start-button").after(quickBtn);
    quickBtn.addEventListener("click", () => {
      initAudio();
      resetRun();
      state.inventory.flashlight = true; state.inventory.hands = true; state.held = "flashlight";
      openingSeen = true; // no opening beat either
      enterExplore();
    });
  }
  let seen = false;
  try { seen = !!localStorage.getItem("hollowhouse.seen"); } catch (e) {}
  quickBtn.style.display = seen ? "" : "none";
}
document.getElementById("title-start-button").addEventListener("click", () => {
  try { localStorage.setItem("hollowhouse.seen", "1"); } catch (e) {}
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
    refreshQuickStart();
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
  refreshQuickStart();
});

// ---- settings screen ---------------------------------------------------------

const SHARP_NAMES = ["Sharp", "Balanced", "Soft (faster)"];
function ensureExtraSettings() {
  if (document.getElementById("toggle-shake")) return;
  const anchor = document.getElementById("toggle-prompts");
  const mk = (label, id, onClick) => {
    const l = document.createElement("label"); l.className = "label"; l.textContent = label; l.htmlFor = id;
    const b = document.createElement("button"); b.id = id; b.className = "toggle-button"; b.addEventListener("click", onClick);
    anchor.after(l); l.after(b);
  };
  mk("Sharpness", "toggle-res", () => { state.settings.res = ((state.settings.res || 0) + 1) % 3; applySettings(); saveSettings(); renderSettings(); });
  mk("Camera shake", "toggle-shake", () => { state.settings.shake = !state.settings.shake; saveSettings(); renderSettings(); });
}
function renderSettings() {
  ensureExtraSettings();
  const shb = document.getElementById("toggle-shake");
  shb.textContent = state.settings.shake ? "On" : "Off"; shb.className = "toggle-button " + (state.settings.shake ? "on" : "off");
  const rsb = document.getElementById("toggle-res");
  rsb.textContent = SHARP_NAMES[state.settings.res || 0]; rsb.className = "toggle-button on";
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
  if (!at) runOpening();
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
  }, 45);
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
      ? vmMat(color)
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

function buildAxeGroup(withHand) {
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
  if (withHand) addViewHand(g, "axe", 1200);
  return g;
}
const heldAxe = buildAxeGroup(true);
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
  if (state.reach) { heldAxe.visible = false; heldFlashlight.visible = false; return; }
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

  // proper streetlights, bright and steady, so the yard, the road and the front of the building can be seen
  brokenLamp = null;
  addStreetLight(2.5, rows - 0.6);
  addStreetLight(10.5, rows - 0.6);
  addStreetLight(18.5, rows - 0.6);
  addStreetLight(6.5, rows + 9.6, -1); // across the road, leaning back over it

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
    else if (it.id === "apt2Key") addKeyModel(it.x, it.h + 0.005, it.y);
    else if (it.id === "axe") addAxeModel(it.x, 0.07, it.y);
    else if (/^handle\d$/.test(it.id)) {
      const hb = addBox(0.3, 0.035, 0.035, it.x, 0.03, it.y, 0x6a6a70); hb.rotation.y = it.x * 3.1;
      const hk = addBox(0.09, 0.07, 0.07, it.x, 0.04, it.y, 0x8a8a92); hk.rotation.y = it.x * 3.1;
    }
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
let f2Tubes = [];
let f2Timer = 0;
function addF2Tubes() {
  f2Tubes = [];
  if (!state.flags.powerOn || levelOf(yawObject.position.x) !== 1) return;
  [25.5, 31, 36.5, 42].forEach((x) => {
    addBox(1.3, 0.05, 0.22, x, WALL_HEIGHT - 0.03, 6.5, 0x9a9a96);
    const out = !!state.flags.f2Out;
    const mat = new THREE.MeshBasicMaterial({ color: out ? 0x1c1d1c : 0xeaf6e0 });
    const tube = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.03, 0.12), mat);
    tube.position.set(x, WALL_HEIGHT - 0.07, 6.5);
    worldGroup.add(tube);
    if (out) return;
    const l = new THREE.PointLight(0xe4f2dc, 9, 12, 2);
    l.position.set(x, WALL_HEIGHT - 0.2, 6.5);
    worldGroup.add(l);
    f2Tubes.push({ l, mat, base: 9 * 1.1 });
  });
}
function updateF2Lights(dt) {
  if (!f2Tubes.length || state.phase !== "explore" || state.transition) return;
  f2Timer += dt;
  const T0 = 2.2, T1 = T0 + 3.4; // steady at first, then a stuttering death
  let k = 1;
  if (f2Timer > T0) {
    const u = f2Timer - T0;
    k = Math.sin(u * 41) * Math.sin(u * 13.7) > 0.1 - u * 0.12 ? 0.05 + Math.random() * 0.2 : 1 - u / 3.4 * 0.5;
  }
  if (f2Timer > T1) {
    state.flags.f2Out = true;
    playBang();
    scareBlackout = 0.35;
    doorShake = 0.25;
    f2Tubes.forEach((t) => { t.l.parent && t.l.parent.remove(t.l); t.mat.color.set(0x1c1d1c); });
    f2Tubes = [];
    return;
  }
  f2Tubes.forEach((t, i) => {
    const kk = i % 2 ? Math.min(1, k * 1.3) : k;
    t.l.intensity = t.base * kk;
    t.mat.color.setRGB(0.92 * kk + 0.05, 0.96 * kk + 0.05, 0.88 * kk + 0.05);
  });
}
function addFluorescents() {
  fluoLights = [];
  f2Timer = 0;
  addF2Tubes();
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
function addStreetLight(x, z, armDir) {
  const dir = armDir == null ? 1 : armDir; // which way the arm reaches (+z = over the road)
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.7, metalness: 0.4 });
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.14, 4.4, 0.14), poleMat);
  pole.position.set(x, 2.2, z);
  worldGroup.add(pole);
  addBox(0.3, 0.25, 0.3, x, 0.12, z, 0x222426); // base
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 1.0), poleMat);
  arm.position.set(x, 4.35, z + 0.5 * dir);
  worldGroup.add(arm);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.3), new THREE.MeshStandardMaterial({ color: 0x3a3c3e, roughness: 0.6 }));
  head.position.set(x, 4.36, z + 1.0 * dir);
  worldGroup.add(head);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 0.24), new THREE.MeshBasicMaterial({ color: 0xfff1cc }));
  glass.position.set(x, 4.29, z + 1.0 * dir);
  worldGroup.add(glass);
  // a soft cone of light you can see falling from it
  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 2.6, 4.2, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffe9b8, transparent: true, opacity: 0.02, depthWrite: false, side: THREE.DoubleSide, fog: false })
  );
  cone.position.set(x, 2.15, z + 1.0 * dir);
  worldGroup.add(cone);
  const lamp = new THREE.PointLight(0xffecc4, 42, 24, 2);
  lamp.position.set(x, 4.1, z + 1.0 * dir);
  worldGroup.add(lamp);
  return lamp;
}

// A creepy old reception desk: a dark, worn desk with a single dim,
// flickering lamp — barely enough light to see the desk itself, let alone
// the room around it.
// Built in its own frame (x along the desk, +z = customer side), then turned so the
// customer side faces east into the lobby and the drawers/chair are on the west-wall side.
// a side table with an old radio
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
  // Boards nailed across the top of the cellar stairs, until they're chopped: wide, pale and obvious.
  if (!state.flags.boardsChopped && yawObject.position.x < 21) {
    const zb = 3.45;
    const base = 0; // across the opening at ground level, whatever the steps below are doing
    [0.25, 0.55, 0.85, 1.15, 1.45].forEach((dy, i) => {
      const plank = addBox(2.6, 0.2, 0.06, 18.3, base + dy, zb - (i % 2) * 0.06, i % 2 ? 0x8a6a42 : 0x7a5a38);
      plank.rotation.z = ((i % 3) - 1) * 0.05;
      [17.25, 18.3, 19.35].forEach((nx) => addBox(0.06, 0.06, 0.03, nx, base + dy, zb + 0.04 - (i % 2) * 0.06, 0x2a2a28)); // nails
    });
    [17.15, 19.45].forEach((px) => addBox(0.12, 1.7, 0.12, px, base + 0.85, zb, 0x4a3420)); // posts the boards are nailed to
    addSolid(18.3, zb, 2.5, 0.35);
    // hazard tape crossed over the boards and a hand-painted warning
    [0.5, -0.5].forEach((a) => { const t = addBox(3.1, 0.09, 0.012, 18.3, base + 0.85, zb + 0.09, 0xd2ab18); t.rotation.z = a * 0.6; });
    const sc = document.createElement("canvas"); sc.width = 256; sc.height = 160;
    const sx = sc.getContext("2d");
    sx.fillStyle = "#c9c2a8"; sx.fillRect(0, 0, 256, 160);
    sx.strokeStyle = "#5a1410"; sx.lineWidth = 8; sx.strokeRect(8, 8, 240, 144);
    sx.fillStyle = "#8a1510"; sx.font = "bold 46px 'Courier New',monospace"; sx.textAlign = "center";
    sx.fillText("DO NOT", 128, 62); sx.fillText("GO DOWN", 128, 112);
    sx.globalAlpha = 0.35; for (let i = 0; i < 60; i++) { sx.fillStyle = "#3a2a18"; sx.fillRect(Math.random() * 256, Math.random() * 160, 3, 1 + Math.random() * 6); }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.31), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(sc), roughness: 0.9 }));
    sign.position.set(18.05, 1.5, zb + 0.1);
    sign.rotation.z = -0.06;
    worldGroup.add(sign);
  }
  // the flight going up, right beside it: the first steps are gone, the rest carries on into the dark
  if (yawObject.position.x < 21) {
    const x0 = 19.85, x1 = 20.95, cx = (x0 + x1) / 2, w = x1 - x0;
    const NS = 12, z0 = 3.9, dz = -0.2208, rise = 2.9;
    for (let i = 0; i < NS; i++) {
      const top = (rise * (i + 1)) / NS;
      const zmid = z0 + dz * (i + 0.5);
      addBox(w, top - 0.05, Math.abs(dz), cx, (top - 0.05) / 2, zmid, 0x1e140d); // dark carcass under the treads
      const rh = rise / NS;
      addBox(w - 0.02, rh, 0.03, cx, top - rh / 2, z0 + dz * i - 0.01 * Math.sign(dz), 0x3f2c1d); // riser
      addBox(w + 0.03, 0.045, Math.abs(dz) + 0.05, cx, top - 0.02, zmid - 0.02, 0x6e4d30); // tread with a lip
      [-0.25, 0.25].forEach((px) => addBox(0.012, 0.005, Math.abs(dz), cx + px, top + 0.004, zmid, 0x2c1d12)); // board seams
    }
    // a closed stringer along the wall side and a skirting board on the open side
    addBox(0.05, 3.3, 3.0, x1 + 0.01, 2.0, 2.4, 0x2a1b12).rotation.x = Math.atan2(2.9, 2.65) * 0;
    addBox(0.04, 0.14, 2.9, x0 - 0.02, 0.07, 2.45, 0x241810);
    // the way up is barricaded with wrecked furniture: a big couch on its end, a toppled dresser, planks and a chair
    const cb = (w_, h_, d_, x_, y_, z_, c_, ry, rz, rx) => { const m = addBox(w_, h_, d_, x_, y_, z_, c_); m.rotation.set(rx || 0, ry || 0, rz || 0); return m; };
    cb(1.0, 0.45, 0.8, 20.4, 0.25, 3.45, 0x4a3a3c, 0.1, 0.0); // couch seat
    cb(1.05, 0.8, 0.22, 20.4, 0.85, 3.05, 0x3e3033, 0.1, 0.0, 0.25); // couch back, tipped against the stairs
    cb(0.2, 0.55, 0.8, 19.95, 0.55, 3.4, 0x3a2c2e, 0.1); // arm
    cb(0.2, 0.55, 0.8, 20.85, 0.5, 3.5, 0x3a2c2e, 0.1); // arm
    cb(0.9, 0.95, 0.5, 20.35, 1.45, 2.55, 0x4a3524, -0.15, 0.2); // dresser wedged on the steps
    cb(0.86, 0.04, 0.46, 20.33, 1.73, 2.5, 0x5a4330, -0.15, 0.2);
    [0.25, 0.65].forEach((dy, i) => cb(0.78, 0.2, 0.03, 20.38 + i * 0.01, 1.2 + dy * 0.7, 2.29, 0x2a1c12, -0.15, 0.2)); // drawer fronts
    cb(0.12, 1.5, 0.05, 20.2, 1.2, 2.0, 0x7a5a38, 0, 0.9); // planks jammed through
    cb(0.12, 1.4, 0.05, 20.6, 1.3, 2.2, 0x6a4a2a, 0, -0.8);
    cb(0.1, 0.9, 0.05, 20.4, 0.6, 3.85, 0x7a5a38, 0.3, 1.1);
    cb(0.45, 0.04, 0.45, 20.7, 0.45, 3.85, 0x4a3a28, 0.6, 0.0, 0.3); // chair seat
    [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]].forEach(([dx, dz]) => cb(0.04, 0.45, 0.04, 20.7 + dx, 0.62, 3.85 + dz, 0x4a3a28, 0.6, dx * 2, 0.3));
    [[20.2, 3.75, 0.4, 0.12], [20.65, 3.2, 0.3, 0.2]].forEach(([x, z, s_, h], i) => {
      const r = addBox(s_, h, s_ * 0.8, x, h / 2, z, i % 2 ? 0x4a4038 : 0x5a5248);
      r.rotation.y = i * 0.8;
    });
    // banister up the open side and a post at the first surviving step
    const rail = addBox(0.07, 0.06, Math.hypot(1.75, 1.9), x0 + 0.04, 2.9, 2.125, 0x2a1a10);
    rail.rotation.x = Math.atan2(1.9, 1.75);
    for (let i = 3; i <= 12; i++) addBox(0.03, 0.9, 0.03, x0 + 0.04, (rise * i) / NS + 0.46, z0 + dz * i + 0.07, 0x2a1a10); // balusters
    [3, 12].forEach((i) => { // thick newel posts with caps
      addBox(0.11, 1.2, 0.11, x0 + 0.04, (rise * i) / NS + 0.6, z0 + dz * i + 0.07, 0x30200f);
      addBox(0.15, 0.05, 0.15, x0 + 0.04, (rise * i) / NS + 1.22, z0 + dz * i + 0.07, 0x4a331b);
    });
    // you can't walk onto it: solid from the first surviving step to the top, plus the rail
    addSolid(cx, 2.7, w, 2.8);
    addSolid(x0 - 0.05, 2.6, 0.08, 2.9);
    entityBlock.push({ minX: x0 - 0.2, maxX: x1 + 0.2, minZ: 1.0, maxZ: 3.6 });
    // a plain dark hatch where it meets the ceiling
    addBox(w, 0.2, 0.9, cx, 3.0, 1.45, 0x050505);
  }
  // a faint cold glow down in the stairwell pit, so the way down reads as stairs and not a hole
  if (yawObject.position.x < 21) {
    const pit = new THREE.PointLight(0x9fb4c8, 1.1, 5, 2);
    pit.position.set(18.3, -1.0, 2.4);
    pit.intensity = 2.4;
    worldGroup.add(pit);
  }
  // a hanging work lamp in the stairwell, like the STAFF sign: a warm glow so the boards can be seen even with the axe in hand
  if (yawObject.position.x < 21) {
    addBox(0.06, 0.5, 0.06, 20.4, 2.75, 2.7, 0x222222);
    addBox(0.3, 0.1, 0.3, 20.4, 2.45, 2.7, 0x333333);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffe2a8 });
    const bulbM = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), bulbMat);
    bulbM.position.set(20.4, 2.33, 2.7);
    worldGroup.add(bulbM);
    const wl = new THREE.PointLight(0xffd9a0, 2.2, 8, 2);
    wl.position.set(20.3, 2.3, 2.7);
    worldGroup.add(wl);
    flickerLights.push({ light: wl, base: 2.2, phase: 1.3 });
    // more caged lamps over the flights: brighter, stuttering, so both stairs read even with the axe out
    [[18.3, 2.7, 0.0, 5.5, 0.4], [18.3, 1.5, 0.0, 4.5, 2.9], [20.4, 1.7, 0.0, 4.5, 5.1]].forEach(([lx, lz, , inten, ph], i) => {
      addBox(0.05, 0.3, 0.05, lx, 2.85, lz, 0x222222);
      addBox(0.22, 0.08, 0.22, lx, 2.68, lz, 0x333333);
      const bm = new THREE.MeshBasicMaterial({ color: 0xffe2a8 });
      const bb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), bm);
      bb.position.set(lx, 2.6, lz);
      worldGroup.add(bb);
      const L = new THREE.PointLight(0xffd9a0, inten, 9, 2);
      L.position.set(lx, 2.5, lz);
      worldGroup.add(L);
      flickerLights.push({ light: L, base: inten, phase: ph, mat: bm });
    });
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
  const bulb = new THREE.PointLight(0xaabbaa, 0.35, 5, 2);
  bulb.position.set(18.3, 2.5, 3.9);
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

function tryMovePlayer(dt) {
  if (state.activeNpc || state.flags.tut === "open" || state.transition || state.hiding) {
    moveVX = moveVZ = 0;
    return; // frozen mid-dialogue, or tucked into a locker
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
    setElevatorOpen(1);
    // step inside, press the button, ride up, doors open on the second floor
    playElevatorRide({ from: "1", to: "2" }, () => startTransition({ x: 24.5, y: 3.3, yaw: Math.PI }));
  }
}

// The ride: you are inside, a hand presses the button, the doors close, the car shakes upward, the doors open.
// Two floors only (1 and 2); the keyhole is for the cellar key.
function playElevatorRide(opt, done) {
  const prevPhase = state.phase;
  state.phase = "elevride";
  keys.clear();
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;z-index:9000;background:#000";
  const cv = document.createElement("canvas");
  cv.width = 1280; cv.height = 720;
  cv.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
  wrap.appendChild(cv);
  document.body.appendChild(wrap);
  const c = cv.getContext("2d");
  const down = opt.to === "B";
  const labels = down ? ["2", "1", "B"] : ["2", "1"];
  const BTN = { "2": [980, 330], "1": [980, 410], B: [980, 495] };
  const ease = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const seg = (t, a, b) => ease((t - a) / (b - a));
  const T0 = performance.now();
  let pressed = false, chimed = false, rumbled = false, slid1 = false, slid2 = false;
  const rumble = () => {
    if (!audioReady()) return;
    const t = audioCtx.currentTime;
    const n = audioCtx.createBufferSource(), lp = audioCtx.createBiquadFilter(), gn = audioCtx.createGain();
    n.buffer = noiseBuf; n.loop = true; lp.type = "lowpass"; lp.frequency.value = 110;
    gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(0.3, t + 0.5);
    gn.gain.setValueAtTime(0.3, t + 2.6); gn.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
    n.connect(lp).connect(gn).connect(audioCtx.destination); n.start(t); n.stop(t + 3.5);
  };
  const slide = () => {
    if (!audioReady()) return;
    const t = audioCtx.currentTime;
    const n = audioCtx.createBufferSource(), bp = audioCtx.createBiquadFilter(), gn = audioCtx.createGain();
    n.buffer = noiseBuf; n.loop = true; bp.type = "bandpass"; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(500, t); bp.frequency.linearRampToValueAtTime(900, t + 1.0);
    gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(0.1, t + 0.15); gn.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    n.connect(bp).connect(gn).connect(audioCtx.destination); n.start(t); n.stop(t + 1.3);
  };
  const frame = () => {
    const t = (performance.now() - T0) / 1000;
    const TOTAL = 8.2;
    // timeline
    const closeK = seg(t, 2.6, 3.8); // doors closing
    const openK = seg(t, 6.3, 7.5); // doors opening again
    const o = t < 5 ? closeK : 1 - openK; // 0 = open, 1 = shut
    const moving = t > 3.9 && t < 6.1;
    if (t > 2.2 && !pressed) { pressed = true; playClick(); }
    if (t > 2.6 && !slid1) { slid1 = true; slide(); }
    if (t > 3.9 && !rumbled) { rumbled = true; rumble(); }
    if (t > 6.2 && !chimed) { chimed = true; playDing(); }
    if (t > 6.3 && !slid2) { slid2 = true; slide(); }
    // light flickers harder while it moves, with one dead beat
    let light = 0.85 + Math.random() * 0.15;
    if (moving) light *= Math.random() < 0.18 ? 0.25 : 1;
    if (t > 5.0 && t < 5.35) light = 0.03;
    const sx = moving ? (Math.random() - 0.5) * 7 : 0, sy = moving ? (Math.random() - 0.5) * 7 : 0;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#000"; c.fillRect(0, 0, 1280, 720);
    c.translate(sx, sy);
    // walls: dull steel with seams
    const wall = c.createLinearGradient(0, 0, 1280, 0);
    wall.addColorStop(0, "#1a1c1e"); wall.addColorStop(0.5, "#2c2f32"); wall.addColorStop(1, "#1a1c1e");
    c.fillStyle = wall; c.fillRect(-20, -20, 1320, 760);
    c.strokeStyle = "rgba(0,0,0,0.5)"; c.lineWidth = 3;
    [60, 200, 880, 1060, 1200].forEach((x) => { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 720); c.stroke(); });
    // handrail
    c.fillStyle = "#6a6d70"; c.fillRect(0, 470, 330, 10);
    // doors: gap behind them, then two panels
    const gap = c.createLinearGradient(0, 120, 0, 720);
    if (down || t < 5) { gap.addColorStop(0, "#050505"); gap.addColorStop(1, "#0b0a0a"); }
    else { gap.addColorStop(0, "#07090f"); gap.addColorStop(0.7, "#10152a"); gap.addColorStop(1, "#0a0c18"); }
    c.fillStyle = gap; c.fillRect(330, 120, 470, 600);
    const panel = (x0, x1) => {
      const gp = c.createLinearGradient(x0, 0, x1, 0);
      gp.addColorStop(0, "#5d6166"); gp.addColorStop(0.5, "#7a7f84"); gp.addColorStop(1, "#555a5e");
      c.fillStyle = gp; c.fillRect(x0, 120, x1 - x0, 600);
      c.strokeStyle = "rgba(0,0,0,0.45)"; c.strokeRect(x0, 120, x1 - x0, 600);
    };
    panel(330 - 235 * (1 - o), 330 + 235 * o);
    panel(800 - 235 * o, 800 + 235 * (1 - o));
    c.fillStyle = "#222"; c.fillRect(325, 100, 480, 22); // lintel
    // floor indicator above the doors
    c.fillStyle = "#050505"; c.fillRect(530, 52, 80, 40);
    const shown = t < 4.6 ? "1" : down ? (t < 5.6 ? "1" : "B") : "2";
    c.fillStyle = t > 6.2 || t < 4.6 ? "#d13a1a" : "#7a2412";
    c.font = "bold 30px Courier New"; c.textAlign = "center"; c.fillText(down && t > 5.6 ? "B" : shown, 570, 84);
    // the button panel
    c.fillStyle = "#34383b"; c.fillRect(900, 250, 160, down ? 300 : 230);
    c.strokeStyle = "#111"; c.lineWidth = 4; c.strokeRect(900, 250, 160, down ? 300 : 230);
    labels.forEach((l) => {
      const [bx, by] = BTN[l];
      const lit = pressed && l === opt.to;
      c.beginPath(); c.arc(bx, by, 27, 0, 7);
      c.fillStyle = lit ? "#ffb347" : "#1d1f21"; c.fill();
      c.strokeStyle = lit ? "#ffe0a0" : "#6a6d70"; c.lineWidth = 4; c.stroke();
      if (lit) { const gl = c.createRadialGradient(bx, by, 5, bx, by, 70); gl.addColorStop(0, "rgba(255,180,70,0.45)"); gl.addColorStop(1, "rgba(255,180,70,0)"); c.fillStyle = gl; c.fillRect(bx - 80, by - 80, 160, 160); }
      c.fillStyle = lit ? "#2a1400" : "#c9c4b4"; c.font = "bold 26px Courier New"; c.textAlign = "center";
      c.fillText(l === "B" ? "B" : l, bx, by + 9);
    });
    // a hand reaching in from the lower right: sleeve, wrist, palm, curled fingers, one finger pressing
    {
      const target = BTN[opt.to];
      const ease = (u) => u * u * (3 - 2 * u);
      const rin = ease(seg(t, 0.9, 1.9)), rout = ease(seg(t, 2.6, 3.4));
      const reach = rin * (1 - rout);
      if (reach > 0.005) {
        const hov = t < 2.0 ? Math.sin(t * 9) * 2.5 * rin : 0; // slight tremor before the press
        const push = ease(seg(t, 1.95, 2.2)) * (1 - ease(seg(t, 2.3, 2.6))); // 0..1 finger press
        const bx = target[0], by = target[1];
        // fingertip: hovers off the button, then touches it
        const tipX = bx + 8 + (1 - push) * 20 + hov, tipY = by + 10 + (1 - push) * 16;
        const sx = 1330 + (tipX - 1330) * reach, sy = 880 + (tipY - 880) * reach;
        const ang = Math.atan2(sy - 880, sx - 1330); // direction of travel
        c.save();
        c.translate(sx, sy);
        c.rotate(ang + Math.PI);
        // now +x points back along the arm, tip at the origin, drawn pointing "left"
        c.lineCap = "round"; c.lineJoin = "round";
        // soft shadow on the panel
        c.fillStyle = "rgba(0,0,0,0.18)"; c.beginPath(); c.ellipse(40, 24, 110, 22, 0, 0, 7); c.fill();
        // sleeve and forearm
        const sl = c.createLinearGradient(0, -50, 0, 50); sl.addColorStop(0, "#3a3f45"); sl.addColorStop(1, "#23262a");
        c.fillStyle = sl; c.beginPath(); c.moveTo(250, -52); c.lineTo(520, -70); c.lineTo(520, 70); c.lineTo(250, 54); c.closePath(); c.fill();
        c.strokeStyle = "#181a1d"; c.lineWidth = 3; c.stroke();
        c.strokeStyle = "rgba(0,0,0,0.35)"; c.lineWidth = 3; [330, 400].forEach((x) => { c.beginPath(); c.moveTo(x, -58); c.quadraticCurveTo(x - 12, 0, x, 60); c.stroke(); });
        // cuff
        c.fillStyle = "#2c3036"; c.fillRect(236, -54, 22, 110);
        // wrist and palm
        const sk = c.createLinearGradient(0, -40, 0, 40); sk.addColorStop(0, "#d2b8a0"); sk.addColorStop(0.6, "#b99c84"); sk.addColorStop(1, "#8f7761");
        c.fillStyle = sk; c.beginPath();
        c.moveTo(246, -40); c.bezierCurveTo(200, -42, 160, -52, 112, -46);
        c.lineTo(92, -30); c.lineTo(92, 34); c.bezierCurveTo(140, 50, 200, 46, 246, 42); c.closePath(); c.fill();
        c.strokeStyle = "rgba(60,40,28,0.55)"; c.lineWidth = 2; c.stroke();
        // curled fingers (middle, ring, little) as knuckled bumps under the pointer
        [[-22, 30], [-4, 29], [14, 28]].forEach(([oy, w], i) => {
          c.fillStyle = i % 2 ? "#b3977f" : "#bfa38a";
          c.beginPath(); c.ellipse(86, 10 + oy + 14 * i * 0.2, 30, 11, 0, 0, 7); c.fill();
          c.strokeStyle = "rgba(60,40,28,0.5)"; c.lineWidth = 2; c.stroke();
        });
        // thumb folded along the side
        c.fillStyle = "#c2a68e"; c.beginPath(); c.ellipse(116, 38, 38, 13, -0.12, 0, 7); c.fill();
        c.strokeStyle = "rgba(60,40,28,0.5)"; c.stroke();
        // index finger: two segments, bends a little more on the press
        const bend = 0.12 + push * 0.12;
        const k1x = 70, k1y = -22; // knuckle
        const j2x = k1x - 62 * Math.cos(bend), j2y = k1y + 62 * Math.sin(bend) * -1 + 8;
        const tx2 = j2x - 52, ty2 = j2y + 6 + push * 3;
        c.strokeStyle = "#bda189"; c.lineWidth = 30; c.beginPath(); c.moveTo(k1x + 8, k1y); c.lineTo(j2x, j2y); c.stroke();
        c.strokeStyle = "#c8ad95"; c.lineWidth = 26; c.beginPath(); c.moveTo(j2x, j2y); c.lineTo(tx2, ty2); c.stroke();
        // nail and joint creases
        c.fillStyle = "#e0cbb8"; c.beginPath(); c.ellipse(tx2 + 6, ty2 - 6, 12, 7, 0.1, 0, 7); c.fill();
        c.strokeStyle = "rgba(60,40,28,0.45)"; c.lineWidth = 2;
        [j2x + 2, k1x - 14].forEach((x) => { c.beginPath(); c.moveTo(x, j2y - 11); c.lineTo(x, j2y + 13); c.stroke(); });
        c.restore();
        // press ring flashes on the button as it goes in
        if (push > 0.6) { c.strokeStyle = `rgba(255,200,110,${(push - 0.6) * 1.4})`; c.lineWidth = 4; c.beginPath(); c.arc(bx, by, 36 + (1 - push) * 40, 0, 7); c.stroke(); }
      }
    }
    // the light in the car, and the dark around it
    c.fillStyle = `rgba(0,0,0,${1 - light})`; c.fillRect(-20, -20, 1320, 760);
    const vg = c.createRadialGradient(640, 330, 140, 640, 360, 820);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.88)");
    c.fillStyle = vg; c.fillRect(-20, -20, 1320, 760);
    c.restore();
    // fade in at the start, out at the end
    const fade = t < 0.8 ? 1 - t / 0.8 : t > TOTAL - 0.7 ? (t - (TOTAL - 0.7)) / 0.7 : 0;
    wrap.style.background = "#000";
    cv.style.opacity = String(1 - Math.max(0, Math.min(1, fade)));
    if (t >= TOTAL) {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      state.phase = prevPhase === "elevride" ? "explore" : prevPhase;
      done();
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
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
let lowBattTimer = 1, lowBattBlink = 0;
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

  // under 25% it blinks now and then, so you know it's running out
  if (hasFlashlightOn() && state.batteryLevel < 25) {
    lowBattTimer -= dt;
    if (lowBattTimer <= 0) {
      lowBattTimer = 2.5 + Math.random() * 3 - (25 - state.batteryLevel) * 0.08;
      lowBattBlink = 0.32;
    }
    if (lowBattBlink > 0) {
      lowBattBlink -= dt;
      // two quick drops of the beam
      const ph = 0.32 - lowBattBlink;
      if (ph < 0.08 || (ph > 0.15 && ph < 0.23)) targetIntensity *= 0.04;
    }
  } else lowBattBlink = 0;
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

// change batteries: the quick key (R) or Use in the inventory
function useBatteries() {
  if (state.batteries <= 0 || state.batteryLevel >= 100) return false;
  state.batteries -= 1;
  state.batteryLevel = 100;
  playClick();
  return true;
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
  // spare batteries are shown right next to the charge, so it is always clear how many you carry
  document.getElementById("battery-pct").textContent = pct + "%" + (state.batteries > 0 ? "  +" + state.batteries + " spare" : "");
  if (state.batteries > 0 && pct < 40) hintOnce("battLow", "Flashlight low: press " + kn("battery") + " to change batteries");
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

  // Shutting a door matters (it's how you get away), so looking straight at an open door beats clutter beside it.
  {
    const fx = -Math.sin(yawObject.rotation.y), fz = -Math.cos(yawObject.rotation.y);
    const aim = (x, y) => { const dd = Math.hypot(x - px, y - py); return dd > 0 ? ((x - px) * fx + (y - py) * fz) / dd : 1; };
    let best = null, bd = Infinity;
    doorList().forEach((door) => {
      if (door.noClose || !isDoorOpen(door)) return;
      const dd = Math.hypot(door.x - px, door.y - py);
      if (dd > 0.45 && dd < 3.0 && aim(door.x, door.y) > 0.8 && dd < bd) { bd = dd; best = door; }
    });
    if (best) {
      const rival = ITEMS.some((it) => !state.inventory[it.id] && !it.hidden && Math.hypot(it.x - px, it.y - py) < 0.6 && aim(it.x, it.y) > 0.93)
        || HOTSPOTS.some((h) => h.id !== "boards" && Math.hypot(h.x - px, h.y - py) < Math.min(0.7, bd - 0.2) && aim(h.x, h.y) > 0.93);
      if (!rival) return { type: "door", id: best.id, label: "Close Door" };
    }
  }

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
    if (item.id === "axe" && d < closestDist) {
      if (camera.rotation.x > -0.3) { hintOnce("lookdown", "Look closer."); return; }
    }
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
      // facing it, close enough to reach, but not standing in the doorway itself
      const fx = -Math.sin(yawObject.rotation.y), fz = -Math.cos(yawObject.rotation.y);
      const facing = dd > 0 && ((door.x - px) * fx + (door.y - py) * fz) / dd > 0.3;
      if (dd > 0.45 && dd < 3.0 && facing && dd < doorDist && !door.noClose) {
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
      if (h.id === "breaker") label = state.flags.powerOn ? "Breaker Panel" : "Flip Breaker";
      if (h.id === "boards") label = ""; // no prompt: you have to try things
      if (h.loot && (state.flags.looted || {})[h.id]) label = ""; // already searched
      if (h.loot && isDoorSpot(spotOf(h))) label = (state.flags.doorsOpenA || {})[h.id] ? "Close" : h.label;
      if (h.lever !== undefined) label = (state.flags.leverSeq || []).includes(h.lever) ? "" : (state.flags.leverFit || []).includes(h.lever) ? h.label : (spareHandles() > 0 ? "Fit Handle" : "Bare Lever");
      if (h.hide) label = "Hide";
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
  const target = EYE_HEIGHT - CROUCH_DROP * crouchK - reachDrop + floorHeight(p.x, p.z);
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
  if (state.batteries > 0) hintOnce("battUse", "Spare batteries: press " + kn("battery") + " to change them when the flashlight runs low");
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

function handleInteract(pre) {
  if (state.activeNpc || state.flags.tut === "open" || (state.reach && !pre)) return;
  if (state.hiding) { exitHide(false); return; }
  const target = pre || nearestInteractable();
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
      const blocked = (e.mode === "active" && Math.hypot(e.x - door.x, e.z - door.y) < 1.1) || husks.some((h) => h.mode !== "dead" && h.mode !== "gone" && Math.hypot(h.x - door.x, h.z - door.y) < 1.0);
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
      setTimeout(() => hintOnce("closeDoor", "You can shut doors behind you: face an open door and press " + kn("interact") + ". It can't open them."), 2200);
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
    if (h.hide) { enterHide(h); return; }
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
          : kn("switch") + ": switch item in hand<br />" + kn("inv") + " or Esc: close" + (state.batteries > 0 ? "<br /><b>Batteries: press Use here, or " + kn("battery") + " any time</b>" : "");
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
  if (state.cans > 0) add(`Tin Cans x${state.cans}`, null);
  if (state.batteries > 0) {
    add(`Batteries x${state.batteries}`, "Use", () => {
      useBatteries();
      renderInventory();
    }, state.batteryLevel >= 100);
  }
  const noteDate = (it) => { const m = /^(Sept|Oct)\s+(\d+)/.exec(it.paper || ""); return m ? (m[1] === "Oct" ? 100 : 0) + +m[2] : 0; }; // oldest first
  ITEMS.filter((it) => it.note && state.inventory[it.id]).sort((p, q) => noteDate(p) - noteDate(q)).forEach((it) => add(it.name, it.tape ? "Play" : "Read", () => {
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
  const pc = document.getElementById("paper-canvas");
  stopTape();
  if (it.journal) openJournal(it, pc);
  else if (it.tape) playTape(it, pc);
  else {
    pc.width = 512; pc.height = 640;
    if (it.draw) it.draw(pc);
    else drawPaper(pc, it.paper, it.sloppy, it.seed);
  }
  document.getElementById("paper-overlay").classList.remove("hidden");
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
}

function closeReader() {
  stopTape();
  journalState = null;
  document.getElementById("paper-overlay").classList.add("hidden");
  document.getElementById("reader-overlay").classList.add("hidden");
  state.phase = "explore";
  renderer.domElement.requestPointerLock();
}

document.getElementById("reader-close").addEventListener("click", closeReader);
document.getElementById("paper-close").addEventListener("click", closeReader);
if (document.fonts && document.fonts.load) document.fonts.load('40px "Reenie Beanie"');


// ---- the story pulls: an opening beat, a goal that says where to look next, and a small surprise at each floor change ----
let sayTimer = null, openingSeen = false;
function say(text, ms) { // Maria thinking out loud, a line at the bottom of the screen
  const el = document.getElementById("caption");
  el.textContent = text; el.style.opacity = "1";
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => { el.style.opacity = "0"; }, ms || 3200);
}
function runOpening() {
  if (openingSeen) return;
  openingSeen = true;
  const at = (ms, fn) => setTimeout(() => { if (state.phase === "explore" || state.phase === "inventory") fn(); }, ms);
  at(900, () => say("The front door was already open.", 3200));
  at(5200, () => say("John? ... John, it's Maria.", 3000));
  at(9500, () => { say("Someone is winding a music box. Upstairs.", 4200); try { playMusicBox(); } catch (e) {} });
  at(15500, () => { say("It stopped the moment I listened.", 3500); try { playScrape(); } catch (e) {} });
}
function updateStory(dt) {
  if (state.phase !== "explore" || state.transition) return;
  const lvl = levelOf(yawObject.position.x);
  if (!state.flags.arrived) state.flags.arrived = {};
  if (lvl > 0 && !state.flags.arrived[lvl]) {
    state.flags.arrived[lvl] = true;
    if (lvl === 1) setTimeout(() => { if (state.phase !== "explore") return; try { playBang(); } catch (e) {} say("That wasn't me.", 2600); markScare(); }, 3500);
    else setTimeout(() => { if (state.phase !== "explore") return; try { playMusicBox(); } catch (e) {} say("It's warm down here.", 3000); }, 3500);
  }
}
function currentGoal() {
  const f = state.flags, inv = state.inventory, ar = f.arrived || {};
  if (!inv.flashlight) return "It's too dark to go on without a light.";
  if (!inv.staffKey) return "I need a way further into the building.";
  if (!inv.johnKey) return "John's door is locked. His key is somewhere in here.";
  if (!f.powerOn) return "The building has no power. John kept writing about the cellar.";
  if (!ar[1]) return "The power's back. The elevator might run now.";
  if (!inv.elevKey) return "John's trail goes up and down. Look at what he left behind.";
  return "The key is marked B. Find what it opens.";
}
const CLUE_LINES = [
  ["nSep2", "John left me his key, and said a thing was hidden under his bed."],
  ["johnJournal", "His journal: something walks the halls at night, wearing his coat. The last page is two weeks old."],
  ["nSep25", "In the dark it is fast. In the light it only watches."],
  ["tapeUp", "The lift opens by itself. Something followed him up."],
  ["note5", "He followed it down to the cellar. The boiler is warm, and it breathes."],
  ["tapeDown", "Down in the cellar they only watch, then they are gone."],
  ["nestNote", "They were people once. The light hurts them."],
];
function renderKnown() {
  const el = document.getElementById("inventory-known") || (() => {
    const d = document.createElement("div"); d.id = "inventory-known";
    d.style.cssText = "margin-top:14px;padding-top:10px;border-top:1px solid #4a4030;font-size:13px;line-height:1.5;text-align:left;max-width:360px";
    document.getElementById("inventory-list").after(d); return d;
  })();
  const lines = CLUE_LINES.filter(([id]) => state.inventory[id]).map(([, t]) => "\u2022 " + t);
  el.innerHTML = "<b style='letter-spacing:.08em'>WHERE I AM</b><br>" + currentGoal() + (lines.length ? "<br><br><b style='letter-spacing:.08em'>WHAT I KNOW</b><br>" + lines.join("<br>") : "");
}

function openInventory() {
  if (state.flags.tut === "open") state.flags.tut = "switch1";
  state.phase = "inventory";
  keys.clear();
  renderInventory(); renderKnown();
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
    if (journalState && (key === "arrowright" || key === "d")) flipJournal(1);
    else if (journalState && (key === "arrowleft" || key === "a")) flipJournal(-1);
    else if (key === "e") closeReader();
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
const ENTITY_CHASE_SPEED = 3.9; // when it sees you it RUNS: faster than your walk (2.6), slower than your sprint (4.2)
const ENTITY_SIGHT = 16;
const ENTITY_RECOIL_SPEED = 0.9; // m/s it backs away while the beam is on it
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
  if (c && c.toon) return animateToon(c, t, speed, near, frozen);
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
  const inBeam = entityInBeam(e);
  const lit = hasFlashlightOn() || groundLit();

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
    speed = ENTITY_RECOIL_SPEED; // caught in the light: it can't bear it and slowly backs away into the dark
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
      tx = e.x; // no way through right now (a closed door): it waits, pounding on it, then loses interest
      tz = e.z;
      e.stuck = (e.stuck || 0) + dt;
      e.bang = (e.bang || 0) - dt;
      if (e.bang <= 0 && e.stuck < 7) { e.bang = 1.1 + Math.random() * 1.2; playBang(); }
      if (e.stuck > 7) {
        e.stuck = 0;
        e.mode = "gone";
        e.timer = 10 + Math.random() * 8;
        entityGroup.visible = false;
        setFear(0);
        return;
      }
    }
    if (e.path) e.stuck = 0;
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
  // dying starts the whole run over: outside the building, no lights, no flashlight, nothing
  resetRun();
  enterExplore();
});

document.getElementById("caught-leave-button").addEventListener("click", () => {
  document.getElementById("caught-overlay").classList.add("hidden");
  resetRun();
  state.phase = "title";
  showScreen("screen-title");
  refreshQuickStart();
});

// ---- pop-out scares -----------------------------------------------------------------
function clearScares() {
  scareActive.forEach((a) => scene.remove(a.mesh));
  scareActive = [];
  scareBlackout = 0;
}
function playBang() {
  loudT = 1.2;
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
// ---- creepier sounds ---------------------------------------------------------------
// a slow, wet, detuned growl with a tremor in it
function playGrowl(vol) {
  if (!audioReady()) return;
  const t = audioCtx.currentTime, v = vol || 1;
  const g = audioCtx.createGain(), lp = audioCtx.createBiquadFilter(), trem = audioCtx.createOscillator(), tg = audioCtx.createGain();
  lp.type = "lowpass"; lp.frequency.setValueAtTime(420, t); lp.frequency.exponentialRampToValueAtTime(140, t + 1.6);
  trem.frequency.value = 23; tg.gain.value = 0.35; trem.connect(tg).connect(g.gain);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28 * v, t + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
  [58, 61.5, 87].forEach((f, i) => {
    const o = audioCtx.createOscillator();
    o.type = i === 2 ? "triangle" : "sawtooth";
    o.frequency.setValueAtTime(f * 1.4, t); o.frequency.exponentialRampToValueAtTime(f * 0.8, t + 1.6);
    o.connect(lp); o.start(t); o.stop(t + 1.75);
  });
  trem.start(t); trem.stop(t + 1.75);
  lp.connect(g).connect(audioCtx.destination);
}
// a breathy whisper that never quite makes words: formant-swept noise
function playWhisper(vol) {
  if (!audioReady()) return;
  const t = audioCtx.currentTime, v = vol || 1;
  for (let k = 0; k < 4; k++) {
    const at = t + k * 0.28 + Math.random() * 0.12;
    const n = audioCtx.createBufferSource(), bp = audioCtx.createBiquadFilter(), bp2 = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
    n.buffer = noiseBuf; n.loop = true;
    bp.type = "bandpass"; bp.Q.value = 6; bp.frequency.setValueAtTime(700 + Math.random() * 500, at); bp.frequency.linearRampToValueAtTime(1500 + Math.random() * 1500, at + 0.22);
    bp2.type = "highpass"; bp2.frequency.value = 500;
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.1 * v, at + 0.07); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    n.connect(bp).connect(bp2).connect(g).connect(audioCtx.destination);
    n.start(at); n.stop(at + 0.27);
  }
}
// something sucks the air out of the room as it leaves
function playVanish() {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const n = audioCtx.createBufferSource(), lp = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
  n.buffer = noiseBuf; n.loop = true;
  lp.type = "lowpass"; lp.frequency.setValueAtTime(3000, t); lp.frequency.exponentialRampToValueAtTime(90, t + 0.7);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
  n.connect(lp).connect(g).connect(audioCtx.destination);
  n.start(t); n.stop(t + 0.85);
  const o = audioCtx.createOscillator(), og = audioCtx.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(52, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.6);
  og.gain.setValueAtTime(0.3, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  o.connect(og).connect(audioCtx.destination); o.start(t); o.stop(t + 0.75);
}

// ---- watchers: they never attack. They stand where you can't quite see them, and are gone when you look. ----
const watchers = { cur: null, cd: 14, lookT: 0, life: 0, lvl: -1 };
function makeWatcher(level) {
  const g = new THREE.Group();
  if (level === 0) { // ground floor: the tall pale shroud, seen at the far end of a room
    const a = makeApparition();
    g.add(a.mesh || a);
    return g;
  }
  const pale = new THREE.MeshStandardMaterial({ color: 0xcfc9b8, roughness: 0.8, emissive: 0x1a1a18 });
  const blk = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const eye = new THREE.MeshBasicMaterial({ color: level === 2 ? 0xff3a22 : 0xffffff });
  if (level === 1) { // upstairs: a long pale face leaning out of the dark, too high and too thin
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), pale);
    head.scale.set(0.75, 1.7, 0.8); head.position.set(0, 1.75, 0); g.add(head);
    [-0.05, 0.05].forEach((x) => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), blk); e.scale.set(0.8, 1.6, 0.6); e.position.set(x, 1.82, 0.1); g.add(e); });
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), blk); m.scale.set(1, 2.4, 0.5); m.position.set(0, 1.62, 0.1); g.add(m);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.1, 8), pale); neck.position.set(0, 1.1, 0); g.add(neck);
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.2, 8, 1, true), new THREE.MeshStandardMaterial({ color: 0x08080a, side: THREE.DoubleSide })); body.position.y = 0.6; g.add(body);
  } else { // basement: a crouched shape, and only its eyes show
    const sh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1 }));
    sh.scale.set(1, 1.3, 0.8); sh.position.y = 0.45; g.add(sh);
    [-0.07, 0.07].forEach((x) => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 6), eye); e.position.set(x, 0.62, 0.2); g.add(e); });
    const glow = new THREE.PointLight(0xff2a14, 0.35, 2.5, 2); glow.position.set(0, 0.62, 0.3); g.add(glow);
  }
  return g;
}
function vanishWatcher(quiet) {
  const w = watchers;
  if (!w.cur) return;
  scene.remove(w.cur);
  w.cur = null;
  w.cd = 22 + Math.random() * 28;
  if (!quiet) { playVanish(); if (Math.random() < 0.5) playWhisper(0.5); }
}
function updateWatchers(dt) {
  const w = watchers;
  if (state.phase !== "explore" || state.flags.tut === "open" || state.flags.finale || state.transition || state.activeNpc) { if (w.cur) vanishWatcher(true); return; }
  const p = yawObject.position, lvl = levelOf(p.x);
  if (w.cur && lvl !== w.lvl) vanishWatcher(true);
  if (!state.inventory.flashlight && lvl === 0 && !state.flags.powerOn) return; // nothing watches before you've even gone in
  if (isOutside()) { if (w.cur) vanishWatcher(true); return; }
  const fx = -Math.sin(yawObject.rotation.y), fz = -Math.cos(yawObject.rotation.y);
  if (!w.cur) {
    w.cd -= dt;
    if (w.cd > 0 || sinceScare() < 8 || !directorAllow("watcher")) return;
    for (let i = 0; i < 24; i++) { // find a spot 6-13 m away, in line of sight, behind or beside you
      const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 7;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (levelOf(x) !== lvl || isWall(x, z) || !canStand(x, z) || !hasLineOfSight(p.x, p.z, x, z)) continue;
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
      if ((dx * fx + dz * fz) / d > 0.35) continue; // not where you're looking right now
      const m = makeWatcher(lvl);
      m.position.set(x, 0, z);
      m.rotation.y = Math.atan2(-dx, -dz);
      scene.add(m);
      Object.assign(w, { cur: m, lookT: 0, life: 0, lvl, x, z });
      directorSpend("watcher");
      if (Math.random() < 0.6) playWhisper(0.35);
      return;
    }
    w.cd = 4; // nowhere good to stand this time; try again soon
    return;
  }
  w.life += dt;
  const dx = w.x - p.x, dz = w.z - p.z, d = Math.hypot(dx, dz) || 1;
  w.cur.rotation.y = Math.atan2(-dx, -dz); // keeps its face on you
  const seen = (dx * fx + dz * fz) / d > Math.cos(0.5) && hasLineOfSight(p.x, p.z, w.x, w.z);
  w.lookT = seen ? w.lookT + dt : 0;
  if (w.lookT > 0.2 || d < 2.8 || w.life > 40) { if (w.lookT > 0.2 || d < 2.8) joltCamera(0.45); vanishWatcher(false); }
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

function altScare(sc) { // second sighting of the same kind: from behind, or from the other end, never the same picture twice
  const p = yawObject.position, yw = yawObject.rotation.y, fx = -Math.sin(yw), fz = -Math.cos(yw);
  if (sc.kind === "lurker" || sc.kind === "slam") {
    for (const d of [3.0, 2.4, 3.6]) { const x = p.x - fx * d, z = p.z - fz * d; if (canStand(x, z)) return { ...sc, kind: "lurker", at: { x, z }, delay: 1.1, life: 1.4, near: 1.2 }; }
  } else if (sc.kind === "crawler" && sc.to) return { ...sc, at: sc.to, to: sc.at, dur: (sc.dur || 1.2) * 1.6 };
  return sc;
}
function startScare(sc) {
  const seen = state.flags.seenKind || (state.flags.seenKind = {});
  if (seen[sc.kind]) sc = altScare(sc);
  seen[sc.kind] = true;
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
    if (f.mat) f.mat.color.setScalar(n > 0.55 ? 0.15 : 1);
  });
  swayers.forEach((s) => {
    s.grp.rotation.z = Math.sin(T * 0.9 + s.phase) * 0.08;
    s.grp.rotation.x = Math.sin(T * 0.7 + s.phase * 1.7) * 0.06;
  });
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
  tryMovePlayer(dt);
  checkJohnRoom();
  updateStory(dt);
  updateEntity(dt);
  updateHusks(dt);
  updateDirector(dt);
  updateWatchers(dt);
  updateEyes(dt);
  updateHiding(dt);
  updateBars(dt);
  updateInkDrips(dt);
  updateFinale(dt);
  updateBreaker(dt);
  updateScares(dt);
  applyTension(entityTension);
  updateDoorAnimation(dt);
  updateFluorescents(dt);
  updateF2Lights(dt);
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
  const bgColor = outside ? 0x141a2e : 0x0b0a0d;
  scene.background.set(bgColor);
  scene.fog.color.set(bgColor);
  const ambientTarget = Math.max(0, (outside ? 0.22 : 0.03) + 0.05 * (state.settings.brightness - 1)); // night glow out on the street; indoors only real lights and the beam show anything
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
refreshQuickStart();