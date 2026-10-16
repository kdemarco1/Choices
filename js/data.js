// ---------------------------------------------------------------------------
// GAME DATA — one continuous map. Rows 0-5 are the building interior (one
// large open room), row 6 is the front door (the only gap in an otherwise
// fully sealed facade), rows 7-11 are the empty street outside. There is no
// map-switching: walking through the open door just continues into the
// same physical space, and the only way in or out is that door — the
// facade is solid across its entire width except for the door's cell.

const MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 0: outer wall
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1], // 1: John's apartment (cols 9-11), other apartments are sealed
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1], // 2: John's apartment
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1], // 3: John's apartment
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 4: apartment wall — doors at cols 2, 4, 7, 10 (see DOORS)
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 5: hallway
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 6: hallway
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 7: lobby/hallway wall — hall door at col 6 (see DOORS)
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 8: lobby
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 9: lobby
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 10: lobby
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 11: lobby
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 12: lobby, just past the front door
  [1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1], // 13: facade — solid except the front door gap at col 6
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 14: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 15: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 16: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 17: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 18: street, player start
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 19: south boundary
];

const PLAYER_START = { x: 6.5, y: 18.0, angle: -Math.PI / 2 };

const NPCS = [];

const ITEMS = [
  {
    id: "flashlight",
    name: "Flashlight",
    x: 3.5,
    y: 12.0, // sitting right on the reception desk, just past the front door, to the left as you enter
    color: "#c9a15c",
    height: 0.85,
    pickupText: "A flashlight, sitting on the reception desk. Still has some charge in it.",
  },
  {
    id: "johnKey",
    name: "Brass Key",
    x: 1.5,
    y: 5.5, // west end of the hallway, far from John's door
    color: "#d4b04a",
    height: 0.3,
    pickupText: "A brass key on a paper tag. The tag says: 4. John's apartment.",
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
  x: 6.5,
  y: 13.0,
  interactionDistance: 1.4,
  label: "Enter the Building",
  signText: "ENTRANCE",
  plateNumber: "60406",
};

// Interior doors. x/y is the centre of the wall cell the door sits in.
// A door with keyId stays locked until the player carries that item.
const DOORS = [
  { id: "hallDoor", x: 6.5, y: 7.5, interactionDistance: 1.4, label: "Open Door", locked: false, plate: "", baseColor: "#4d5249",
    openText: "A hallway. Apartment doors line the far wall." },
  { id: "apt1", x: 2.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, plate: "1", baseColor: "#5a4a3c",
    lockedText: "Apartment 1. Locked. No one answers." },
  { id: "apt2", x: 4.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, plate: "2", baseColor: "#5a4a3c",
    lockedText: "Apartment 2. Locked. Something shifts behind the door, then stops." },
  { id: "apt3", x: 7.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, plate: "3", baseColor: "#5a4a3c",
    lockedText: "Apartment 3. Locked." },
  { id: "john", x: 10.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "johnKey", plate: "4", baseColor: "#5a4a3c",
    unlockLabel: "Unlock Apartment 4",
    lockedText: "Apartment 4. John's. Locked — she'll need the key.",
    openText: "The key turns. The door swings open." },
];

const JOHN_ROOM = { minX: 9, maxX: 12, minY: 1, maxY: 4 };