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
  player: { ...PLAYER_START }, // x, y, angle (radians)
  flags: {},
  log: [],
  activeNpc: null, // "caretaker" | "groundskeeper" | null
  dialogueNode: "start",
  settings: { showPrompts: true },
};

const keys = new Set();

// Raycaster tuning
const FOV = (66 * Math.PI) / 180;
const NUM_RAYS = 220;
const MAX_DEPTH = 9;
const RAY_STEP = 0.02;
const MOVE_SPEED = 0.045;
const ROT_SPEED = 0.045;
const PLAYER_RADIUS = 0.22;
const INTERACT_DIST = 1.15;

function addLog(entry) {
  state.log.unshift(entry);
  state.log = state.log.slice(0, 6);
  renderLog();
}

// ---- screen switching -----------------------------------------------------

function showScreen(id) {
  ["screen-title", "screen-settings", "screen-explore"].forEach((s) => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

// ---- title screen -----------------------------------------------------------

document.getElementById("title-start-button").addEventListener("click", () => {
  state.stats = { ...PROTAGONIST.stats };
  state.phase = "explore";
  showScreen("screen-explore");
  addLog(`${PROTAGONIST.name} steps through the front door of the manor.`);
  renderHud();
  requestAnimationFrame(gameLoop);
});

document.getElementById("title-settings-button").addEventListener("click", () => {
  state.phase = "settings";
  showScreen("screen-settings");
  renderSettings();
});

document.getElementById("settings-back-button").addEventListener("click", () => {
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
  hud.innerHTML = `
    <div class="portrait" style="background:${PROTAGONIST.color}">${PROTAGONIST.name.charAt(0)}</div>
    <div>
      <div class="hud-name">${PROTAGONIST.name}</div>
      <div class="stat-line">NRV ${state.stats.nerve} · INS ${state.stats.insight} · RES ${state.stats.resolve}</div>
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

// ---- collision + movement ---------------------------------------------------

function isWall(x, y) {
  const col = Math.floor(x);
  const row = Math.floor(y);
  if (row < 0 || row >= MAP_ROWS || col < 0 || col >= MAP_COLS) return true;
  return MAP[row][col] === 1;
}

function tryMovePlayer() {
  if (state.activeNpc) return; // frozen mid-dialogue

  let rot = 0;
  if (keys.has("arrowleft") || keys.has("a")) rot -= ROT_SPEED;
  if (keys.has("arrowright") || keys.has("d")) rot += ROT_SPEED;
  state.player.angle += rot;

  let move = 0;
  if (keys.has("arrowup") || keys.has("w")) move += MOVE_SPEED;
  if (keys.has("arrowdown") || keys.has("s")) move -= MOVE_SPEED;

  if (move !== 0) {
    const nx = state.player.x + Math.cos(state.player.angle) * move;
    const ny = state.player.y + Math.sin(state.player.angle) * move;
    // Resolve X and Y separately so the player can slide along walls
    // instead of sticking when moving diagonally into a corner.
    if (!isWall(nx + Math.sign(move) * PLAYER_RADIUS * Math.cos(state.player.angle), state.player.y)) {
      state.player.x = nx;
    }
    if (!isWall(state.player.x, ny + Math.sign(move) * PLAYER_RADIUS * Math.sin(state.player.angle))) {
      state.player.y = ny;
    }
  }
}

// ---- raycasting render --------------------------------------------------------

const canvas = document.getElementById("viewport");
const ctx = canvas.getContext("2d");
const CW = canvas.width;
const CH = canvas.height;

function castRay(angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let dist = 0;
  while (dist < MAX_DEPTH) {
    dist += RAY_STEP;
    const testX = state.player.x + cos * dist;
    const testY = state.player.y + sin * dist;
    if (isWall(testX, testY)) break;
  }
  return Math.min(dist, MAX_DEPTH);
}

function drawScene() {
  // Ceiling and floor
  ctx.fillStyle = "#0b0a0d";
  ctx.fillRect(0, 0, CW, CH / 2);
  ctx.fillStyle = "#171310";
  ctx.fillRect(0, CH / 2, CW, CH / 2);

  const colWidth = CW / NUM_RAYS;
  const zbuffer = new Array(NUM_RAYS);

  for (let i = 0; i < NUM_RAYS; i++) {
    const rayAngle = state.player.angle - FOV / 2 + (i / NUM_RAYS) * FOV;
    const rawDist = castRay(rayAngle);
    const correctedDist = rawDist * Math.cos(rayAngle - state.player.angle);
    zbuffer[i] = correctedDist;

    const wallH = Math.min(CH, CH / correctedDist);
    const brightness = Math.max(0, 1 - correctedDist / MAX_DEPTH);
    const shade = Math.floor(40 + brightness * 70);
    ctx.fillStyle = `rgb(${shade}, ${Math.floor(shade * 0.9)}, ${Math.floor(shade * 0.85)})`;
    ctx.fillRect(i * colWidth, (CH - wallH) / 2, colWidth + 1, wallH);
  }

  drawSprites(zbuffer, colWidth);
  updateInteractPrompt();
}

function drawSprites(zbuffer, colWidth) {
  const sprites = [...NPCS, { x: EXIT.x, y: EXIT.y, color: "#8a1f1f", isExit: true }];

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

    const size = Math.min(CH, CH / dist) * (sprite.isExit ? 0.5 : 0.75);
    const brightness = Math.max(0.15, 1 - dist / MAX_DEPTH);
    ctx.globalAlpha = brightness;
    ctx.fillStyle = sprite.color;
    ctx.fillRect(screenX - size / 4, (CH - size) / 2, size / 2, size);
    ctx.globalAlpha = 1;
  });
}

// ---- interaction (proximity + "E") -------------------------------------------

function nearestInteractable() {
  let closest = null;
  let closestDist = INTERACT_DIST;

  NPCS.forEach((npc) => {
    const d = Math.hypot(npc.x - state.player.x, npc.y - state.player.y);
    if (d < closestDist) {
      closestDist = d;
      closest = { type: "npc", id: npc.id, label: `Talk to the ${capitalize(npc.id)}` };
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

  if (target.type === "npc") {
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
  if (state.phase !== "explore") return;
  const key = e.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(key)) {
    e.preventDefault();
    keys.add(key);
  }
  if (key === "e") handleInteract();
  if (key === "escape" && state.activeNpc) closeDialogue();
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
}

function closeDialogue() {
  state.activeNpc = null;
  document.getElementById("dialogue-overlay").classList.add("hidden");
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