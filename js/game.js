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
  stats: null,
  player: { ...PLAYER_START, pitch: 0 }, // x, y, angle (radians), pitch (px, look up/down)
  flags: {},
  log: [],
  activeNpc: null, // "caretaker" | "groundskeeper" | null
  dialogueNode: "start",
  settings: { showPrompts: true },
  settingsReturnTo: "title", // "title" | "paused" — where the Back button goes
  inventory: {}, // itemId -> true, once picked up
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

function currentLightRange() {
  return state.inventory.flashlight && state.inventory.batteries ? LIT_RANGE : DARK_RANGE;
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
  state.stats = { ...PROTAGONIST.stats };
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
  hud.innerHTML = `
    <div class="portrait" style="background:${PROTAGONIST.color}">${PROTAGONIST.name.charAt(0)}</div>
    <div>
      <div class="hud-name">${PROTAGONIST.name}</div>
      <div class="stat-line">NRV ${state.stats.nerve} · INS ${state.stats.insight} · RES ${state.stats.resolve}</div>
      <div class="stat-line">Carrying: ${carriedNames || "nothing"}</div>
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

// ---- story screen (UPDATED) -------------------------------------------------

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

const storyString = "Something in John's letters stopped making sense a month ago. It has been 2 weeks now with no word from him. I hope he's alright...";
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
  }, 40); 
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

  // Ceiling and floor — the horizon line shifts with pitch so looking up
  // reveals more ceiling and looking down reveals more floor.
  ctx.fillStyle = "#0b0a0d";
  ctx.fillRect(0, 0, CW, horizon);
  ctx.fillStyle = "#171310";
  ctx.fillRect(0, horizon, CW, CH - horizon);

  const colWidth = CW / NUM_RAYS;
  const zbuffer = new Array(NUM_RAYS);

  for (let i = 0; i < NUM_RAYS; i++) {
    const rayAngle = state.player.angle - FOV / 2 + (i / NUM_RAYS) * FOV;
    const { dist, side, wallX } = castRay(rayAngle);
    zbuffer[i] = dist;

    const wallH = Math.min(CH * 3, CH / dist);
    const drawY = (CH - wallH) / 2 + pitch;

    // Sample one column of the texture at the wall's exact hit position.
    const texX = Math.min(TEXTURE_SIZE - 1, Math.floor(wallX * TEXTURE_SIZE));
    ctx.drawImage(wallTexture, texX, 0, 1, TEXTURE_SIZE, i * colWidth, drawY, colWidth + 1, wallH);

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
  updateInteractPrompt();
}

function drawSprites(zbuffer, colWidth) {
  const pitch = state.player.pitch;
  const lightRange = currentLightRange();

  const sprites =
    CURRENT_MAP === EXTERIOR_MAP
      ? [{ x: FRONT_DOOR.x, y: FRONT_DOOR.y, color: "#8a1f1f", isExit: true }]
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

    const sizeFactor = sprite.isExit ? 0.5 : sprite.isItem ? 0.35 : 0.75;
    const size = Math.min(CH, CH / dist) * sizeFactor;
    const brightness = Math.max(0.05, 1 - dist / lightRange);
    ctx.globalAlpha = brightness;
    ctx.fillStyle = sprite.color;
    ctx.fillRect(screenX - size / 4, (CH - size) / 2 + pitch, size / 2, size);
    ctx.globalAlpha = 1;
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

function passesCheck(choice) {
  if (!choice.check) return true;
  return state.stats[choice.check.stat] >= choice.check.min;
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
    const ok = passesCheck(choice);
    const btn = document.createElement("button");
    btn.className = "choice-button";
    btn.disabled = !ok;
    btn.innerHTML = choice.label + (choice.check && !ok
      ? ` <span class="check-fail">— needs ${choice.check.stat} ${choice.check.min}+</span>`
      : "");
    btn.addEventListener("click", () => {
      if (!ok) return;
      chooseDialogueOption(choice);
    });
    choicesEl.appendChild(btn);
  });
}

function chooseDialogueOption(choice) {
  if (choice.setFlags) {
    state.flags = { ...state.flags, ...choice.setFlags };
  }
  addLog(`You: "${choice.label.replace(/^\[[^\]]+\]\s*/, "")}"`);

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