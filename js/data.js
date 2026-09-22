// ---------------------------------------------------------------------------
// GAME DATA — one continuous map. Rows 0-5 are the building interior (one
// large open room), row 6 is the front door (the only gap in an otherwise
// fully sealed facade), rows 7-11 are the empty street outside. There is no
// map-switching: walking through the open door just continues into the
// same physical space, and the only way in or out is that door — the
// facade is solid across its entire width except for the door's cell.

const MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 0: back wall
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 1
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 2
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 3
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 4
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 5: foyer, just past the door
  [1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1], // 6: facade — solid except the door gap at col 6
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 7: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 8: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 9: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 10: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 11: street, player start
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 12: south boundary
];

const PLAYER_START = { x: 6.5, y: 11.0, angle: -Math.PI / 2 };

const NPCS = [];

const ITEMS = [
  {
    id: "flashlight",
    name: "Flashlight",
    x: 3.5,
    y: 5.0, // sitting right on the reception desk, just past the front door, to the left as you enter
    color: "#c9a15c",
    pickupText: "A flashlight, sitting on the reception desk. Still has some charge in it.",
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
  y: 6.0,
  interactionDistance: 1.4,
  label: "Enter the Building",
  signText: "ENTRANCE",
  plateNumber: "60406",
};