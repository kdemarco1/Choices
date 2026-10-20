// ---------------------------------------------------------------------------
// GAME DATA — one continuous map. Rows 0-5 are the building interior (one
// large open room), row 6 is the front door (the only gap in an otherwise
// fully sealed facade), rows 7-11 are the empty street outside. There is no
// map-switching: walking through the open door just continues into the
// same physical space, and the only way in or out is that door — the
// facade is solid across its entire width except for the door's cell.

// Layout (17 columns x 20 rows). '#' = wall, '.' = open floor.
//  rows 1-3   four apartments (doors in row 4 at cols 2, 6, 10, 14)
//  rows 5-6   the hallway
//  row 7      hallway/lobby wall: staff door (3), elevator (5), hall door (8), stairwell (12)
//  rows 8-12  the lobby, reception desk on the left of the front door
//  row 13     the facade — solid except the front door gap at col 8
//  rows 14-18 the street
const MAP_ROWS_TEXT = [
  "#################", // 0
  "#...#...#...#...#", // 1  apartments 1-4
  "#...#...#...#...#", // 2
  "#...#...#...#...#", // 3
  "#################", // 4  apartment doors
  "#...............#", // 5  hallway
  "#...............#", // 6
  "#################", // 7  lobby wall + doors
  "#...............#", // 8  lobby
  "#...............#", // 9
  "#...............#", // 10
  "#...............#", // 11
  "#...............#", // 12
  "########.########", // 13 facade, front door at col 8
  "#...............#", // 14 street
  "#...............#", // 15
  "#...............#", // 16
  "#...............#", // 17
  "#...............#", // 18 player start
  "#################", // 19
];
const MAP = MAP_ROWS_TEXT.map((row) => Array.from(row).map((ch) => (ch === "#" ? 1 : 0)));

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
};

// Interior doors. x/y is the centre of the wall cell the door sits in.
// style picks the look: wood, hall, metal, fire, elevator.
// A door with keyId stays locked until the player carries that item.
const DOORS = [
  { id: "hallDoor", x: 8.5, y: 7.5, interactionDistance: 1.4, label: "Open Door", locked: false, style: "hall", baseColor: "#3b2f27" },
  { id: "staff", x: 3.5, y: 7.5, interactionDistance: 1.4, label: "Try Door", locked: true, style: "metal", baseColor: "#6b6f72", lockedText: "Locked." },
  { id: "elevator", x: 5.5, y: 7.5, interactionDistance: 1.4, label: "Call Elevator", locked: true, style: "elevator", baseColor: "#8a8f95", lockedText: "No power." },
  { id: "stairs", x: 12.5, y: 7.5, interactionDistance: 1.4, label: "Try Door", locked: true, style: "fire", baseColor: "#2f4a3c", lockedText: "Jammed." },
  { id: "apt1", x: 2.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, style: "wood", plate: "1", baseColor: "#5a4a3c", lockedText: "Locked." },
  { id: "apt2", x: 6.5, y: 4.5, interactionDistance: 1.4, label: "Open Door", locked: false, style: "wood", plate: "2", baseColor: "#6a5238" },
  { id: "apt3", x: 10.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, style: "wood", plate: "3", baseColor: "#3e4a52", lockedText: "Locked." },
  { id: "john", x: 14.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "johnKey", style: "wood", plate: "4", baseColor: "#4c3a34",
    unlockLabel: "Unlock Apartment 4", lockedText: "Locked. You need a key." },
];

const JOHN_ROOM = { minX: 13, maxX: 16, minY: 1, maxY: 4 };