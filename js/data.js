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
  "#####...#...#...######################################################", // 0
  "#####...#...#...#...###....#....#....#....#..##........########......#", // 1  apartments 1-3 and John's (4), then the stairwell
  "#####...#...#...#...###....#....#....#....#..##........########......#", // 2
  "#####...#...#...#...###....#....#....#....#..##......................#", // 3
  "########################.####.####.####.###.###........########......#", // 4  apartment + stairwell doors
  "#....#..............###......................##........########......#", // 5  hallway
  "#....#..............###......................#####.###################", // 6
  "#######################......................#####.###################", // 7  lobby wall (hall door, elevator and staff door on the lobby side)
  "#...................####.####.####.####.###.###........###############", // 8  lobby
  "#...................###....#....#....#....#..##........###############", // 9
  "#...................###....#....#....#....#..##........###############", // 10
  "#...................###....#....#....#....#..##........###############", // 11
  "#...................##################################################", // 12
  "########.#############################################################", // 13 facade, front door at col 8
  "x...................x#################################################", // 14 street
  "x...................x#################################################", // 15
  "x...................x#################################################", // 16
  "x...................x#################################################", // 17
  "x...................x#################################################", // 18 player start
  "xxxxxxxxxxxxxxxxxxxxx#################################################", // 19
];
// Three studio flats sit right behind the hallway doors, 3 wide x 4 deep (rows 0-3).
const APT_W = 3;
const APT_DEFS = [
  { id: "apt2", door: "apt2", ox: 5 },
  { id: "apt3", door: "apt3", ox: 9 },
  { id: "john", door: "john", ox: 13 },
];
// 0 = open, 1 = wall (drawn), 2 = invisible-solid barrier (hedge at the yard edges, curb along the road)
const MAP = MAP_ROWS_TEXT.map((row) => Array.from(row).map((ch) => (ch === "#" ? 1 : ch === "x" ? 2 : 0)));

// Floor cells that are solid but drawn as props instead of wall blocks
// (the staircase fills the back of the stairwell).
const BLOCKED_CELLS = [[7, 15], [9, 15], [2, 15], [4, 17], [14, 15], [17, 17], [59, 3]]; // + the entrance columns and four yard trees

const PLAYER_START = { x: 8.5, y: 18.0, angle: -Math.PI / 2 };

const NPCS = [];

const ITEMS = [
  {
    id: "flashlight",
    name: "Flashlight",
    x: 3.1,
    y: 10.6, // on the reception desk, just past the front door, to the left as you enter
    color: "#c9a15c",
    height: 0.85,
    pickupText: "A flashlight, sitting on the reception desk.",
  },
  {
    id: "johnKey",
    name: "Key 4",
    key: true,
    x: 7.4,
    y: 3.7,
    h: 0.775, // on the little desk inside Apartment 2 inside Apartment 2
    color: "#d4b04a",
    height: 0.9,
    pickupText: "A brass key on a paper tag: 4.",
  },
  { id: "axe", name: "Axe", x: 13.6, y: 1.5, /* under John's bed */ color: "#999999", height: 0.9, pickupText: "A fire axe." },
  { id: "johnNote", name: "John's Note", note: true, h: 0.57, x: 14.25, y: 0.35, paper: "Sept 21\nthird week. no sleep.\nit stands in the hall at night. {i can't} look at it\nI hid the axe under my bed\nin case", sloppy: 0.5, seed: 3 },
  { id: "batteries", name: "Batteries", h: 0.92, x: 14.95, y: 0.35, pickupText: "Spare batteries." },
  { id: "staffNote", name: "Notice", note: true, x: 4.2, y: 5.7, paper: "Power out again?\nMain breaker is on the\nnorth wall.\n- Mgmt", sloppy: 0.1, seed: 7 },
  { id: "note1", name: "Torn Page", note: true, x: 26.2, y: 2.2, paper: "john won't sleep\nsays it walks the halls\nwhen the {lights} die\n{he stopped answering}", sloppy: 0.9, seed: 11 },
  { id: "note2", name: "Letter", note: true, x: 29.5, y: 2.0, paper: "DONT go below\n{ something sealed }\nin the cellar.\nkeep your light ON", sloppy: 0.8, seed: 5 },
  { id: "note3", name: "Scrap of Paper", note: true, x: 34.6, y: 10.4, paper: "it only stops when\nsomeone goes into {his}\nroom. the key is 4", sloppy: 0.7, seed: 9 },
  { id: "note4", name: "Child's Note", note: true, x: 39.5, y: 2.2, paper: "mommy says the man in\nroom 4 is {sleeping}\nbut i hear him walking\nabove me at night", sloppy: 1, seed: 17 },
  { id: "note5", name: "Work Order", note: true, x: 51.5, y: 2.4, paper: "Elevator cable frayed.\nDo NOT let anyone ride it.\nNeed a crowbar to pry\nthe doors when it jams.", sloppy: 0.3, seed: 21 },
  { id: "batteries2", name: "Batteries", x: 50.5, y: 9.4, h: 0.5, pickupText: "Spare batteries." },
];

// Spots you can use with E. 'go' teleports between levels.
const HOTSPOTS = [
  { id: "boards", x: 17.75, y: 2.95, label: "Boards" },
  { id: "drawers", x: 2.4, y: 10.35, label: "Search Drawer" },
  { id: "guestLog", x: 3.1, y: 11.15, label: "Read Guest Log" },
  { id: "breaker", x: 2.0, y: 5.6, label: "Flip Breaker" },
  { id: "rubble", x: 58.5, y: 3.5, label: "Inspect Rubble", text: "Too heavy to move." },
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
  { id: "apt3", x: 10.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "apt3Key",
    style: "flush", plate: "3", baseColor: "#3e4a52", frame: "#1d2327", handle: "lever", deadbolt: true, peephole: true, metal: "#c4c8cc", creak: 0.95, creakTone: 5500, creakGain: 0.8, creakStart: 0.02,
    unlockLabel: "Unlock Apartment 3", lockedText: "Locked." },
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
  { id: "elevator", x: 11.5, y: 8.0, width: 0.95, style: "elevator", baseColor: "#8a8f95", label: "Call Elevator", text: "No power.", sound: "click" },
];

const JOHN_ROOM = { minX: 13, maxX: 16, minY: 0, maxY: 4 }; // John's studio

const GUEST_PAPER = {
  id: "guestLog",
  name: "Guest Log",
  sloppy: 0.25,
  seed: 13,
  paper: "GUEST LOG\nSept 02 apt 1 Okafor\nSept 09 apt 3 Lindqvist\nSept 14 apt 4 John\nSept 20 apt 4 John, nails\nSept 25 power cut\nSept 28 apt 4 John\nin 3:13am   out ----\nwho let him in? door\nwas locked. ink still wet",
};

// Real staircases. Flights run north-south: you step on at z0 (height 0) and the floor rises (or falls) by `rise`
// by z1. Reaching the far end fades out and puts you on the next level (the levels sit apart on the map).
const STAIRS = [
  { id: "gUp", x0: 17.0, x1: 18.5, z0: 3.9, z1: 1.25, rise: 3.0, needs: "boardsChopped", to: { x: 24.5, y: 4.6, yaw: Math.PI } },
  { id: "gDown", x0: 18.5, x1: 20.0, z0: 3.9, z1: 1.25, rise: -3.0, to: { x: 49.3, y: 5.4, yaw: -Math.PI / 2 } },
  { id: "uDown", x0: 23.8, x1: 25.2, z0: 3.95, z1: 1.3, rise: -3.0, to: { x: 17.75, y: 3.65, yaw: Math.PI } },
  { id: "bUp", x0: 47.2, x1: 48.6, z0: 5.8, z1: 3.15, rise: 3.0, to: { x: 19.25, y: 3.65, yaw: Math.PI } },
];
const STAIR_STEPS = 12;

// Things that pop out at you once the lights are on. Each fires once per run.
// kind: lurker (a figure that stands there until you get close), crawler (runs across your view),
// slam (a bang and the flashlight dies, then a figure), drop (something falls from the ceiling).
const SCARES = [
  // second floor
  { id: "upLurk", level: 1, kind: "lurker", trigger: { x: 27, z: 5.5, r: 1.2 }, at: { x: 38.5, z: 5.5 }, life: 6 },
  { id: "upSlam", level: 1, kind: "slam", trigger: { x: 33, z: 5.5, r: 1.0 }, at: { x: 36.8, z: 5.9 }, delay: 0.8, life: 1.6 },
  { id: "upCrawl", level: 1, kind: "crawler", trigger: { x: 40.5, z: 5.5, r: 1.0 }, at: { x: 44.2, z: 5.6 }, to: { x: 38.0, z: 5.9 }, dur: 1.2 },
  { id: "upDrop", level: 1, kind: "drop", trigger: { x: 29.5, z: 9.6, r: 0.9 }, at: { x: 29.7, z: 10.3 } },
  // basement
  { id: "baseLurk", level: 2, kind: "lurker", trigger: { x: 50.5, z: 4.6, r: 1.2 }, at: { x: 53.0, z: 2.8 }, delay: 0.4, life: 6 },
  { id: "baseSlam", level: 2, kind: "slam", trigger: { x: 55.5, z: 3.4, r: 0.8 }, at: { x: 57.0, z: 3.5 }, delay: 0.9, life: 1.6 },
  { id: "baseCrawl", level: 2, kind: "crawler", trigger: { x: 50.5, z: 7.4, r: 1.0 }, at: { x: 53.6, z: 10.8 }, to: { x: 51.0, z: 8.9 }, dur: 1.0 },
  { id: "baseDrop", level: 2, kind: "drop", trigger: { x: 51.8, z: 9.6, r: 1.1 }, at: { x: 52.4, z: 9.0 } },
  // on the stairs themselves
  { id: "downStairs", level: 0, kind: "lurker", trigger: { x: 19.25, z: 3.5, r: 0.7 }, at: { x: 19.25, z: 1.7 }, delay: 0.2, life: 4, near: 1.0 },
  { id: "upStairs", level: 2, kind: "lurker", trigger: { x: 47.9, z: 5.5, r: 0.7 }, at: { x: 47.9, z: 3.5 }, delay: 0.2, life: 4, near: 1.0 },
];

// ---- things to find inside the apartments ------------------------------------------------
// Items with `hidden: true` are only found by searching furniture (see LOOT / APT_SPOTS below).
// `trinket: true` items are just things to keep (they show up in the inventory).
const apt = (id) => APT_DEFS.find((a) => a.id === id).ox;
const note = (id, name, paper, sloppy, seed) => ITEMS.push({ id, name, note: true, hidden: true, paper, sloppy, seed });
const trinket = (id, name) => ITEMS.push({ id, name, trinket: true, hidden: true });
ITEMS.push({ id: "apt3Key", name: "Key 3", key: true, hidden: true });
["a2Batt", "a3Batt", "a3Batt2", "jBatt"].forEach((id) => ITEMS.push({ id, name: "Batteries", hidden: true }));
// apartment 2 (the family that left in a hurry)
note("a2List", "Grocery List", "milk\nbread\ncandles - lots\n{don't open the door\nat night}", 0.4, 31);
note("a2Draw", "Child's Drawing", "mommy  me  daddy\nand the {tall man}\nhe has no face", 1, 33);
trinket("a2Photo", "Family Photo");
trinket("a2Coin", "Old Coin");
trinket("a2Pills", "Pill Bottle");
// apartment 3 (someone who stopped trusting the building)
note("a3Tape", "Taped Page", "they knock 3 times.\nthen the lights {go out}.\nit hates the light.\nkeep it ON", 0.6, 41);
note("a3Journal", "Journal Page", "day 9\nit doesn't come in while i\nhold the flashlight.\nthe bathtub is {safest}", 0.7, 43);
note("a3Map", "Sketch", "{the cellar door}\ni drew what i heard\nunder the floor.\nit is not the boiler", 0.9, 45);
trinket("a3Box", "Music Box");
trinket("a3Photo", "Torn Photo");
// apartment 4 (John's)
note("jJ1", "Journal Page", "Sept 3\nmoved in. quiet building.\ngood rent. the manager\nlooked scared of me", 0.2, 61);
note("jJ2", "Journal Page", "Sept 14\nheard steps in the ceiling.\nnobody lives above me.\nnobody lives up there", 0.5, 63);
trinket("jTag", "Dog Tag");
note("jJ3", "Journal Page", "Sept 28\nfound where it sleeps.\nthe cellar. the boiler is\nwarm. nothing down there\nshould be {warm}", 0.5, 65);
note("jJ4", "Journal Page", "Oct 1\ni nailed boards on the\nstairs. the sound comes\nfrom {both ways} now", 0.8, 67);
ITEMS.push({ id: "jJ5", name: "Photo Album", note: true, h: 0.02, x: 14.5, y: 3.2, sloppy: 0.7, seed: 69, paper: "every picture of me\nhas the tall one standing\n{behind me}\nsince when" });
//note("jJ5", "Photo Album", "every picture of me\nhas the tall one standing\n{behind me}\nsince when", 0.7, 69);
note("jJ6", "Last Entry", "Oct 3\ni haven't eaten in 4 days.\nit goes dark and it comes.\nthe axe is under the bed.\nif the light comes back\nit {leaves}", 1, 71);
trinket("jPhoto", "John's Photo");

// Furniture you can search: position inside a studio (x, z from its west wall / north wall), prompt.
const APT_SPOTS = [
  { k: "bed", rx: 1.0, rz: 1.5, label: "Search Bed" },
  { k: "nightstand", rx: 1.25, rz: 0.75, label: "Search Nightstand" },
  { k: "dresser", rx: 1.95, rz: 0.75, label: "Search Dresser" },
  { k: "under", rx: 2.1, rz: 1.0, label: "Search Cabinet" },
  { k: "drawer", rx: 2.1, rz: 1.5, label: "Search Drawer" },
  { k: "fridge", rx: 2.1, rz: 2.55, label: "Open Fridge" },
  { k: "couch", rx: 0.95, rz: 3.0, label: "Search Couch" },
  { k: "desk", rx: 2.0, rz: 3.5, label: "Search Desk" },
];
// What each spot holds: an item id, or null (empty, you only find that out by looking).
const LOOT = {
  apt2: { fridge: "a2List", under: "a2Batt", dresser: "apt3Key", nightstand: "a2Draw", couch: "a2Coin", drawer: "a2Pills", desk: "a2Photo", bed: null },
  apt3: { bed: "a3Tape", nightstand: "a3Journal", desk: "a3Map", drawer: "a3Box", dresser: "a3Photo", under: "a3Batt", couch: "a3Batt2", fridge: null },
  john: { dresser: "jJ1", desk: "jJ2", bed: "jJ3", couch: "jJ4", fridge: "jJ6", under: "jBatt", drawer: "jTag", nightstand: "jPhoto" },
};
// Writing scrawled on John's walls (readable). rot: the way the writing faces (0 = south, PI/2 = east, PI = north)
const WALL_WRITING = [
  { apt: "john", id: "john_wall1", rx: 1.2, rz: 0.03, rot: 0, label: "Read Wall", paper: "IT HATES THE LIGHT\nonly the light\nit can't come in {while}\nthe lights are on", sloppy: 1.4, seed: 81 },
  { apt: "john", id: "john_wall2", rx: 0.03, rz: 2.9, rot: Math.PI / 2, label: "Read Wall", paper: "it walks above me\nTHE BOARDS DON'T HOLD IT\nit goes {down} at night", sloppy: 1.4, seed: 83 },
  { apt: "john", id: "john_wall3", rx: 2.4, rz: 3.97, rot: Math.PI, label: "Read Wall", paper: "I CAN HEAR IT BREATHE\nthrough the {floor}\ndon't open the cellar", sloppy: 1.4, seed: 85 },
];
APT_DEFS.forEach((a) => {
  APT_SPOTS.forEach((s) => {
    if (!(s.k in LOOT[a.id])) return;
    HOTSPOTS.push({ id: a.id + "_" + s.k, x: a.ox + s.rx, y: s.rz, label: s.label, loot: LOOT[a.id][s.k] || "none" });
  });
});
WALL_WRITING.forEach((w) => HOTSPOTS.push({ id: w.id, x: APT_DEFS.find((a) => a.id === w.apt).ox + w.rx + Math.sin(w.rot) * 0.9, y: w.rz + Math.cos(w.rot) * 0.9, label: w.label, paper: { paper: w.paper, sloppy: w.sloppy, seed: w.seed } }));
const PORTALS = []; // (the flats are real rooms behind the doors now)

// Damage and clutter that differs between flats.
const APT_DAMAGE = {
  apt2: { holes: [], ceil: [], mess: 6 },
  apt3: { holes: [], ceil: [[1.5, 2.0, 1.0, 0.9]], mess: 14 },
  john: { holes: [], ceil: [], mess: 10 },
};