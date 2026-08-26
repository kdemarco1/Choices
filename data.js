// ---------------------------------------------------------------------------
// GAME DATA
// Keep content (classes, map layout, dialogue trees) separate from game
// logic (game.js). Add new NPCs, rooms, and stat checks here without
// touching how the game runs.
// ---------------------------------------------------------------------------

const GRID_SIZE = 9;

const CLASSES = [
  { id: "skeptic", name: "The Skeptic", tagline: "Doesn't believe in ghosts. Yet.", stats: { nerve: 5, insight: 2, resolve: 2 } },
  { id: "investigator", name: "The Investigator", tagline: "Notices what others miss, for better or worse.", stats: { nerve: 2, insight: 5, resolve: 2 } },
  { id: "empath", name: "The Empath", tagline: "Feels what the house wants you to feel.", stats: { nerve: 2, insight: 2, resolve: 5 } },
];

const PORTRAIT_COLORS = ["#8a1f1f", "#5c6b52", "#6b6259", "#3a3a42", "#9c8b6f"];

// Map legend: 0 floor, 1 wall, 2 NPC "caretaker", 3 NPC "groundskeeper", 4 cellar door
const MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 2, 1],
  [1, 0, 1, 1, 0, 1, 1, 0, 1],
  [1, 0, 1, 0, 0, 0, 1, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 1, 1, 0, 1, 0, 1, 1, 1],
  [1, 3, 0, 0, 0, 0, 0, 4, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const PLAYER_START = { x: 1, y: 1 };

// Dialogue trees keyed by NPC id. Each node has text and a list of choices.
// A choice may require a stat threshold ("check"), may require a flag set
// earlier ("requiresFlag"), and can set flags that persist for the rest of
// the playthrough ("setFlags") to influence later text and choices.
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