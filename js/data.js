// ---------------------------------------------------------------------------
// GAME DATA — one continuous map. Rows 0-5 are the building interior (one
// large open room), row 6 is the front door (the only gap in an otherwise
// fully sealed facade), rows 7-11 are the empty street outside. There is no
// map-switching: walking through the open door just continues into the
// same physical space, and the only way in or out is that door — the
// facade is solid across its entire width except for the door's cell.

// Layout (21 columns x 20 rows). '#' = wall, '.' = open floor.
//  rows 1-3   apartments 1, 2, 3, 4 (cols 1-3, 5-7, 9-11, 13-15) and the stairwell (cols 17-19)
//  row 4      doors into them (cols 2, 6, 10, 14, 18)
//  rows 5-6   the hallway
//  row 7      hallway/lobby wall — the hall door (col 8), plus the elevator and a staff
//             door drawn on the lobby side only (see FIXTURES)
//  rows 8-12  the lobby, reception desk on the left of the front door
//  row 13     the facade — solid except the front door gap at col 8
//  rows 14-18 the front yard ('x' = hedge at the left/right edge, curb along the road at row 19);
//             the road runs behind you past row 19 and can't be crossed
const MAP_ROWS_TEXT = [
  "#####################################################", // 0
  "#...#...#...#...#...###...#...####...##########.....#", // 1  apartments 1-3 and John's (4), then the stairwell
  "#...#...#...#...#...###...#...####...##########.....#", // 2
  "#...#...#...#...#...###...#...####...........##.....#", // 3
  "########################.###.#####...##########.....#", // 4  apartment + stairwell doors
  "#....#..............###.........##...################", // 5  hallway
  "#....#..............###.........#####################", // 6
  "#####################################################", // 7  lobby wall (hall door, elevator and staff door on the lobby side)
  "#...................#################################", // 8  lobby
  "#...................#################################", // 9
  "#...................#################################", // 10
  "#...................#################################", // 11
  "#...................#################################", // 12
  "########.############################################", // 13 facade, front door at col 8
  "x...................x################################", // 14 street
  "x...................x################################", // 15
  "x...................x################################", // 16
  "x...................x################################", // 17
  "x...................x################################", // 18 player start
  "xxxxxxxxxxxxxxxxxxxxx################################", // 19
];
// 0 = open, 1 = wall (drawn), 2 = invisible-solid barrier (hedge at the yard edges, curb along the road)
const MAP = MAP_ROWS_TEXT.map((row) => Array.from(row).map((ch) => (ch === "#" ? 1 : ch === "x" ? 2 : 0)));

// Floor cells that are solid but drawn as props instead of wall blocks
// (the staircase fills the back of the stairwell).
const BLOCKED_CELLS = [[17, 1], [18, 1], [19, 1], [17, 2], [18, 2], [19, 2], [7, 15], [9, 15], [2, 15], [4, 17], [14, 15], [17, 17], [41, 3]]; // + the entrance columns and four yard trees

const PLAYER_START = { x: 8.5, y: 18.0, angle: -Math.PI / 2 };

const NPCS = [];

const ITEMS = [
  {
    id: "flashlight",
    name: "Flashlight",
    x: 5.7,
    y: 12.1, // on the reception desk, just past the front door, to the left as you enter
    color: "#c9a15c",
    height: 0.85,
    pickupText: "A flashlight, sitting on the reception desk.",
  },
  {
    id: "johnKey",
    name: "Brass Key",
    x: 6.5,
    y: 1.7, // on the table inside Apartment 2
    color: "#d4b04a",
    height: 0.9,
    pickupText: "A brass key on a paper tag: 4.",
  },
  { id: "axe", name: "Axe", x: 14.5, y: 1.6, /* under John's bed */ color: "#999999", height: 0.9, pickupText: "A fire axe." },
  { id: "johnNote", name: "John's Note", note: true, h: 0.76, x: 15.45, y: 3.15, paper: "Sept 21\nthird week. no sleep.\nit stands in the hall at night. {i can't} look at it\nI hid the axe under my bed\nin case", sloppy: 0.5, seed: 3 },
  { id: "batteries", name: "Batteries", h: 0.76, x: 15.45, y: 2.4, pickupText: "Spare batteries." },
  { id: "staffNote", name: "Notice", note: true, x: 4.2, y: 5.7, paper: "Power out again?\nMain breaker is on the\nnorth wall.\n- Mgmt", sloppy: 0.1, seed: 7 },
  { id: "note1", name: "Torn Page", note: true, x: 24.5, y: 1.6, paper: "john won't sleep\nsays it walks the halls\nwhen the {lights} die\n{he stopped answering}", sloppy: 0.9, seed: 11 },
  { id: "note2", name: "Letter", note: true, x: 28.5, y: 1.6, paper: "DONT go below\n{ something sealed }\nin the cellar.\nkeep your light ON", sloppy: 0.8, seed: 5 },
  { id: "note3", name: "Scrap of Paper", note: true, x: 23.7, y: 5.5, paper: "it only stops when\nsomeone goes into {his}\nroom. the key is 4", sloppy: 0.7, seed: 9 },
];

// Spots you can use with E. 'go' teleports between levels.
const HOTSPOTS = [
  { id: "cellar", x: 17.5, y: 3.55, label: "Go Down", go: { x: 35.5, y: 3.5, yaw: -Math.PI / 2 } },
  { id: "cellarUp", x: 34.5, y: 4.8, label: "Go Up", go: { x: 17.5, y: 3.2, yaw: 0 } },
  { id: "boards", x: 18.5, y: 3.3, label: "Boards" },
  { id: "upDown", x: 31.5, y: 5.5, label: "Go Down", go: { x: 18.5, y: 3.3, yaw: 0 } },
  { id: "drawers", x: 5.95, y: 11.4, label: "Search Drawer" },
  { id: "guestLog", x: 5.15, y: 12.1, label: "Read Guest Log" },
  { id: "breaker", x: 2.0, y: 5.6, label: "Flip Breaker" },
  { id: "rubble", x: 40.4, y: 3.5, label: "Inspect Rubble", text: "Too heavy to move." },
];

const PROTAGONIST = {
  name: "Maria Voss",
  color: "#6b6259",
  storyIntro: "Something in John's letters stopped making sense months ago. I haven't heard from him in weeks. I better go check on him...I hope he's alright.",
};

const DIALOGUES = {};

const FRONT_DOOR = {
  id: "frontDoor",
  x: 8.5,
  y: 13.9, // the leaf sits at the street face of the wall, with a recess behind it
  interactionDistance: 1.4,
  label: "Enter the Building",
  signText: "ENTRANCE",
  plateNumber: "60406",
  // heavy green-painted entrance door: barred glass panel, brass pull and kick strip
  style: "entrance",
  baseColor: "#24402f",
  frame: "#2a2d29",
  handle: "pull",
  metal: "#b8963a",
  keyhole: true,
  kick: true,
  openAngle: -Math.PI * 0.5, // swings in against the recess wall
  creak: 0.8, creakTone: 4200, creakGain: 1.0, creakStart: 0, // slow and heavy
};

// Interior doors that really open. x/y is the centre of the wall cell.
// style picks the look: wood, hall, fire. A door with keyId stays locked
// until the player carries that item.
const DOORS = [
  // lobby -> hallway: dark walnut with frosted glass, a pull handle and kick plate
  { id: "hallDoor", x: 8.5, y: 7.5, interactionDistance: 1.4, label: "Open Door", locked: false,
    style: "hall", baseColor: "#3b2f27", frame: "#1c1612", handle: "pull", metal: "#b0a68a", kick: true, creak: 0.9, creakTone: 6500, creakGain: 0.85, creakStart: 0.03 },
  // apartment 2: yellowed cream six-panel door, lever handle
  { id: "apt2", x: 6.5, y: 4.5, interactionDistance: 1.4, label: "Open Door", locked: false,
    style: "wood6", plate: "2", baseColor: "#8a7f62", frame: "#4a4030", handle: "lever", peephole: true, metal: "#9a8a50", creak: 1.15, creakTone: 11000, creakGain: 0.7, creakStart: 0.06 }, // light and quick
  // apartment 3: modern blue-grey flush door, steel lever and deadbolt
  { id: "apt3", x: 10.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true,
    style: "flush", plate: "3", baseColor: "#3e4a52", frame: "#1d2327", handle: "lever", deadbolt: true, peephole: true, metal: "#c4c8cc", creak: 0.95, creakTone: 5500, creakGain: 0.8, creakStart: 0.02,
    lockedText: "Locked." },
  // apartment 4 (John's): old oak door with an arched panel, brass knob and keyhole
  { id: "john", x: 14.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "johnKey",
    style: "arch", plate: "4", baseColor: "#4c3a34", frame: "#201813", handle: "knob", keyhole: true, metal: "#b8963a", creak: 0.82, creakTone: 2800, creakGain: 1.0, creakStart: 0.04, // old, dark, slow
    unlockLabel: "Unlock Apartment 4", lockedText: "Locked. You need a key." },
  // staff room (carved out of the hallway's west end): grey steel door, deadbolt
  { id: "staffDoor", x: 3.5, y: 7.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "staffKey",
    style: "flush", baseColor: "#6b6f72", frame: "#1d2327", handle: "lever", deadbolt: true, metal: "#c4c8cc", creak: 0.9, creakTone: 4500, creakGain: 0.9, creakStart: 0.02,
    unlockLabel: "Unlock Staff Room", lockedText: "Locked." },
  // stairwell: green steel fire door with a push bar and kick plate
  { id: "stairs", x: 18.5, y: 4.5, interactionDistance: 1.4, label: "Open Door", locked: false,
    style: "fire", baseColor: "#2f4a3c", frame: "#171f1a", handle: "pushbar", kick: true, metal: "#c8ccd0", creak: 0.7, creakTone: 3800, creakGain: 1.0, creakStart: 0 }, // heavy steel
];

// One-sided things on the lobby wall: they look like doors but only exist on
// the lobby side (y is the wall face the lobby sees).
const FIXTURES = [
  { id: "elevator", x: 5.5, y: 8.0, width: 0.95, style: "elevator", baseColor: "#8a8f95", label: "Call Elevator", text: "No power.", sound: "click" },
];

const JOHN_ROOM = { minX: 13, maxX: 16, minY: 1, maxY: 4 };

const GUEST_PAPER = {
  id: "guestLog",
  name: "Guest Log",
  sloppy: 0.25,
  seed: 13,
  paper: "GUEST LOG\nSept 02 apt 1 Okafor\nSept 09 apt 3 Lindqvist\nSept 14 apt 4 John\nSept 20 apt 4 John, nails\nSept 25 power cut\nSept 28 apt 4 John\nin 3:13am   out ----\nwho let him in? door\nwas locked. ink still wet",
};