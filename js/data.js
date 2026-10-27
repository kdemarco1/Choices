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
  "######################################################################", // 0
  "#################...###....#....#....#....#..##........########......#", // 1  apartments 1-3 and John's (4), then the stairwell
  "#################...###....#....#....#....#..##........########......#", // 2
  "#################...###....#....#....#....#..##......................#", // 3
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
// 0 = open, 1 = wall (drawn), 2 = invisible-solid barrier (hedge at the yard edges, curb along the road)
// ---- the apartments: each one is a big furnished flat of its own, east of the basement (cols 70+).
// You step through the apartment's door in the hallway and the screen fades into it. Layout (20 x 13):
//  bedroom (NW), kitchen (NE), living room along the south (with the exit door on the south wall).
const APT_W = 14;
const APT_ROWS = [
  "##############",
  "#.....#......#",
  "#............#",
  "#............#",
  "#.....#......#",
  "##..#####..###",
  "#............#",
  "#............#",
  "#............#",
  "##############",
];
const APT_DEFS = [
  { id: "apt1", door: "apt1", ox: 70 },
  { id: "apt2", door: "apt2", ox: 84 },
  { id: "apt3", door: "apt3", ox: 98 },
  { id: "john", door: "john", ox: 112 },
];
const APT_X0 = 70;
const MAP_ROWS_FULL = MAP_ROWS_TEXT.map((row, i) => row + APT_DEFS.map(() => (i < APT_ROWS.length ? APT_ROWS[i] : "#".repeat(APT_W))).join(""));
const MAP = MAP_ROWS_FULL.map((row) => Array.from(row).map((ch) => (ch === "#" ? 1 : ch === "x" ? 2 : 0)));

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
    x: 95.0,
    y: 3.6, // on the kitchen table inside Apartment 2
    color: "#d4b04a",
    height: 0.9,
    pickupText: "A brass key on a paper tag: 4.",
  },
  { id: "axe", name: "Axe", x: 113.9, y: 2.6, /* under John's bed */ color: "#999999", height: 0.9, pickupText: "A fire axe." },
  { id: "johnNote", name: "John's Note", note: true, h: 0.57, x: 115.0, y: 1.5, paper: "Sept 21\nthird week. no sleep.\nit stands in the hall at night. {i can't} look at it\nI hid the axe under my bed\nin case", sloppy: 0.5, seed: 3 },
  { id: "batteries", name: "Batteries", h: 0.92, x: 116.8, y: 1.45, pickupText: "Spare batteries." },
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
  // apartment 1: faded green door, brass number, a deadbolt
  { id: "apt1", x: 6.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "apt1Key",
    style: "wood6", plate: "1", baseColor: "#4d5e4a", frame: "#232b22", handle: "lever", deadbolt: true, peephole: true, metal: "#9a8a50", creak: 1.0, creakTone: 7000, creakGain: 0.8, creakStart: 0.04,
    unlockLabel: "Unlock Apartment 1", lockedText: "Locked." },
  // apartment 2: yellowed cream six-panel door, lever handle
  { id: "apt2", x: 9.5, y: 4.5, interactionDistance: 1.4, label: "Open Door", locked: false,
    style: "wood6", plate: "2", baseColor: "#8a7f62", frame: "#4a4030", handle: "lever", peephole: true, metal: "#9a8a50", creak: 1.15, creakTone: 11000, creakGain: 0.7, creakStart: 0.06 }, // light and quick
  // apartment 3: modern blue-grey flush door, steel lever and deadbolt
  { id: "apt3", x: 12.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "apt3Key",
    style: "flush", plate: "3", baseColor: "#3e4a52", frame: "#1d2327", handle: "lever", deadbolt: true, peephole: true, metal: "#c4c8cc", creak: 0.95, creakTone: 5500, creakGain: 0.8, creakStart: 0.02,
    unlockLabel: "Unlock Apartment 3", lockedText: "Locked." },
  // apartment 4 (John's): old oak door with an arched panel, brass knob and keyhole
  { id: "john", x: 15.5, y: 4.5, interactionDistance: 1.4, label: "Try Door", locked: true, keyId: "johnKey",
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

const JOHN_ROOM = { minX: 112, maxX: 126, minY: 0, maxY: 10 }; // all of John's apartment

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
ITEMS.push({ id: "apt1Key", name: "Key 1", key: true, hidden: true });
["a2Batt", "a3Batt", "a3Batt2", "a1Batt", "a1Batt2", "jBatt"].forEach((id) => ITEMS.push({ id, name: "Batteries", hidden: true }));
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
// apartment 1 (nobody lives here now)
note("a1Memo", "Memo", "To all tenants:\nthe cellar door has been\n{sealed}. do not open it.\n- management", 0.2, 51);
note("a1Last", "Last Page", "the front door won't\nopen from inside {anymore}\nwe are all still here", 0.9, 53);
trinket("a1Ring", "Wedding Ring");
trinket("a1Locket", "Rusty Locket");
// apartment 4 (John's)
note("jJ1", "Journal Page", "Sept 3\nmoved in. quiet building.\ngood rent. the manager\nlooked scared of me", 0.2, 61);
note("jJ2", "Journal Page", "Sept 14\nheard steps in the ceiling.\nnobody lives above me.\nnobody lives up there", 0.5, 63);
trinket("jTag", "Dog Tag");
note("jJ3", "Journal Page", "Sept 28\nfound where it sleeps.\nthe cellar. the boiler is\nwarm. nothing down there\nshould be {warm}", 0.5, 65);
note("jJ4", "Journal Page", "Oct 1\ni nailed boards on the\nstairs. the sound comes\nfrom {both ways} now", 0.8, 67);
note("jJ5", "Photo Album", "every picture of me\nhas the tall one standing\n{behind me}\nsince when", 0.7, 69);
note("jJ6", "Last Entry", "Oct 3\ni haven't eaten in 4 days.\nit goes dark and it comes.\nthe axe is under the bed.\nif the light comes back\nit {leaves}", 1, 71);
trinket("jPhoto", "John's Photo");

// Furniture you can search: position inside an apartment (x, z), prompt.
const APT_SPOTS = [
  { k: "fridge", rx: 11.4, rz: 2.3, label: "Open Fridge" },
  { k: "under", rx: 8.0, rz: 2.3, label: "Search Cabinet" },
  { k: "drawer", rx: 10.3, rz: 2.3, label: "Search Drawer" },
  { k: "dresser", rx: 4.8, rz: 2.1, label: "Search Dresser" },
  { k: "desk", rx: 2.3, rz: 4.0, label: "Search Desk" },
  { k: "nightstand", rx: 3.0, rz: 2.1, label: "Search Nightstand" },
  { k: "bed", rx: 2.7, rz: 2.8, label: "Search Bed" },
  { k: "couch", rx: 6.0, rz: 7.4, label: "Search Couch" },
  { k: "tv", rx: 9.5, rz: 7.9, label: "Search TV Stand" },
  { k: "shelf", rx: 2.2, rz: 7.4, label: "Search Shelf" },
];
// What each spot holds: an item id, or null (empty, you only find that out by looking).
const LOOT = {
  apt2: { fridge: "a2List", under: "a2Batt", dresser: "apt3Key", nightstand: "a2Draw", couch: "a2Coin", shelf: "a2Photo", drawer: "a2Pills", desk: null, tv: null },
  apt3: { drawer: "apt1Key", under: "a3Batt", desk: "a3Batt2", bed: "a3Tape", nightstand: "a3Journal", shelf: "a3Map", tv: "a3Box", dresser: "a3Photo", fridge: null, couch: null },
  apt1: { dresser: "a1Memo", nightstand: "a1Last", drawer: "a1Ring", couch: "a1Locket", under: "a1Batt", tv: "a1Batt2", fridge: null, desk: null },
  john: { dresser: "jJ1", desk: "jJ2", bed: "jJ3", couch: "jJ4", shelf: "jJ5", fridge: "jJ6", tv: "jPhoto", under: "jBatt", drawer: "jTag", nightstand: null },
};
// Writing scrawled on John's walls (readable)
const WALL_WRITING = [
  { apt: "john", id: "john_wall1", rx: 1.03, rz: 3.6, rot: Math.PI / 2, label: "Read Wall", paper: "IT HATES THE LIGHT\nonly the light\nit can't come in {while}\nthe lights are on", sloppy: 1.4, seed: 81 },
  { apt: "john", id: "john_wall2", rx: 6.0, rz: 6.03, rot: 0, label: "Read Wall", paper: "it walks above me\nTHE BOARDS DON'T HOLD IT\nit goes {down} at night", sloppy: 1.4, seed: 83 },
];
APT_DEFS.forEach((a) => {
  APT_SPOTS.forEach((s) => {
    if (!(s.k in LOOT[a.id])) return;
    HOTSPOTS.push({ id: a.id + "_" + s.k, x: a.ox + s.rx, y: s.rz, label: s.label, loot: LOOT[a.id][s.k] || "none" });
  });
  // the apartment's own front door, on the south wall of the living room
  HOTSPOTS.push({ id: "exit_" + a.id, x: a.ox + 3.5, y: 8.4, label: "Open Door", exit: a.door });
});
WALL_WRITING.forEach((w) => HOTSPOTS.push({ id: w.id, x: APT_DEFS.find((a) => a.id === w.apt).ox + w.rx + (w.rot ? 0.8 : 0), y: w.rz + (w.rot ? 0 : 0.8), label: w.label, paper: { paper: w.paper, sloppy: w.sloppy, seed: w.seed } }));

// Walking through an open apartment door (in the hallway, or the staff room for apartment 1) fades into the flat.
const PORTALS = APT_DEFS.map((a) => {
  const door = DOORS.find((dr) => dr.id === a.door);
  return { id: a.id, door: a.door, x0: Math.floor(door.x), x1: Math.floor(door.x) + 1, z: 4.4, to: { x: a.ox + 3.5, y: 8.2, yaw: 0 }, back: { x: door.x, y: 5.45, yaw: Math.PI } };
});

// Damage and clutter that differs between apartments: holes in the floor/ceiling, extra mess.
const APT_DAMAGE = {
  apt1: { holes: [[9.0, 4.0, 1.2, 0.8], [3.0, 7.9, 1.0, 0.7]], ceil: [[10.0, 3.0, 1.2, 0.9]], mess: 40 },
  apt2: { holes: [], ceil: [], mess: 14 },
  apt3: { holes: [[11.6, 7.9, 1.1, 0.7]], ceil: [[4.0, 3.0, 1.0, 0.9]], mess: 30 },
  john: { holes: [[8.8, 4.3, 0.9, 0.7]], ceil: [], mess: 26 },
};