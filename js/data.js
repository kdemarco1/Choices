// ---------------------------------------------------------------------------
// GAME DATA — one continuous map. Rows 0-5 are the building interior, row 6
// is the front door (a gap in the facade wall), rows 7-10 are the empty
// street outside. There is no map-switching anymore: walking through the
// open door just continues into the same physical space.

const MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 0: back wall
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 1: foyer / back hallway
  [1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 1], // 2
  [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], // 3
  [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1], // 4
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 5: foyer, just past the door
  [1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1], // 6: facade wall, door gap at col 5
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 7: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 8: street
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // 9: street, player start
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 10: south boundary
];

const PLAYER_START = { x: 5.5, y: 9.0, angle: -Math.PI / 2 };

const NPCS = [];

const ITEMS = [
  {
    id: "flashlight",
    name: "Flashlight",
    x: 3.2,
    y: 4.6, // sitting right on the reception desk, just past the front door
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
  x: 5.5,
  y: 6.0,
  interactionDistance: 1.4,
  label: "Enter the Building",
  signText: "ENTRANCE",
  plateNumber: "60406",
};