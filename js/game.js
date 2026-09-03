// ---------------------------------------------------------------------------
// GAME LOGIC
// Plain JS, no build step needed. Three screens:
//   1. Title screen (Start / Settings)
//   2. Settings screen
//   3. Explore screen — a first-person raycaster drawn to <canvas>
// The player is a fixed, pre-defined protagonist (see PROTAGONIST in
// data.js) — there is no character creation step.
// State lives in one object; the render loop reads from it every frame.
// ---------------------------------------------------------------------------

const state = {
  phase: "title", // "title" | "settings" | "explore"
  player: { ...PLAYER_START, pitch: 0 }, // x, y, angle (radians), pitch (px, look up/down)
  flags: {},
  log: [],
  activeNpc: null, // "caretaker" | "groundskeeper" | null
  dialogueNode: "start",
  settings: { showPrompts: true },
  settingsReturnTo: "title", // "title" | "paused" — where the Back button goes
  inventory: {}, // itemId -> true, once picked up
  flashlightOn: false,
};

const keys = new Set();

// Raycaster tuning
const FOV = (66 * Math.PI) / 180;
const MAX_DEPTH = 9;
const MOVE_SPEED = 0.045;
const ROT_SPEED = 0.045; // used only for arrow-key fallback rotation
const MOUSE_SENSITIVITY = 0.0022;
const PITCH_SENSITIVITY = 0.6;
const PLAYER_RADIUS = 0.22;
const INTERACT_DIST = 1.15;

// Vision range: full range once both the flashlight and batteries are in
// the inventory, a short oppressive range otherwise. Only the brightness
// falloff changes — walls are still raycast at full MAX_DEPTH — so this is
// cheap and doesn't affect collision or performance.
const LIT_RANGE = MAX_DEPTH;
const DARK_RANGE = 2.4;
const MOON_RANGE = MAX_DEPTH * 0.65; // ambient moonlight — dim, but not pitch black

// True only once the flashlight AND batteries are both in the inventory
// AND the player has actually switched it on with F.
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
  state.player = { ...PLAYER_START, pitch: 0 };
  state.flags = {};
  state.log = [];
  state.inventory = {};
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
    showScreen("screen-explore"); // pause overlay is still showing underneath
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
  if (document.pointerLockElement === canvas) {
    document.exitPointerLock();
  }
}

function closePauseMenu() {
  document.getElementById("pause-overlay").classList.add("hidden");
  state.phase = "explore";
  requestAnimationFrame(gameLoop); // the render loop stopped while paused
  // Called from a button click, so this is a valid user gesture.
  canvas.requestPointerLock();
}

document.getElementById("pause-resume-button").addEventListener("click", closePauseMenu);

document.getElementById("pause-settings-button").addEventListener("click", () => {
  state.settingsReturnTo = "paused";
  showScreen("screen-settings");
  renderSettings();
});

document.getElementById("pause-leave-button").addEventListener("click", () => {
  if (document.pointerLockElement === canvas) {
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
  renderHud();
  requestAnimationFrame(gameLoop);
  canvas.requestPointerLock();
});

// ---- typewriter effect ------------------------------------------------------

const storyString = PROTAGONIST.storyIntro;
let typeInterval;

function typeStory() {
  const textEl = document.getElementById("story-text");
  const promptEl = document.getElementById("story-prompt");

  // Reset screen state
  textEl.textContent = "";
  promptEl.classList.add("hidden");

  let i = 0;
  clearInterval(typeInterval);

  // Type one character every 40 milliseconds
  typeInterval = setInterval(() => {
    textEl.textContent += storyString.charAt(i);
    i++;

    if (i >= storyString.length) {
      clearInterval(typeInterval);
      // Fade in the prompt 1 second after text finishes
      setTimeout(() => {
        promptEl.classList.remove("hidden");
      }, 1000);
    }
  }, 80);
}

// ---- collision + movement ---------------------------------------------------

function isWall(x, y) {
  const col = Math.floor(x);
  const row = Math.floor(y);
  if (row < 0 || row >= CURRENT_MAP.length || col < 0 || col >= CURRENT_MAP[0].length) return true;
  return CURRENT_MAP[row][col] === 1;
}

function tryMovePlayer() {
  if (state.activeNpc) return; // frozen mid-dialogue

  // Arrow left/right still rotate, as a keyboard-only fallback for anyone
  // not using mouse look (e.g. pointer lock isn't available/granted).
  let rot = 0;
  if (keys.has("arrowleft")) rot -= ROT_SPEED;
  if (keys.has("arrowright")) rot += ROT_SPEED;
  state.player.angle += rot;

  // WASD drives movement relative to facing direction: W/S forward/back,
  // A/D strafe left/right. Arrow up/down also move forward/back.
  let forward = 0;
  if (keys.has("w") || keys.has("arrowup")) forward += 1;
  if (keys.has("s") || keys.has("arrowdown")) forward -= 1;

  let strafe = 0;
  if (keys.has("d")) strafe += 1;
  if (keys.has("a")) strafe -= 1;

  if (forward !== 0 || strafe !== 0) {
    const forwardAngle = state.player.angle;
    const strafeAngle = state.player.angle + Math.PI / 2;

    const dx = (Math.cos(forwardAngle) * forward + Math.cos(strafeAngle) * strafe) * MOVE_SPEED;
    const dy = (Math.sin(forwardAngle) * forward + Math.sin(strafeAngle) * strafe) * MOVE_SPEED;

    const nx = state.player.x + dx;
    const ny = state.player.y + dy;
    // Resolve X and Y separately so the player can slide along walls
    // instead of sticking when moving diagonally into a corner.
    if (!isWall(nx + Math.sign(dx || 1) * PLAYER_RADIUS, state.player.y)) {
      state.player.x = nx;
    }
    if (!isWall(state.player.x, ny + Math.sign(dy || 1) * PLAYER_RADIUS)) {
      state.player.y = ny;
    }
  }
}

// ---- mouse look (pointer lock) -------------------------------------------------
// Pointer lock gives truly unlimited look-around (no "stuck at the screen
// edge" problem) since the browser reports relative movement instead of
// absolute cursor position. The trade-off is a captured, invisible cursor
// — so we release the lock automatically the instant dialogue opens, and
// re-request it the instant dialogue closes, so choices are always
// clickable and looking around always has full range the rest of the time.

function requestLook() {
  if (state.phase === "explore" && !state.activeNpc && document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  }
}

function onPointerLockChange() {
  const hint = document.getElementById("pointer-lock-hint");
  const locked = document.pointerLockElement === canvas;
  const shouldShowHint = state.phase === "explore" && !state.activeNpc && !locked;
  hint.classList.toggle("hidden", !shouldShowHint);
}

function onMouseMove(e) {
  if (document.pointerLockElement !== canvas || state.activeNpc) return;
  state.player.angle += e.movementX * MOUSE_SENSITIVITY;
  state.player.pitch -= e.movementY * PITCH_SENSITIVITY;
  state.player.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, state.player.pitch));
}

// ---- raycasting render --------------------------------------------------------

const canvas = document.getElementById("viewport");
const ctx = canvas.getContext("2d");
let CW = 0;
let CH = 0;
let NUM_RAYS = 220;
let MAX_PITCH = 90;

function resizeCanvas() {
  CW = canvas.width = window.innerWidth;
  CH = canvas.height = window.innerHeight;
  // More screen width earns more rays (sharper columns), capped for perf.
  NUM_RAYS = Math.max(160, Math.min(480, Math.floor(CW / 3)));
  // Keep the look-up/down range proportional to the taller/shorter window.
  MAX_PITCH = CH * 0.35;
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

canvas.addEventListener("click", requestLook);
document.addEventListener("pointerlockchange", onPointerLockChange);
document.addEventListener("mousemove", onMouseMove);

// ---- wall texture (procedurally generated, no image files needed) -------------
// A small offscreen canvas holding a stone-brick pattern with a few random
// stains and cracks. Drawn once at load; sampled one column at a time when
// rendering walls, the same way a real raycaster samples a texture image.

const TEXTURE_SIZE = 64;

function createWallTexture() {
  const tCanvas = document.createElement("canvas");
  tCanvas.width = TEXTURE_SIZE;
  tCanvas.height = TEXTURE_SIZE;
  const tctx = tCanvas.getContext("2d");

  tctx.fillStyle = "#141010";
  tctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const brickW = 16;
  const brickH = 8;
  for (let y = 0; y < TEXTURE_SIZE; y += brickH) {
    const rowIndex = Math.floor(y / brickH);
    const offset = rowIndex % 2 === 0 ? 0 : brickW / 2;
    for (let x = -brickW; x < TEXTURE_SIZE + brickW; x += brickW) {
      const shade = 42 + Math.floor(Math.random() * 16);
      tctx.fillStyle = `rgb(${shade + 16}, ${shade + 9}, ${shade})`;
      tctx.fillRect(x + offset + 1, y + 1, brickW - 2, brickH - 2);
    }
  }

  // Dark stains, like old water or worse.
  for (let i = 0; i < 7; i++) {
    const sx = Math.random() * TEXTURE_SIZE;
    const sy = Math.random() * TEXTURE_SIZE;
    const r = 4 + Math.random() * 9;
    tctx.fillStyle = `rgba(15, 10, 10, ${0.15 + Math.random() * 0.25})`;
    tctx.beginPath();
    tctx.arc(sx, sy, r, 0, Math.PI * 2);
    tctx.fill();
  }

  // Thin cracks.
  tctx.strokeStyle = "rgba(8, 6, 6, 0.45)";
  tctx.lineWidth = 1;
  for (let i = 0; i < 2; i++) {
    let cx = Math.random() * TEXTURE_SIZE;
    let cy = 0;
    tctx.beginPath();
    tctx.moveTo(cx, cy);
    for (let s = 0; s < 5; s++) {
      cx += (Math.random() - 0.5) * 10;
      cy += TEXTURE_SIZE / 5;
      tctx.lineTo(cx, cy);
    }
    tctx.stroke();
  }

  return tCanvas;
}

const wallTexture = createWallTexture();

// A second texture for the exterior house walls — cooler grey stone with
// mossy green patches instead of the interior's warm brick and dark
// stains, so stepping outside reads visually distinct from being inside.
function createExteriorWallTexture() {
  const tCanvas = document.createElement("canvas");
  tCanvas.width = TEXTURE_SIZE;
  tCanvas.height = TEXTURE_SIZE;
  const tctx = tCanvas.getContext("2d");

  // Flat concrete-grey base rather than warm brick — panelka buildings are
  // precast concrete panels, not masonry.
  tctx.fillStyle = "#26302a";
  tctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // Large square panel seams, not small bricks — precast concrete panels
  // are big, so the "unit" here is much bigger than the interior's brick.
  const panelSize = 32;
  for (let y = 0; y < TEXTURE_SIZE; y += panelSize) {
    for (let x = 0; x < TEXTURE_SIZE; x += panelSize) {
      const shade = 28 + Math.floor(Math.random() * 10);
      tctx.fillStyle = `rgb(${shade + 8}, ${shade + 12}, ${shade + 9})`;
      tctx.fillRect(x + 1, y + 1, panelSize - 2, panelSize - 2);
    }
  }

  // Faint grime streaks instead of moss — concrete weathers with dark
  // vertical runoff stains, not organic growth.
  for (let i = 0; i < 5; i++) {
    const sx = Math.random() * TEXTURE_SIZE;
    tctx.fillStyle = `rgba(10, 14, 11, ${0.15 + Math.random() * 0.2})`;
    tctx.fillRect(sx, 0, 2 + Math.random() * 3, TEXTURE_SIZE);
  }

  // A 2x2 grid of windows per texture tile — since every wall cell repeats
  // this same texture, this reads as a dense, regular grid of apartment
  // windows running the length and height of the building, like a real
  // panel block rather than one house with one window.
  const windowW = 11;
  const windowH = 9;
  const cols = [10, 38];
  const rows = [6, 34];
  rows.forEach((windowY) => {
    cols.forEach((windowX) => {
      const lit = Math.random() < 0.4;
      tctx.fillStyle = lit ? "rgba(255, 195, 110, 0.65)" : "rgba(8, 10, 10, 0.8)";
      tctx.fillRect(windowX, windowY, windowW, windowH);
      tctx.strokeStyle = "rgba(15, 18, 15, 0.7)";
      tctx.lineWidth = 1;
      tctx.strokeRect(windowX, windowY, windowW, windowH);
      // A short ledge beneath each window — a cheap stand-in for the
      // balcony slabs panelka buildings are covered in.
      tctx.fillStyle = "rgba(18, 22, 19, 0.8)";
      tctx.fillRect(windowX - 2, windowY + windowH + 1, windowW + 4, 2);
    });
  });

  return tCanvas;
}

const exteriorWallTexture = createExteriorWallTexture();

// A fixed scatter of stars for the exterior sky, stored as fractions of
// the canvas so it holds up across resizes. Biased toward the upper half
// since that's roughly where the sky sits before accounting for pitch.
const STAR_COUNT = 90;
const stars = Array.from({ length: STAR_COUNT }, () => ({
  x: Math.random(),
  y: Math.random() * 0.5,
}));

// Falling snow — drawn across the whole exterior screen (not just the
// sky), updated a little every frame for a slow downward drift, and
// wrapped back to the top once a flake passes the bottom of the view.
const SNOW_COUNT = 70;
const snowflakes = Array.from({ length: SNOW_COUNT }, () => ({
  x: Math.random(),
  y: Math.random(),
  speed: 0.0012 + Math.random() * 0.0018,
  drift: (Math.random() - 0.5) * 0.0006,
}));

// ---- raycasting (DDA algorithm) ------------------------------------------------
// Steps through the grid one cell at a time along the ray's path (rather
// than marching in small fixed increments) until it hits a wall. This is
// the standard technique because, unlike simple step-marching, it also
// tells us exactly *where* on the wall face the ray landed (wallX) and
// which of the two wall orientations it hit (side) — both needed to sample
// the right column of a texture and to shade N/S-facing walls differently
// from E/W-facing ones.

function castRay(angle) {
  const rayDirX = Math.cos(angle);
  const rayDirY = Math.sin(angle);

  let mapX = Math.floor(state.player.x);
  let mapY = Math.floor(state.player.y);

  const deltaDistX = rayDirX === 0 ? Infinity : Math.abs(1 / rayDirX);
  const deltaDistY = rayDirY === 0 ? Infinity : Math.abs(1 / rayDirY);

  let stepX, sideDistX;
  if (rayDirX < 0) {
    stepX = -1;
    sideDistX = (state.player.x - mapX) * deltaDistX;
  } else {
    stepX = 1;
    sideDistX = (mapX + 1 - state.player.x) * deltaDistX;
  }

  let stepY, sideDistY;
  if (rayDirY < 0) {
    stepY = -1;
    sideDistY = (state.player.y - mapY) * deltaDistY;
  } else {
    stepY = 1;
    sideDistY = (mapY + 1 - state.player.y) * deltaDistY;
  }

  let side = 0;
  const maxSteps = CURRENT_MAP.length + CURRENT_MAP[0].length + 4; // more than enough to cross the map
  for (let steps = 0; steps < maxSteps; steps++) {
    if (sideDistX < sideDistY) {
      sideDistX += deltaDistX;
      mapX += stepX;
      side = 0; // hit a vertical (N/S-facing) wall face
    } else {
      sideDistY += deltaDistY;
      mapY += stepY;
      side = 1; // hit a horizontal (E/W-facing) wall face
    }
    if (mapY < 0 || mapY >= CURRENT_MAP.length || mapX < 0 || mapX >= CURRENT_MAP[0].length || CURRENT_MAP[mapY][mapX] === 1) {
      break;
    }
  }

  let perpWallDist;
  if (side === 0) {
    perpWallDist = (mapX - state.player.x + (1 - stepX) / 2) / rayDirX;
  } else {
    perpWallDist = (mapY - state.player.y + (1 - stepY) / 2) / rayDirY;
  }
  perpWallDist = Math.max(0.0001, Math.min(MAX_DEPTH, perpWallDist));

  // Exact fractional position along the wall face (0 to 1) — which column
  // of the texture to sample.
  let wallX;
  if (side === 0) {
    wallX = state.player.y + perpWallDist * rayDirY;
  } else {
    wallX = state.player.x + perpWallDist * rayDirX;
  }
  wallX -= Math.floor(wallX);

  return { dist: perpWallDist, side, wallX };
}

function drawScene() {
  const pitch = state.player.pitch;
  const horizon = CH / 2 + pitch;
  const outside = CURRENT_MAP === EXTERIOR_MAP;

  if (outside) {
    // Night sky with a scatter of stars, fading toward the horizon.
    const skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
    skyGrad.addColorStop(0, "#0a0918");
    skyGrad.addColorStop(1, "#1c1830");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, CW, horizon);

    ctx.fillStyle = "rgba(216, 211, 196, 0.85)";
    stars.forEach((s) => {
      const sx = s.x * CW;
      const sy = s.y * CH;
      if (sy < horizon) {
        ctx.fillRect(sx, sy, 1.5, 1.5);
      }
    });

    // Snowy, cold-toned ground rather than muddy grass.
    const groundGrad = ctx.createLinearGradient(0, horizon, 0, CH);
    groundGrad.addColorStop(0, "#3d453e");
    groundGrad.addColorStop(1, "#15190f");
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, horizon, CW, CH - horizon);
  } else {
    // Ceiling and floor — the horizon line shifts with pitch so looking up
    // reveals more ceiling and looking down reveals more floor.
    ctx.fillStyle = "#0b0a0d";
    ctx.fillRect(0, 0, CW, horizon);
    ctx.fillStyle = "#171310";
    ctx.fillRect(0, horizon, CW, CH - horizon);
  }

  const activeTexture = outside ? exteriorWallTexture : wallTexture;
  // The panelka block looms much taller than the interior's ceiling
  // height, implying many floors rather than a single-story house.
  const heightScale = outside ? 2.1 : 1;
  const colWidth = CW / NUM_RAYS;
  const zbuffer = new Array(NUM_RAYS);

  for (let i = 0; i < NUM_RAYS; i++) {
    const rayAngle = state.player.angle - FOV / 2 + (i / NUM_RAYS) * FOV;
    const { dist, side, wallX } = castRay(rayAngle);
    zbuffer[i] = dist;

    const wallH = Math.min(CH * 3, (CH / dist) * heightScale);
    const drawY = (CH - wallH) / 2 + pitch;

    // Sample one column of the texture at the wall's exact hit position.
    const texX = Math.min(TEXTURE_SIZE - 1, Math.floor(wallX * TEXTURE_SIZE));
    ctx.drawImage(activeTexture, texX, 0, 1, TEXTURE_SIZE, i * colWidth, drawY, colWidth + 1, wallH);

    // Distance fog plus a fixed darkening for one wall orientation — the
    // classic raycaster trick that makes corners and edges read clearly
    // even with a flat, single wall texture. Falls off much faster without
    // a working flashlight, which is what makes the dark actually dark.
    const lightRange = currentLightRange();
    const brightness = Math.max(0, 1 - dist / lightRange) * (side === 1 ? 0.72 : 1);
    const fogAlpha = Math.max(0, Math.min(1, 1 - brightness));
    ctx.fillStyle = `rgba(6, 5, 7, ${fogAlpha})`;
    ctx.fillRect(i * colWidth, drawY, colWidth + 1, wallH);
  }

  drawSprites(zbuffer, colWidth);

  // Falling snow sits in front of everything else outdoors — walls,
  // sprites, all of it — the same way real snow reads as closer than the
  // building behind it.
  if (outside) {
    ctx.fillStyle = "rgba(215, 224, 226, 0.75)";
    snowflakes.forEach((flake) => {
      flake.y += flake.speed;
      flake.x += flake.drift;
      if (flake.y > 1) {
        flake.y = 0;
        flake.x = Math.random();
      }
      if (flake.x > 1) flake.x -= 1;
      if (flake.x < 0) flake.x += 1;
      ctx.fillRect(flake.x * CW, flake.y * CH, 2, 2);
    });
  }

  // The flashlight's beam: a circle of clear visibility around the center
  // of the screen (where the player is looking), fading to darkness at the
  // edges. This sits on top of everything else already drawn.
  if (hasFlashlightOn()) {
    const beamRadius = Math.min(CW, CH) * 0.42;
    const beamGrad = ctx.createRadialGradient(CW / 2, CH / 2, 0, CW / 2, CH / 2, beamRadius);
    beamGrad.addColorStop(0, "rgba(0, 0, 0, 0)");
    beamGrad.addColorStop(0.5, "rgba(0, 0, 0, 0)");
    beamGrad.addColorStop(1, "rgba(4, 3, 5, 0.7)");
    ctx.fillStyle = beamGrad;
    ctx.fillRect(0, 0, CW, CH);
  }

  updateInteractPrompt();
}

function drawSprites(zbuffer, colWidth) {
  const pitch = state.player.pitch;
  const lightRange = currentLightRange();

  const sprites =
    CURRENT_MAP === EXTERIOR_MAP
      ? [{ x: FRONT_DOOR.x, y: FRONT_DOOR.y, color: "#2e2b20", isDoor: true, signText: FRONT_DOOR.signText }]
      : [
          ...NPCS,
          { x: EXIT.x, y: EXIT.y, color: "#8a1f1f", isExit: true },
          ...ITEMS.filter((it) => !state.inventory[it.id]).map((it) => ({
            x: it.x,
            y: it.y,
            color: it.color,
            isItem: true,
          })),
        ];

  sprites.forEach((sprite) => {
    const dx = sprite.x - state.player.x;
    const dy = sprite.y - state.player.y;
    const dist = Math.hypot(dx, dy);
    let angleToSprite = Math.atan2(dy, dx) - state.player.angle;
    // normalize to [-PI, PI]
    angleToSprite = Math.atan2(Math.sin(angleToSprite), Math.cos(angleToSprite));

    if (Math.abs(angleToSprite) > FOV / 2 + 0.2) return; // outside view cone

    const screenX = (0.5 + angleToSprite / FOV) * CW;
    const col = Math.max(0, Math.min(NUM_RAYS - 1, Math.floor(screenX / colWidth)));
    if (dist > zbuffer[col]) return; // hidden behind a wall

    const sizeFactor = sprite.isDoor ? 0.85 : sprite.isExit ? 0.5 : sprite.isItem ? 0.35 : 0.75;
    const size = Math.min(CH, CH / dist) * sizeFactor;
    const brightness = Math.max(0.05, 1 - dist / lightRange);
    const centerY = (CH - size) / 2 + pitch + size / 2;

    // A sickly green-yellow floodlight halo behind the door — the kind of
    // sodium/mercury-vapor glow that washes a whole building entrance in
    // one eerie color, the way it does over old apartment block entryways.
    if (sprite.isDoor) {
      const glowRadius = size * 1.1;
      const glow = ctx.createRadialGradient(screenX, centerY, 0, screenX, centerY, glowRadius);
      glow.addColorStop(0, `rgba(195, 225, 130, ${0.4 * brightness})`);
      glow.addColorStop(1, "rgba(195, 225, 130, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(screenX - glowRadius, centerY - glowRadius, glowRadius * 2, glowRadius * 2);
    }

    ctx.globalAlpha = brightness;
    ctx.fillStyle = sprite.color;
    ctx.fillRect(screenX - size / 4, (CH - size) / 2 + pitch, size / 2, size);
    ctx.globalAlpha = 1;

    // A backlit sign box above the entrance — a solid glowing panel with
    // dark text on it, like an illuminated plastic shop/entrance sign,
    // rather than just floating text. Sized and faded by the same
    // distance math as everything else.
    if (sprite.signText) {
      const fontSize = Math.max(7, Math.min(22, (CH / dist) * 0.09));
      ctx.font = `bold ${fontSize}px "Courier New", monospace`;
      ctx.textAlign = "center";
      const textWidth =
        typeof ctx.measureText === "function"
          ? ctx.measureText(sprite.signText).width
          : sprite.signText.length * fontSize * 0.6;
      const padX = fontSize * 0.7;
      const padY = fontSize * 0.5;
      const boxW = Math.max(1, textWidth + padX * 2);
      const boxH = Math.max(1, fontSize + padY * 2);
      const signCenterY = centerY - size / 2 - fontSize * 1.3;

      ctx.fillStyle = `rgba(200, 230, 140, ${Math.min(0.92, brightness + 0.25)})`;
      ctx.fillRect(screenX - boxW / 2, signCenterY - boxH / 2, boxW, boxH);

      ctx.fillStyle = `rgba(20, 22, 12, ${Math.min(1, brightness + 0.35)})`;
      ctx.fillText(sprite.signText, screenX, signCenterY + fontSize * 0.35);
    }
  });
}

// ---- interaction (proximity + "E") -------------------------------------------

function nearestInteractable() {
  let closest = null;
  let closestDist = INTERACT_DIST;

  if (CURRENT_MAP === EXTERIOR_MAP) {
    const doorDist = Math.hypot(FRONT_DOOR.x - state.player.x, FRONT_DOOR.y - state.player.y);
    if (doorDist < FRONT_DOOR.interactionDistance) {
      closest = { type: "frontDoor", label: FRONT_DOOR.label };
    }
    return closest;
  }

  NPCS.forEach((npc) => {
    const d = Math.hypot(npc.x - state.player.x, npc.y - state.player.y);
    if (d < closestDist) {
      closestDist = d;
      closest = { type: "npc", id: npc.id, label: `Talk to the ${capitalize(npc.id)}` };
    }
  });

  ITEMS.forEach((item) => {
    if (state.inventory[item.id]) return; // already collected
    const d = Math.hypot(item.x - state.player.x, item.y - state.player.y);
    if (d < closestDist) {
      closestDist = d;
      closest = { type: "item", id: item.id, label: `Pick up ${item.name}` };
    }
  });

  const exitDist = Math.hypot(EXIT.x - state.player.x, EXIT.y - state.player.y);
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
    CURRENT_MAP = INTERIOR_MAP;
    state.player.x = FRONT_DOOR.interiorSpawn.x;
    state.player.y = FRONT_DOOR.interiorSpawn.y;
    state.player.angle = FRONT_DOOR.interiorSpawn.angle;
    state.player.pitch = 0;
    addLog(`${PROTAGONIST.name} steps inside. The door swings shut behind her.`);
    addLog("It's pitch black in here. She'll need to find some light.");
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
  // Release the lock so the cursor reappears and choices are clickable.
  if (document.pointerLockElement === canvas) {
    document.exitPointerLock();
  }
}

function closeDialogue() {
  state.activeNpc = null;
  document.getElementById("dialogue-overlay").classList.add("hidden");
  // This is called from a click handler (a choice or the exit button), so
  // it's a valid user gesture and re-locking here is allowed.
  canvas.requestPointerLock();
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

function gameLoop() {
  tryMovePlayer();
  drawScene();
  if (state.phase === "explore") {
    requestAnimationFrame(gameLoop);
  }
}

// ---- boot --------------------------------------------------------------------

showScreen("screen-title");