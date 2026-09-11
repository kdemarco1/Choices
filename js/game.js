// ---------------------------------------------------------------------------
// GAME LOGIC — now a real 3D scene via Three.js instead of a 2D raycaster.
// Screens: title -> story -> explore (with an optional detour to settings
// or the pause menu). All game *content* (maps, dialogue, items) lives in
// data.js, untouched by this rewrite — only the rendering/movement/camera
// layer changed. World coordinates: grid (x, y) maps directly to world
// (X, Z); Y is vertical (up).
// ---------------------------------------------------------------------------

const state = {
  phase: "title", // "title" | "story" | "settings" | "explore" | "paused"
  flags: {},
  log: [],
  activeNpc: null, // "caretaker" | "groundskeeper" | null
  dialogueNode: "start",
  settings: { showPrompts: true },
  settingsReturnTo: "title", // "title" | "paused" — where the Back button goes
  inventory: {}, // itemId -> true, once picked up
  flashlightOn: false,
  frontDoorOpen: false,
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

// Vision "range": full range once the flashlight + batteries are both in
// the inventory and switched on, a short oppressive range otherwise. This
// now drives real Three.js fog distance instead of a manual brightness
// falloff, so it's genuinely how far you can see, not a fake vignette.
const LIT_RANGE = 12;
const DARK_RANGE = 2.6;
const MOON_RANGE = 8;

function hasFlashlightOn() {
  return !!(state.inventory.flashlight && state.inventory.batteries && state.flashlightOn);
}

function currentLightRange() {
  if (CURRENT_MAP === EXTERIOR_MAP) return MOON_RANGE;
  return hasFlashlightOn() ? LIT_RANGE : DARK_RANGE;
}

function toggleFlashlight() {
  if (!(state.inventory.flashlight && state.inventory.batteries)) {
    addLog("She doesn't have a working flashlight yet.");
    return;
  }
  state.flashlightOn = !state.flashlightOn;
  addLog(state.flashlightOn ? "Flashlight on." : "Flashlight off.");
  renderHud();
}

function addLog(entry) {
  state.log.unshift(entry);
  state.log = state.log.slice(0, 6);
  renderLog();
}

// ---- screen switching -----------------------------------------------------

function showScreen(id) {
  ["screen-title", "screen-settings", "Story-screen", "screen-explore"].forEach((s) => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

// ---- title screen -----------------------------------------------------------

document.getElementById("title-start-button").addEventListener("click", () => {
  CURRENT_MAP = EXTERIOR_MAP; // always start a fresh run outside the house
  state.flags = {};
  state.log = [];
  state.inventory = {};
  state.flashlightOn = false;
  state.frontDoorOpen = false;
  state.activeNpc = null;
  state.dialogueNode = "start";
  keys.clear();
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
}

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
  const hasBoth = state.inventory.flashlight && state.inventory.batteries;
  const flashlightStatus = hasFlashlightOn() ? "ON" : hasBoth ? "OFF (press F)" : "none";
  hud.innerHTML = `
    <div class="portrait" style="background:${PROTAGONIST.color}">${PROTAGONIST.name.charAt(0)}</div>
    <div>
      <div class="hud-name">${PROTAGONIST.name}</div>
      <div class="stat-line">Carrying: ${carriedNames || "nothing"}</div>
      <div class="stat-line">Flashlight: ${flashlightStatus}</div>
    </div>
  `;
}

function renderLog() {
  const list = document.getElementById("log-list");
  list.innerHTML = "";
  if (state.log.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "Nothing yet — go talk to someone.";
    list.appendChild(empty);
    return;
  }
  state.log.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "log-entry";
    div.textContent = entry;
    list.appendChild(div);
  });
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
  state.phase = "explore";
  showScreen("screen-explore");
  spawnAt(PLAYER_START, EXTERIOR_MAP);
  renderHud();
  clock.start();
  renderer.setAnimationLoop(gameLoop);
  renderer.domElement.requestPointerLock();
});

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

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 100);
const yawObject = new THREE.Object3D();
yawObject.add(camera);
scene.add(yawObject);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
scene.add(ambientLight);

const flashlightLight = new THREE.SpotLight(0xfff2d0, 0, 9, Math.PI / 6.5, 0.5, 1.1);
flashlightLight.position.set(0, 0, 0);
camera.add(flashlightLight);
camera.add(flashlightLight.target);
flashlightLight.target.position.set(0, 0, -1);

const worldGroup = new THREE.Group();
let doorPivot = null; // set in buildWorld() when outside; drives the hinge-swing animation
scene.add(worldGroup);

function resizeRenderer() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
resizeRenderer();
window.addEventListener("resize", resizeRenderer);

// ---- textures (procedurally generated, no image files needed) -----------------
// These draw onto small offscreen 2D canvases, exactly like the previous
// raycaster's textures — the only difference is they're now wrapped as
// THREE.CanvasTexture and applied to real 3D geometry instead of being
// sampled column-by-column by hand.

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

function createDoorTexture() {
  const c = document.createElement("canvas");
  c.width = TEXTURE_SIZE;
  c.height = TEXTURE_SIZE;
  const t = c.getContext("2d");
  const S = TEXTURE_SIZE;
  t.fillStyle = "#7c847a";
  t.fillRect(0, 0, S, S);
  if (FRONT_DOOR.plateNumber) {
    t.fillStyle = "rgba(20, 20, 16, 0.85)";
    t.font = `${Math.max(6, S * 0.06)}px "Courier New", monospace`;
    t.textAlign = "center";
    t.textBaseline = "top";
    t.fillText(FRONT_DOOR.plateNumber, S / 2, S * 0.02);
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

const interiorWallTexture = makeThreeTexture(createInteriorWallTexture());
const exteriorWallTexture = makeThreeTexture(createExteriorWallTexture());
const doorTexture = makeThreeTexture(createDoorTexture());

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
  doorPivot = null;
  const outside = CURRENT_MAP === EXTERIOR_MAP;
  const rows = CURRENT_MAP.length;
  const cols = CURRENT_MAP[0].length;
  const wallTex = outside ? exteriorWallTexture : interiorWallTexture;
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95 });
  const wallGeo = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);

  const doorCol = Math.floor(FRONT_DOOR.x);
  const doorRow = Math.floor(FRONT_DOOR.y);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (CURRENT_MAP[row][col] !== 1) continue;
      if (outside && col === doorCol && row === doorRow) continue; // door drawn separately below
      const mesh = new THREE.Mesh(wallGeo, wallMat);
      mesh.position.set(col + 0.5, WALL_HEIGHT / 2, row + 0.5);
      worldGroup.add(mesh);
    }
  }

  const floorMat = new THREE.MeshStandardMaterial({
    color: outside ? 0x232c1f : 0x18140f,
    roughness: 1,
  });
  const planeGeo = new THREE.PlaneGeometry(cols, rows);
  const floor = new THREE.Mesh(planeGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cols / 2, 0, rows / 2);
  worldGroup.add(floor);

  const ceilMat = new THREE.MeshStandardMaterial({
    color: outside ? 0x0a0a14 : 0x0b0a0d,
    side: THREE.BackSide,
  });
  const ceiling = new THREE.Mesh(planeGeo, ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cols / 2, WALL_HEIGHT, rows / 2);
  worldGroup.add(ceiling);

  if (outside) {
    // A real hinged door: a pivot Group positioned at the hinge edge, with
    // the door mesh offset so it swings around that edge instead of its
    // own center — the same trick real 3D engines use for doors.
    const doorMat = new THREE.MeshStandardMaterial({ map: doorTexture, roughness: 0.85 });
    const doorW = 0.85;
    const doorH = WALL_HEIGHT * 0.85;
    const doorGeo = new THREE.BoxGeometry(doorW, doorH, 0.14);
    const doorMesh = new THREE.Mesh(doorGeo, doorMat);
    doorMesh.position.set(doorW / 2, 0, 0); // offset so the pivot sits at the door's edge, not its center

    doorPivot = new THREE.Group();
    doorPivot.position.set(FRONT_DOOR.x - doorW / 2, doorH / 2, FRONT_DOOR.y);
    doorPivot.rotation.y = state.frontDoorOpen ? DOOR_OPEN_ANGLE : 0;
    doorPivot.add(doorMesh);
    worldGroup.add(doorPivot);

    const glow = new THREE.PointLight(0xc3e182, 1.4, 5, 2);
    glow.position.set(FRONT_DOOR.x, WALL_HEIGHT * 0.8, FRONT_DOOR.y);
    worldGroup.add(glow);

    scene.background = new THREE.Color(0x0a0918);
  } else {
    NPCS.forEach((npc) => addMarkerSprite(npc.x, npc.y, npc.color, 0.9));
    ITEMS.filter((it) => !state.inventory[it.id]).forEach((it) => addMarkerSprite(it.x, it.y, it.color, 0.4));
    addMarkerSprite(EXIT.x, EXIT.y, "#8a1f1f", 0.6);
    scene.background = new THREE.Color(0x0b0a0d);
  }

  scene.fog.color.set(outside ? 0x0a0918 : 0x0b0a0d);
}

function addMarkerSprite(x, y, colorHex, scale) {
  const mat = new THREE.SpriteMaterial({ map: makeColorTexture(colorHex) });
  const sprite = new THREE.Sprite(mat);
  sprite.userData.disposeMaterial = true;
  sprite.scale.set(scale, scale, 1);
  sprite.position.set(x, EYE_HEIGHT * 0.55, y);
  worldGroup.add(sprite);
}

// ---- spawning ---------------------------------------------------------------
// All of the current data's spawn angles happen to be -PI/2 ("facing
// north"), which lines up exactly with a Three.js camera's default facing
// direction (-Z) when yaw is 0 — so resetting yaw/pitch to 0 on spawn
// matches every spawn point currently defined in data.js.

function spawnAt(spawn, map) {
  CURRENT_MAP = map;
  yawObject.position.set(spawn.x, EYE_HEIGHT, spawn.y);
  yawObject.rotation.y = 0;
  camera.rotation.x = 0;
  buildWorld();
}

// ---- collision + movement ---------------------------------------------------

function isWall(x, y) {
  const col = Math.floor(x);
  const row = Math.floor(y);
  if (row < 0 || row >= CURRENT_MAP.length || col < 0 || col >= CURRENT_MAP[0].length) return true;
  // The front door's cell is solid until it's been opened — the map's own
  // value there doesn't matter, this always takes precedence.
  if (CURRENT_MAP === EXTERIOR_MAP && col === Math.floor(FRONT_DOOR.x) && row === Math.floor(FRONT_DOOR.y)) {
    return !state.frontDoorOpen;
  }
  return CURRENT_MAP[row][col] === 1;
}

// ---- door animation + walking through it -------------------------------------

function updateDoorAnimation(dt) {
  if (!doorPivot) return;
  const target = state.frontDoorOpen ? DOOR_OPEN_ANGLE : 0;
  const current = doorPivot.rotation.y;
  if (Math.abs(target - current) < 0.001) {
    doorPivot.rotation.y = target;
    return;
  }
  const step = DOOR_OPEN_SPEED * dt;
  doorPivot.rotation.y = target > current ? Math.min(target, current + step) : Math.max(target, current - step);
}

let transitioning = false;

// Once the door is open, walking into its exact cell (rather than pressing
// E again) is what actually moves you inside — the same way stepping
// through a real doorway works, rather than an instant teleport the moment
// you interact with the door.
function checkDoorCrossing() {
  if (transitioning || CURRENT_MAP !== EXTERIOR_MAP || !state.frontDoorOpen) return;
  const col = Math.floor(yawObject.position.x);
  const row = Math.floor(yawObject.position.z);
  if (col === Math.floor(FRONT_DOOR.x) && row === Math.floor(FRONT_DOOR.y)) {
    triggerDoorTransition();
  }
}

function triggerDoorTransition() {
  transitioning = true;
  const fade = document.getElementById("transition-fade");
  fade.classList.remove("hidden");
  requestAnimationFrame(() => fade.classList.add("active"));
  setTimeout(() => {
    spawnAt(FRONT_DOOR.interiorSpawn, INTERIOR_MAP);
    addLog(`${PROTAGONIST.name} steps inside. The door swings shut behind her.`);
    addLog("It's pitch black in here. She'll need to find some light.");
    fade.classList.remove("active");
    setTimeout(() => {
      fade.classList.add("hidden");
      transitioning = false;
    }, 300);
  }, 260);
}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function tryMovePlayer(dt) {
  if (state.activeNpc || transitioning) return; // frozen mid-dialogue or mid-transition

  let forwardInput = 0;
  if (keys.has("w") || keys.has("arrowup")) forwardInput += 1;
  if (keys.has("s") || keys.has("arrowdown")) forwardInput -= 1;
  let strafeInput = 0;
  if (keys.has("d")) strafeInput += 1;
  if (keys.has("a")) strafeInput -= 1;
  // Arrow left/right still rotate, as a keyboard-only fallback for anyone
  // not using mouse look.
  if (keys.has("arrowleft")) yawObject.rotation.y += 1.6 * dt;
  if (keys.has("arrowright")) yawObject.rotation.y -= 1.6 * dt;

  if (forwardInput === 0 && strafeInput === 0) return;

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

  if (CURRENT_MAP === EXTERIOR_MAP) {
    if (state.frontDoorOpen) return null; // already open — just walk in
    const doorDist = Math.hypot(FRONT_DOOR.x - px, FRONT_DOOR.y - py);
    if (doorDist < FRONT_DOOR.interactionDistance) {
      return { type: "frontDoor", label: FRONT_DOOR.label };
    }
    return null;
  }

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

  const exitDist = Math.hypot(EXIT.x - px, EXIT.y - py);
  if (exitDist < closestDist) {
    closest = {
      type: "exit",
      label: state.flags.cellarOpen ? "Descend into the cellar" : "The cellar door is locked",
    };
  }

  return closest;
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

  if (target.type === "frontDoor") {
    state.frontDoorOpen = true;
    addLog("The door creaks open.");
  } else if (target.type === "item") {
    const item = ITEMS.find((it) => it.id === target.id);
    state.inventory[target.id] = true;
    addLog(item.pickupText);
    if (
      (target.id === "flashlight" || target.id === "batteries") &&
      state.inventory.flashlight &&
      state.inventory.batteries
    ) {
      addLog("She has a working flashlight now. Press F to turn it on.");
    }
    renderHud();
    buildWorld(); // remove the collected item's marker from the scene
  } else if (target.type === "npc") {
    openDialogue(target.id);
  } else if (target.type === "exit") {
    if (state.flags.cellarOpen) {
      addLog("The cellar door creaks open onto darkness — more to explore beyond this prototype.");
    } else {
      addLog("The cellar door is locked tight. Someone here must have a key, or a reason to open it.");
    }
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

// ---- main loop -----------------------------------------------------------------

const clock = new THREE.Clock();

function gameLoop() {
  const dt = Math.min(0.1, clock.getDelta());
  tryMovePlayer(dt);
  updateDoorAnimation(dt);
  checkDoorCrossing();

  scene.fog.far = currentLightRange();
  flashlightLight.intensity = hasFlashlightOn() ? 2.4 : 0;
  ambientLight.intensity = CURRENT_MAP === EXTERIOR_MAP ? 0.35 : hasFlashlightOn() ? 0.22 : 0.06;

  updateInteractPrompt();
  renderer.render(scene, camera);
}

// ---- boot --------------------------------------------------------------------

showScreen("screen-title");