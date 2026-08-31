// ---------------------------------------------------------------------------
// GAME DATA

const EXTERIOR_MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const INTERIOR_MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 0, 1, 1, 0, 1],
  [1, 0, 1, 0, 0, 0, 1, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
];

let CURRENT_MAP = EXTERIOR_MAP;

const MAP_ROWS = CURRENT_MAP.length;
const MAP_COLS = CURRENT_MAP[0].length;

const PLAYER_START = { x: 5.5, y: 9.0, angle: -Math.PI / 2 };

const NPCS = [
  { id: "caretaker", x: 6.5, y: 3.5, color: "#8c8478", label: "C" },
  // Was (2.5, 6.5) — row 6 is the interior map's boundary wall, so at that
  // position the Groundskeeper was embedded inside a wall (invisible, since
  // sprites behind walls get occluded). Moved to an open tile in the same
  // corner of the map.
  { id: "groundskeeper", x: 2.5, y: 4.5, color: "#5c6b52", label: "G" },
];

const EXIT = { x: 1.5, y: 1.5 };

// Items scattered through the interior. Finding the flashlight AND the
// batteries is what lets Mara actually see past a few feet — see
// state.inventory / currentLightRange() in game.js. The camera doesn't do
// anything yet; it's a placeholder for a future puzzle mechanic.
const ITEMS = [
  {
    id: "flashlight",
    name: "Flashlight",
    x: 7.5,
    y: 1.5,
    color: "#c9a15c",
    pickupText: "A flashlight. Heavy, but the batteries are long dead.",
  },
  {
    id: "batteries",
    name: "Batteries",
    x: 1.5,
    y: 3.5,
    color: "#5c6b52",
    pickupText: "A pair of batteries, still sealed. With any luck, they still have charge.",
  },
  {
    id: "camera",
    name: "Camera",
    x: 5.5,
    y: 5.5,
    color: "#3a3a42",
    pickupText: "An old camera, half a roll of film still inside. Worth holding onto.",
  },
];

const PROTAGONIST = {
  name: "Maria Voss",
  color: "#6b6259",
  stats: { nerve: 3, insight: 4, resolve: 3 },
  storyIntro: "Something in John's letters stopped making sense months ago. I haven't heard from him in weeks. I better go check on him...I hope he's alright.",
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

const FRONT_DOOR = {
  id: "frontDoor",
  x: 5.5,
  y: 6.0,
  interactionDistance: 1.4,
  label: "Open Front Door",
  interiorSpawn: {
    x: 4.5,
    y: 5.5,
    angle: -Math.PI / 2,
  },
};