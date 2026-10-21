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
//  rows 14-18 the street
const MAP_ROWS_TEXT = [
  "#####################", // 0
  "#...#...#...#...#...#", // 1  apartments 1-3 and John's (4), then the stairwell
  "#...#...#...#...#...#", // 2
  "#...#...#...#...#...#", // 3
  "#####################", // 4  apartment + stairwell doors
  "#...................#", // 5  hallway
  "#...................#", // 6
  "#####################", // 7  lobby wall (hall door, elevator and staff door on the lobby side)
  "#...................#", // 8  lobby
  "#...................#", // 9
  "#...................#", // 10
  "#...................#", // 11
  "#...................#", // 12
  "########.############", // 13 facade, front door at col 8
  "#...................#", // 14 street
  "#...................#", // 15
  "#...................#", // 16
  "#...................#", // 17
  "#...................#", // 18 player start
  "#####################", // 19
];
const MAP = MAP_ROWS_TEXT.map((row) => Array.from(row).map((ch) => (ch === "#" ? 1 : 0)));

// Floor cells that are solid but drawn as props instead of wall blocks
// (the staircase fills the back of the stairwell).
const BLOCKED_CELLS = [[17, 1], [18, 1], [19, 1], [17, 2], [18, 2], [19, 2]];

const PLAYER_START = { x: 8.5, y: 18.0, angle: -Math.PI / 2 };

const NPCS = [];

const ITEMS = [
  {
    id: "flashlight",
    name: "Flashlight",
    x: 5.5,
    y: 12.0, // on the reception desk, just past the front door, to the left as you enter
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
  y: 13.0,
  interactionDistance: 1.4,
  label: "Enter the Building",
  signText: "ENTRANCE",
  plateNumber: "60406",
  style: "panelka",
  baseColor: "#7c847a",
  frame: "#23261f",
  handle: "lever",
  metal: "#9a9a92",
  peephole: true,
  creak: 0.8,
};

// Interior doors that really open. x/y is the centre of the wall cell.
// style picks the look: wood, hall, fire. A door with keyId stays locked
// until the player carries that item.
const DOORS = [
  // lobby -> hallway: dark walnut with frosted glass, a pull handle and kick plate
  { id: "hallDoor", x: 8.5, y: 7.5, interactionDistance: 1.4, label: "Open Door", locked: false,
    style: "hall", baseColor: "#3b2f27", frame: "#1c1612", handle: "pull", metal: "#b0a68a", kick: true, creak: 0.9 },
  // apartment 1: dark red four-panel door, brass knob, deadbolt, peephole
  { id: "apt1", x: 2.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true,
    style: "wood4", plate: "1", baseColor: "#5a2c28", frame: "#2a1512", handle: "knob", deadbolt: true, peephole: true, metal: "#b8963a", creak: 1.0,
    lockedText: "Locked." },
  // apartment 2: yellowed cream six-panel door, lever handle
  { id: "apt2", x: 6.5, y: 4.5, interactionDistance: 1.4, label: "Open Door", locked: false,
    style: "wood6", plate: "2", baseColor: "#8a7f62", frame: "#4a4030", handle: "lever", peephole: true, metal: "#9a8a50", creak: 1.15 },
  // apartment 3: modern blue-grey flush door, steel lever and deadbolt
  { id: "apt3", x: 10.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true,
    style: "flush", plate: "3", baseColor: "#3e4a52", frame: "#1d2327", handle: "lever", deadbolt: true, peephole: true, metal: "#c4c8cc", creak: 0.95,
    lockedText: "Locked." },
  // apartment 4 (John's): old oak door with an arched panel, brass knob and keyhole
  { id: "john", x: 14.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "johnKey",
    style: "arch", plate: "4", baseColor: "#4c3a34", frame: "#201813", handle: "knob", keyhole: true, metal: "#b8963a", creak: 0.85,
    unlockLabel: "Unlock Apartment 4", lockedText: "Locked. You need a key." },
  // stairwell: green steel fire door with a push bar and kick plate
  { id: "stairs", x: 18.5, y: 4.5, interactionDistance: 1.4, label: "Open Door", locked: false,
    style: "fire", baseColor: "#2f4a3c", frame: "#171f1a", handle: "pushbar", kick: true, metal: "#c8ccd0", creak: 0.7 },
];

// One-sided things on the lobby wall: they look like doors but only exist on
// the lobby side (y is the wall face the lobby sees).
const FIXTURES = [
  { id: "staff", x: 3.5, y: 8.0, width: 0.9, style: "metal", baseColor: "#6b6f72", label: "Try Door", text: "Locked.", sound: "knock" },
  { id: "elevator", x: 5.5, y: 8.0, width: 0.95, style: "elevator", baseColor: "#8a8f95", label: "Call Elevator", text: "No power.", sound: "click" },
];

const JOHN_ROOM = { minX: 13, maxX: 16, minY: 1, maxY: 4 };