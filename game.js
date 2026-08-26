// ---------------------------------------------------------------------------
// GAME LOGIC
// Plain JS, no build step needed — open index.html directly or serve the
// folder (GitHub Pages works great). State lives in one object and every
// screen re-renders from it, so it's easy to reason about and to add a
// save/load system later (just JSON.stringify(state)).
// ---------------------------------------------------------------------------

const state = {
  phase: "create", // "create" | "explore"
  name: "",
  classId: "warrior",
  color: PORTRAIT_COLORS[0],
  stats: null,
  player: { ...PLAYER_START },
  flags: {},
  log: [],
  activeNpc: null, // "elder" | "guard" | null
  dialogueNode: "start",
};

function addLog(entry) {
  state.log.unshift(entry);
  state.log = state.log.slice(0, 6);
  renderLog();
}

// ---- character creation screen -------------------------------------------

function renderCreateScreen() {
  const classRow = document.getElementById("class-row");
  classRow.innerHTML = "";
  CLASSES.forEach((cls) => {
    const btn = document.createElement("button");
    btn.className = "class-card" + (state.classId === cls.id ? " selected" : "");
    btn.innerHTML = `
      <div class="class-name">${cls.name}</div>
      <div class="class-tagline">${cls.tagline}</div>
      <div class="stat-line">NRV ${cls.stats.nerve} · INS ${cls.stats.insight} · RES ${cls.stats.resolve}</div>
    `;
    btn.addEventListener("click", () => {
      state.classId = cls.id;
      renderCreateScreen();
    });
    classRow.appendChild(btn);
  });

  const colorRow = document.getElementById("color-row");
  colorRow.innerHTML = "";
  PORTRAIT_COLORS.forEach((color) => {
    const btn = document.createElement("button");
    btn.className = "color-swatch" + (state.color === color ? " selected" : "");
    btn.style.background = color;
    btn.setAttribute("aria-label", `Choose color ${color}`);
    btn.addEventListener("click", () => {
      state.color = color;
      renderCreateScreen();
    });
    colorRow.appendChild(btn);
  });

  const selectedClass = CLASSES.find((c) => c.id === state.classId);
  document.getElementById("preview-portrait").style.background = state.color;
  document.getElementById("preview-portrait").textContent = (state.name || "?").charAt(0).toUpperCase();
  document.getElementById("preview-name").textContent = state.name || "Unnamed traveler";
  document.getElementById("preview-class").textContent = selectedClass.name;
}

document.getElementById("name-input").addEventListener("input", (e) => {
  state.name = e.target.value;
  renderCreateScreen();
});

document.getElementById("start-button").addEventListener("click", () => {
  const cls = CLASSES.find((c) => c.id === state.classId);
  state.stats = { ...cls.stats };
  state.phase = "explore";
  document.getElementById("screen-create").classList.add("hidden");
  document.getElementById("screen-explore").classList.remove("hidden");
  addLog(`${state.name || "The visitor"}, ${cls.name}, steps through the front door of the manor.`);
  renderExploreScreen();
});

// ---- explore screen --------------------------------------------------------

function renderHud() {
  const hud = document.getElementById("hud");
  hud.innerHTML = `
    <div class="portrait" style="background:${state.color}">${(state.name || "?").charAt(0).toUpperCase()}</div>
    <div>
      <div class="hud-name">${state.name || "Unnamed traveler"}</div>
      <div class="stat-line">NRV ${state.stats.nerve} · INS ${state.stats.insight} · RES ${state.stats.resolve}</div>
    </div>
  `;
}

function renderMap() {
  const grid = document.getElementById("map-grid");
  grid.style.gridTemplateColumns = `repeat(${GRID_SIZE}, 34px)`;
  grid.style.gridTemplateRows = `repeat(${GRID_SIZE}, 34px)`;
  grid.innerHTML = "";

  MAP.forEach((row, y) => {
    row.forEach((tile, x) => {
      const div = document.createElement("div");
      const isPlayer = state.player.x === x && state.player.y === y;
      let classes = "tile";
      let content = "";
      if (tile === 1) classes += " wall";
      if (tile === 2) content = "C";
      if (tile === 3) content = "G";
      if (tile === 4) classes += " exit";
      if (isPlayer) {
        classes += " player";
        content = "@";
      }
      div.className = classes;
      div.textContent = content;
      grid.appendChild(div);
    });
  });
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

function renderExploreScreen() {
  renderHud();
  renderMap();
  renderLog();
}

// ---- movement --------------------------------------------------------------

function tryMove(dx, dy) {
  if (state.activeNpc) return; // no movement mid-dialogue
  const nx = state.player.x + dx;
  const ny = state.player.y + dy;
  const tile = MAP[ny] ? MAP[ny][nx] : undefined;
  if (tile === undefined || tile === 1) return;

  if (tile === 2) {
    openDialogue("caretaker");
    return;
  }
  if (tile === 3) {
    openDialogue("groundskeeper");
    return;
  }
  if (tile === 4) {
    if (state.flags.cellarOpen) {
      addLog("The cellar door creaks open onto darkness — more to explore beyond this prototype.");
    } else {
      addLog("The cellar door is locked tight. Someone here must have a key, or a reason to open it.");
    }
  }

  state.player = { x: nx, y: ny };
  renderMap();
}

window.addEventListener("keydown", (e) => {
  if (state.phase !== "explore") return;
  const moves = {
    ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
    ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
    ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
    ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
  };
  if (moves[e.key]) {
    e.preventDefault();
    tryMove(moves[e.key][0], moves[e.key][1]);
  }
  if (e.key === "Escape" && state.activeNpc) {
    closeDialogue();
  }
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

// ---- boot --------------------------------------------------------------------

renderCreateScreen();