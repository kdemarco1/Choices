// ---------------------------------------------------------------------------
// GAME DATA
// Keep content (classes, map layout, dialogue trees) separate from game
// logic (game.js). Add new NPCs, rooms, and stat checks here without
// touching how the game runs.
//
// MAP is a binary grid for the raycaster: 0 = open floor, 1 = wall.
// NPCS and the EXIT are placed at floating-point coordinates inside that
// grid (e.g. x: 7.5 means "the middle of column 7").
// ---------------------------------------------------------------------------

const MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 0, 1, 1, 0, 1],
  [1, 0, 1, 0, 0, 0, 1, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 1, 1, 0, 1, 0, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const MAP_ROWS = MAP.length;
const MAP_COLS = MAP[0].length;

const PLAYER_START = { x: 1.5, y: 1.5, angle: 0 };

const NPCS = [
  { id: "caretaker", x: 7.5, y: 1.5, color: "#8c8478", label: "C" },
  { id: "groundskeeper", x: 1.5, y: 6.5, color: "#5c6b52", label: "G" },
];

const EXIT = { x: 7.5, y: 6.5 };

const PROTAGONIST = {
  name: "Maria Voss",
  color: "#6b6259",
  stats: { nerve: 3, insight: 4, resolve: 3 },
};

const DIALOGUES = {
  caretaker: {
    start: {
      speaker: "The Caretaker",
      text: "You shouldn't have come here. The house doesn't like visitors — and it's not fond of the ones who stay, either.",
      choices: [
        { label: "I'm looking for someone who went missing.", next: "missing" },
        { label: "[Insight] Your hands are shaking. What happened to them?", check: { stat: "insight", min: 4 }, next: "insight_hands" },
        { label: "I'll leave you be.", next: "passing" },
      ],
    },
    missing: {
      speaker: "The Caretaker",
      text: "Missing. That's one word for it. There's a door in the cellar that stopped opening the same week your friend stopped answering letters.",
      choices: [
        { label: "Take me to the cellar.", next: null, setFlags: { hasCaretakerLead: true } },
      ],
    },
    insight_hands: {
      speaker: "The Caretaker",
      text: "...Perceptive. They shake because I keep them where I can see them. Whatever's in the cellar prefers hands that are out of sight.",
      choices: [
        { label: "Tell me about the cellar.", next: null, setFlags: { hasCaretakerLead: true, caretakerTrust: true } },
      ],
    },
    passing: {
      speaker: "The Caretaker",
      text: "Wise. Go before the light changes — it doesn't ask twice.",
      choices: [{ label: "Leave.", next: null }],
    },
  },
  groundskeeper: {
    start: {
      speaker: "The Groundskeeper",
      text: "That door stays shut. Some things are better left where they fell.",
      choices: [
        { label: "[Nerve] Push past him — you're going down there regardless.", check: { stat: "nerve", min: 4 }, next: "nerve_pass" },
        { label: "[Resolve] I'm not afraid of what's down there. Not anymore.", check: { stat: "resolve", min: 4 }, next: "resolve_pass", requiresFlag: "hasCaretakerLead" },
        { label: "I'll respect that, for now.", next: "neutral" },
      ],
    },
    nerve_pass: {
      speaker: "The Groundskeeper",
      text: "...You've got more nerve than sense. Fine. Just remember — it only takes what you offer it.",
      choices: [{ label: "Understood.", next: null, setFlags: { cellarOpen: true, groundskeeperWary: true } }],
    },
    resolve_pass: {
      speaker: "The Groundskeeper",
      text: "The Caretaker sent you, and you're still standing here steady. Alright. Steady is more than most manage.",
      choices: [{ label: "Open the door.", next: null, setFlags: { cellarOpen: true, groundskeeperRespect: true } }],
    },
    neutral: {
      speaker: "The Groundskeeper",
      text: "Good. Go find somewhere else to be before dark.",
      choices: [{ label: "I will.", next: null }],
    },
  },
};