# Hollow House

A small explorable-map horror RPG prototype: character creation, a manor you
walk through with the keyboard, and NPC conversations that branch based on
your stats, your nerve, and the choices you've already made.

## Project structure

```
rpg-game/
├── index.html      Page structure — two screens (create, explore) plus a
│                    dialogue overlay
├── css/
│   └── style.css    All visual styling
├── js/
│   ├── data.js      Content: classes, map layout, dialogue trees
│   └── game.js       Logic: state, rendering, movement, dialogue handling
└── README.md
```

Content and logic are split on purpose. To add a new NPC, room, or line of
dialogue, you should only ever need to touch `data.js`.

## Running it locally

No build step — just open `index.html` in a browser. If your browser blocks
local file access for scripts, run a tiny local server instead:

```bash
cd rpg-game
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploying to GitHub Pages (free hosting)

1. Create a new GitHub repo and push this folder's contents to it (the repo
   root should contain `index.html` directly, not nested inside another
   folder).
2. On GitHub, go to **Settings → Pages**.
3. Under **Source**, choose the branch you pushed (usually `main`) and the
   `/ (root)` folder, then save.
4. GitHub gives you a URL like `https://yourusername.github.io/repo-name/`
   — it can take a minute to go live after the first deploy.

Any time you push new commits to that branch, the live site updates
automatically.

## How the game works

The explore screen is a **first-person raycaster** (the classic
Wolfenstein/DOOM technique), drawn to a `<canvas>` every animation frame —
not a 3D engine, just math: for each vertical strip of the screen, cast a
ray out from the player until it hits a wall, and draw a taller or shorter
wall slice depending on how far away that hit was.

- **`state`** in `game.js` holds everything: player position/angle, stats,
  flags, the message log, and which NPC (if any) you're talking to. It's a
  natural place to hook up save/load later (`JSON.stringify(state)` into
  `localStorage`, or a downloadable save file).
- **The map** (`MAP` in `data.js`) is now a plain binary grid: `0` = open
  floor, `1` = wall. NPCs and the exit live in their own arrays (`NPCS`,
  `EXIT`) with floating-point coordinates, since movement is continuous
  rather than tile-by-tile.
- **Movement**: W/S (or ↑/↓) move forward/back along the direction you're
  facing; A/D (or ←/→) rotate. Collision is checked separately on the X and
  Y axes so you slide along walls instead of sticking in corners.
- **Interaction is proximity-based**: get within range of an NPC or the
  exit and a `[E] ...` prompt appears at the bottom of the screen; pressing
  E triggers it. See `nearestInteractable()` in `game.js`.
- **Dialogue trees** are unchanged from the top-down version — plain
  objects keyed by node name. Each choice can:
  - `next`: which node to jump to (or `null` to end the conversation)
  - `check`: `{ stat: "insight", min: 4 }` — greys out the option unless the
    player's stat meets the threshold
  - `requiresFlag`: only show this option if a flag was set earlier
  - `setFlags`: `{ hasCaretakerLead: true }` — remembered for the rest of
    the playthrough and can gate later choices with other NPCs
- **The minimap** (top-right corner) is a second, smaller canvas that just
  draws the wall grid, NPC dots, and a player marker each frame — useful
  for development, but consider hiding or limiting it for the shipped game
  if you want the manor to feel more disorienting.

## Natural next steps

1. **Bigger map** — the raycaster scales to any size grid; try adding more
   rooms and corridors to `MAP` in `data.js`.
2. **Textures instead of flat-shaded walls** — currently walls are just
   shaded rectangles; texture-mapping them (even a simple repeating pattern)
   is the next-biggest visual upgrade.
3. **A dread/sanity meter** — a fourth stat that rises with certain choices
   or areas and starts warping the render (screen shake, color shift,
   flickering) at high values.
4. **Sound design** — the Web Audio API can add ambient creaks, stingers on
   jump-scare moments, or footsteps synced to movement.
5. **Mouse look** — swap A/D-to-rotate for `pointer lock` + mouse movement
   for a more modern FPS feel.
6. **Inventory / items** that unlock new dialogue options (a key, a journal
   page, a photograph).
7. **Save/load** using `localStorage`, since the state object is already
   structured for it.