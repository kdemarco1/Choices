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
  "#####...#...#...#....##....#....#....#....#..##........#.#.......#...#", // 1  apartments 1-3 and John's (4), then the stairwell
  "#####...#...#...#....##....#....#....#....#..##........#.#.#######...#", // 2
  "#####...#...#...#....##....#....#....#....#..##..........#.#.#.#.....#", // 3
  "########################.######################........#.#.#.#.#.#...#", // 4  apartment + stairwell doors
  "#....#..............###......................##........#.#.......#...#", // 5  hallway
  "#....#..............###......................#####.#####.#.#...#.#####", // 6
  "#######################......................#####.#####.#.....#.#####", // 7  lobby wall (hall door, elevator and staff door on the lobby side)
  "#...................###########################........#.#.###.#.#####", // 8  lobby
  "#...................###....#....#....#....#..##..............#.#.#####", // 9
  "#...................###....#....#....#....#..##........#.#.#.#########", // 10
  "#...................###....#....#....#....#..##........#.#.#.....#####", // 11
  "#...................##################################################", // 12
  "########.#############################################################", // 13 facade, front door at col 8
  "x...................x#############################.............#######", // 14 street
  "x...................x#############################.............#######", // 15
  "x...................x#############################.............#######", // 16
  "x...................x#############################.............#######", // 17
  "x...................x#############################.............#######", // 18 player start
  "xxxxxxxxxxxxxxxxxxxxx#################################################", // 19
];
// Three studio flats sit right behind the hallway doors, 3 wide x 4 deep (rows 0-3).
const CELLAR = {"levers": [{"c": 64, "r": 9, "side": "S", "color": 0}, {"c": 60, "r": 3, "side": "N", "color": 1}, {"c": 64, "r": 1, "side": "E", "color": 2}], "order": [1, 0, 2], "notes": [{"c": 62, "r": 3}, {"c": 56, "r": 11}], "husks": [{"c": 52, "r": 2, "kind": "hang"}, {"c": 48, "r": 4, "kind": "crawl"}, {"c": 51, "r": 10, "kind": "hang"}, {"c": 49, "r": 11, "kind": "crawl"}, {"c": 55, "r": 9, "kind": "crawl"}, {"c": 60, "r": 9, "kind": "hang"}, {"c": 58, "r": 1, "kind": "crawl"}, {"c": 64, "r": 7, "kind": "hang"}, {"c": 58, "r": 11, "kind": "crawl"}, {"c": 62, "r": 1, "kind": "hang"}, {"c": 58, "r": 7, "kind": "crawl"}], "gate": {"c": 65, "r": 3}, "nest": {"c0": 66, "c1": 68, "r0": 1, "r1": 5}}; // generated maze extras: lever spots, colour order for the gate, notes, husk nests
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
const BLOCKED_CELLS = [[7, 15], [9, 15], [2, 15], [4, 17], [14, 15], [17, 17]]; // + the entrance columns and four yard trees

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
    hidden: true,
    x: 7.4,
    y: 3.7,
    h: 0.775, // on the little desk inside Apartment 2 inside Apartment 2
    color: "#d4b04a",
    height: 0.9,
    pickupText: "A brass key on a paper tag: 4.",
  },
  { id: "axe", name: "Axe", x: 13.6, y: 1.5, /* under John's bed */ color: "#999999", height: 0.9, pickupText: "A fire axe." },
  { id: "johnNote", name: "Note - Sept 21", note: true, order: 4, h: 0.57, x: 14.25, y: 0.35, paper: "Sept 21\nthird week. no sleep.\nit stands in the hall at\nnight. i can't look at it.\ni hid the axe under my\nbed. just in case.", sloppy: 0.6, seed: 3 },
  { id: "radioBatt", name: "Batteries", h: 0.76, x: 11.9, y: 12.55, pickupText: "Spare batteries." },
  { id: "hallBatt", name: "Batteries", h: 0.04, x: 12.5, y: 6.3, pickupText: "Spare batteries." },
  { id: "stairBatt", name: "Batteries", h: 0.04, x: 19.65, y: 3.8, pickupText: "Spare batteries." },
  { id: "cellarBatt", name: "Batteries", h: 0.04, x: 50.3, y: 5.3, pickupText: "Spare batteries." },
  { id: "f2Batt2", name: "Batteries", h: 0.04, x: 30.2, y: 5.5, pickupText: "Spare batteries." },
  { id: "deskBatt", name: "Batteries", h: 0.77, x: 3.15, y: 11.5, pickupText: "Spare batteries." },
  { id: "batteries", name: "Batteries", h: 0.92, x: 14.95, y: 0.35, pickupText: "Spare batteries." },
  { id: "staffBatt1", name: "Batteries", h: 1.04, x: 1.5, y: 5.75, pickupText: "Spare batteries." },
  { id: "staffBatt2", name: "Batteries", h: 0.77, x: 4.5, y: 5.45, pickupText: "Spare batteries." },
  { id: "staffNote", name: "Notice", note: true, h: 0.77, x: 3.7, y: 5.4, paper: "Power out again?\nMain breaker is down in\nthe cellar. Stairs at the\nend of the hall.\nBring a light.\n- Mgmt", sloppy: 0.1, seed: 7 },
  { id: "note5", name: "Note - Sept 28", note: true, order: 6, x: 51.5, y: 2.4, paper: "Sept 28\nfollowed it down.\nthe cellar door under\nthe stairs. the boiler is\nwarm. it is {breathing}\nnothing down there\nshould be warm", sloppy: 1.05, seed: 66 },
  { id: "batteries2", name: "Batteries", x: 50.5, y: 9.4, h: 0.5, pickupText: "Spare batteries." },
];

// Spots you can use with E. 'go' teleports between levels.
const HOTSPOTS = [
  { id: "boards", x: 18.5, y: 3.4, label: "Boards" },
  { id: "elevatorDown", x: 24.5, y: 2.3, label: "Call Elevator", elevatorDown: true },
  { id: "finaleNote", x: 59.4, y: 16.5, label: "Read Note", paper: { paper: "Maria,\nyou came down anyway.\nit wears the building.\nit wore me for a while.\nit hates the light\nbecause the light\nremembers it.\nkeep looking at it.\n{don't blink}\n- J", sloppy: 0.9, seed: 160 } },
  { id: "finaleExit", x: 51.0, y: 16.5, label: "Take Elevator", finaleExit: true },
  { id: "drawers", x: 2.4, y: 10.35, label: "Search Drawer" },
  { id: "guestLog", x: 3.1, y: 11.15, label: "Read Guest Log" },
  { id: "breaker", x: 53.2, y: 1.9, label: "Flip Breaker" },
  { id: "staffBoard", x: 4.6, y: 5.95, label: "Read Notice Board", board: true },
  // lobby extra: a radio
  { id: "radio", x: 11.5, y: 12.1, label: "Turn On Radio" },
];

const RADIO_PAPER = { paper: "[static]\n...residents of Hollow\nHouse are asked to stay in\ntheir units after dark.\nManagement says it is\nthe pipes. [static]\n...if you can hear this\n{leave}", sloppy: 0.2, seed: 171 };

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
  { id: "gDown", x0: 17.1, x1: 19.5, z0: 3.9, z1: 1.25, rise: -3.0, to: { x: 49.3, y: 5.4, yaw: -Math.PI / 2 } },
  { id: "bUp", x0: 47.2, x1: 48.6, z0: 5.8, z1: 3.15, rise: 3.0, to: { x: 18.5, y: 3.65, yaw: Math.PI } },
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
  { id: "baseSlam", level: 2, kind: "slam", trigger: { x: 54.6, z: 3.5, r: 0.8 }, at: { x: 56.5, z: 3.5 }, delay: 0.9, life: 1.6 },
  { id: "baseCrawl", level: 2, kind: "crawler", trigger: { x: 50.5, z: 7.4, r: 1.0 }, at: { x: 53.6, z: 10.8 }, to: { x: 51.0, z: 8.9 }, dur: 1.0 },
  { id: "baseDrop", level: 2, kind: "drop", trigger: { x: 51.8, z: 9.6, r: 1.1 }, at: { x: 52.4, z: 9.0 } },
  // on the stairs themselves
  { id: "downStairs", level: 0, kind: "lurker", trigger: { x: 18.3, z: 3.5, r: 0.8 }, at: { x: 18.3, z: 1.7 }, delay: 0.2, life: 4, near: 1.0 },
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
trinket("a2Photo", "Family Photo");
trinket("a2Cans", "Canned Food");
trinket("a2Coin", "Old Coin");
trinket("a2Pills", "Pill Bottle");
// apartment 3 (someone who stopped trusting the building)
trinket("a3Box", "Music Box");
trinket("a3Photo", "Torn Photo");
// apartment 4 (John's)
trinket("jTag", "Dog Tag");
trinket("jPhoto", "John's Photo");

// ---- John's notes: one person, dated; the later ones get stranger. Hand: neat (low sloppy) -> frantic (high).
// Only nine of these exist in the whole building, so each one matters.
const johnNote = (id, name, order, paper, sloppy, seed, spot) => {
  const it = { id, name: "Note - " + name, note: true, order, paper, sloppy, seed };
  if (spot) Object.assign(it, { x: spot[0], y: spot[1], h: spot[2] || 0.02 }); else it.hidden = true;
  ITEMS.push(it);
};
johnNote("nSep2", "Sept 5", 0.5, "Sept 5\nMaria - if anything\nhappens to me, my key\nis yours. the thing we\ndiscussed is under my\nbed. don't let anyone\nelse in. - J", 0.15, 59);
johnNote("nSep3", "Sept 3", 1, "Sept 3\nmoved into 4 today.\nquiet building, good rent.\nthe manager would not look\nat me when he gave me\nthe key. told Maria.\nshe worries too much.", 0.1, 61);
johnNote("nSep9", "Sept 9", 2, "Sept 9\nsomeone walks the halls\nat night. slow. heavy.\nchecked the peephole.\nnothing there.\nprobably the pipes.", 0.2, 62);
johnNote("nSep14", "Sept 14", 3, "Sept 14\nit is not the pipes.\nthe walking stops outside\nmy door. every night 3:13.\nstopped using the peephole.", 0.4, 63, [26.2, 2.2]);
johnNote("nSep25", "Sept 25", 5, "Sept 25\npower cut again.\nthat is when it moves.\nin the dark it is {fast}\nin the light it only watches\nkeep the light on", 0.85, 65, [34.6, 10.4]);
johnNote("nOct1", "Oct 1", 7, "Oct 1\nboarded the stairs.\nit does not use the stairs.\nit is {already upstairs}\nit is {already below}\nit is in the walls", 1.3, 67);
johnNote("nOct3", "Oct 3", 8, "Oct 3\nhaven't eaten in 4 days.\nit knows my name now.\nit says it from the {vents}\nthe light is the only\nthing it is afraid of", 1.55, 68, [39.5, 2.2]);
johnNote("nOct4", "Oct 4", 9, "Oct 4\nit is wearing my coat.\nit is standing behind\nwhoever is reading this.\n{turn around}\nMaria. i'm sorry.", 1.85, 69);

// Furniture you can search: position inside a studio (x, z from its west wall / north wall), prompt.
const APT_SPOTS = [
  { k: "bed", rx: 1.0, rz: 1.5, label: "Check Pillow", anim: "pillow" },
  { k: "nightstand", rx: 1.25, rz: 0.75, label: "Search Nightstand", fx: 1.25, fz: 0.56, y: 0.32, rot: 0, anim: "drawer" },
  { k: "dresser", rx: 1.95, rz: 0.75, label: "Search Dresser", fx: 1.95, fz: 0.52, y: 0.5, rot: 0, anim: "drawer" },
  { k: "under", rx: 2.1, rz: 1.0, label: "Open Cabinet", fx: 2.4, fz: 0.98, y: 0.46, rot: -Math.PI / 2, anim: "cabdoor" },
  { k: "drawer", rx: 2.1, rz: 1.5, label: "Search Drawer", fx: 2.38, fz: 1.45, y: 0.62, rot: -Math.PI / 2, anim: "drawer" },
  { k: "fridge", rx: 2.1, rz: 2.55, label: "Open Fridge", fx: 2.38, fz: 2.55, y: 0, rot: -Math.PI / 2, anim: "fridge" },
  { k: "couch", rx: 0.95, rz: 3.0, label: "Search Couch" },
  { k: "desk", rx: 2.0, rz: 3.5, label: "Open Desk Drawer", fx: 2.19, fz: 3.75, y: 0.58, rot: -Math.PI / 2, anim: "drawer" },
];
// What each spot holds: an item id, or null (empty, you only find that out by looking).
const LOOT = {
  apt2: { fridge: null, under: ["a2Cans", "apt3Key"], desk: "nSep2", bed: "johnKey" },
  apt3: { bed: null, nightstand: null, desk: "a3Photo", drawer: "a3Box", dresser: "nSep9", under: "a3Batt", couch: "a3Batt2", fridge: null },
  john: { dresser: null, desk: null, bed: "nOct4", couch: "nOct1", fridge: null, under: "jBatt", drawer: "jTag", nightstand: "jPhoto" },
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
HOTSPOTS.push({ id: "apt3_calendar", x: 11.2, y: 3.4, label: "Read Calendar", paper: { paper: "SEPTEMBER\n14  boiler man - no show\n20  plumber - left early\n28  {circled three times}\nit knocks three times.\nthen the lights go.\n{don't answer.}", sloppy: 0.5, seed: 92 } });
HOTSPOTS.push({ id: "apt2_switch", x: 5.9, y: 3.6, label: "Flip Light Switch", lightSwitch: true });
WALL_WRITING.forEach((w) => HOTSPOTS.push({ id: w.id, x: APT_DEFS.find((a) => a.id === w.apt).ox + w.rx + Math.sin(w.rot) * 0.9, y: w.rz + Math.cos(w.rot) * 0.9, label: w.label, paper: { paper: w.paper, sloppy: w.sloppy, seed: w.seed } }));

// ---- second floor: a corridor of closed apartment doors. Rooms are 3 deep; v counts from the far wall. ----
// side N: rooms at z 1-4, door in the wall at z 4. side S: rooms at z 9-12, door in the wall at z 9.
const DOOR_OPEN_ANGLE_F2 = Math.PI * 0.5;
const F2_ROOMS = [
  { id: "f2n1", side: "N", c0: 23, w: 4, layout: "lobby", wall: "hall", floor: "tile",
    spots: [{ u: 2.4, v: 1.6, label: "Read Directory", paper: "FLOOR TWO\n11   Marsh\n12   Kowal\n13   ----\n14   ----\n15   Hale\n16   {nobody}\n17   ----", sloppy: 0.2, seed: 140 }] },
  { id: "f2n2", side: "N", c0: 28, w: 4, door: 29, plate: "11", layout: "bedroom", wall: "f2a", floor: "plank", accent: 0x5a3a3a, color: "#8a7f62",
    spots: [{ u: 2.35, v: 1.0, label: "Check Nightstand", text: "A glass of water. Still full." }] },
  { id: "f2n3", side: "N", c0: 33, w: 4, door: 34, plate: "12", layout: "kitchen", wall: "f2b", floor: "tile", color: "#3e4a52",
    spots: [{ u: 3.5, v: 1.3, label: "Open Fridge", text: "Warm inside. The light is dead." }, { u: 0.9, v: 1.7, label: "Run Tap", text: "It drips. It stops when you listen." }] },
  { id: "f2n4", side: "N", c0: 38, w: 4, door: 39, plate: "13", layout: "study", wall: "f2c", floor: "plankDark", color: "#4c3a34",
    spots: [{ u: 1.4, v: 1.25, label: "Read Desk Note", paper: "to whoever is left\nthe elevator only comes\nwhen the lights hum.\ndon't ride it {twice}\nthe second time it\ngoes down. there is a\nkey. i hid it with\nthe things that crawl", sloppy: 0.8, seed: 141 }] },
  { id: "f2n5", side: "N", c0: 43, w: 2, door: 43, plate: "U", layout: "utility", wall: "hall", floor: "plankDark", color: "#6b6f72",
    spots: [{ u: 1.0, v: 0.8, label: "Check Shelf", text: "Bleach. Rags. A mop that is still wet." }] },
  { id: "f2s1", side: "S", c0: 23, w: 4, door: 24, plate: "14", layout: "vacant", wall: "f2d", floor: "plankDark", color: "#8a7f62",
    spots: [{ u: 1.0, v: 1.9, label: "Examine Chair", text: "It faces the corner. The seat is warm." }] },
  { id: "f2s2", side: "S", c0: 28, w: 4, door: 29, plate: "15", layout: "tv", wall: "f2b", floor: "carpet", color: "#3e4a52",
    spots: [{ u: 2.0, v: 1.0, label: "Turn On TV", text: "Static. Then, for a second, this hallway." }] },
  { id: "f2s3", side: "S", c0: 33, w: 4, door: 34, plate: "16", layout: "nursery", wall: "f2a", floor: "carpet", locked: true, keyId: "f2Key", color: "#4c3a34",
    spots: [{ u: 1.2, v: 1.3, label: "Read Note", paper: "Sept 30\nthe baby stopped crying\nweeks ago.\nthe mobile still turns.\ni hear it at 3am.\nit plays the {same four notes}", sloppy: 0.9, seed: 142 }] },
  { id: "f2s4", side: "S", c0: 38, w: 4, door: 39, plate: "17", layout: "bathroom", wall: "f2c", floor: "tile", color: "#8a7f62",
    spots: [{ u: 1.5, v: 1.2, label: "Look in Mirror", text: "Your reflection blinks late." }] },
  { id: "f2s5", side: "S", c0: 43, w: 2, door: 43, plate: "M", layout: "meters", wall: "hall", floor: "plankDark", color: "#6b6f72",
    spots: [{ u: 1.0, v: 0.7, label: "Check Meters", text: "Every dial reads zero. One is ticking." }] },
];
const f2Pos = (r, u, v) => ({ x: r.c0 + u, y: r.side === "N" ? 1 + v : 12 - v });
F2_ROOMS.forEach((r, ri) => {
  if (r.door !== undefined) {
    DOORS.push({
      id: r.id, x: r.door + 0.5, y: r.side === "N" ? 4.5 : 8.5, interactionDistance: 1.4, label: r.locked ? "Try Door" : "Open Door",
      locked: !!r.locked, keyId: r.keyId, unlockLabel: r.locked ? "Unlock Apartment " + r.plate : undefined, lockedText: "Locked.",
      style: r.layout === "utility" || r.layout === "meters" ? "flush" : "wood6", plate: r.plate, baseColor: r.color, frame: "#2a2218", handle: "lever",
      metal: "#a89a60", creak: 0.85 + (ri % 5) * 0.07, creakTone: 3000 + ri * 530, creakGain: 0.7 + (ri % 4) * 0.08, creakStart: 0.01 * ri, openAngle: r.side === "S" ? DOOR_OPEN_ANGLE_F2 : undefined,
    });
  }
  (r.spots || []).forEach((s, i) => {
    const p = f2Pos(r, s.u, s.v);
    const h = { id: r.id + "_" + i, x: p.x, y: p.y, label: s.label };
    if (s.paper) h.paper = { paper: s.paper, sloppy: s.sloppy || 0.4, seed: s.seed || 150 + i };
    else h.text = s.text;
    HOTSPOTS.push(h);
  });
});
ITEMS.push(
  { id: "f2Key", name: "Key 16", key: true, x: 43.12, y: 2.4, h: 1.35, color: "#d4b04a", height: 0.9, pickupText: "A brass key on a tag: 16." },
  { id: "f2Batt", name: "Batteries", x: 34.2, y: 11.7, h: 0.92, pickupText: "Spare batteries." }
);

// The cellar maze: three coloured levers (the gate's lintel shows the order), a couple of notes and a hidden nest.
CELLAR.levers.forEach((l, i) => HOTSPOTS.push({ id: "lever" + i, x: l.c + 0.5, y: l.r + 0.5, label: "Pull Lever", lever: i }));
const MAZE_NOTES = [
  "Sept 26\nthe walls here are {wet}\nwhen i hold the light on\nthem they stop.\nthey only stop.",
  "Sept 27\nthree handles. i pulled\nthem the way that felt right\nand something up there\n{laughed}",
];
CELLAR.notes.forEach((n, i) =>
  ITEMS.push({ id: "mazeNote" + i, name: "Note - Sept " + (26 + i), note: true, order: 7 + i, x: n.c + 0.5, y: n.r + 0.5, paper: MAZE_NOTES[i % 2], sloppy: 1.1, seed: 120 + i })
);
ITEMS.push(
  { id: "elevKey", name: "Elevator Key", key: true, x: 67.4, y: 2.2, h: 0.1, color: "#d4b04a", height: 0.9, pickupText: "A small steel key. The tag reads: B." },
  { id: "finaleBatt", name: "Batteries", x: 51.4, y: 14.6, h: 0.1, pickupText: "Spare batteries." },
  { id: "nestBatt1", name: "Batteries", x: 67.5, y: 1.6, h: 0.1, pickupText: "Spare batteries." },
  { id: "nestBatt2", name: "Batteries", x: 67.5, y: 4.4, h: 0.1, pickupText: "Spare batteries." },
  { id: "nestNote", name: "Note - Sept 29", note: true, order: 9, x: 67.6, y: 3.0, h: 0.1, paper: "Sept 29\nthey were people once.\nthe light hurts them.\nso does the axe.\nthe lift has a button\nnobody presses. B.\nthe key is by my hand.\nMaria, I heard you call.\nit is quiet {now}", sloppy: 1.3, seed: 133 }
);
const PORTALS = []; // (the flats are real rooms behind the doors now)

// Damage and clutter that differs between flats.
const APT_DAMAGE = {
  apt2: { holes: [], ceil: [], mess: 6 },
  apt3: { holes: [], ceil: [[1.5, 2.0, 1.0, 0.9]], mess: 14 },
  john: { holes: [], ceil: [], mess: 10 },
};