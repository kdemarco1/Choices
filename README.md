# Choices
A new horror game with the ability to decide your fate
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

- **`state`** in `game.js` holds everything: player position, stats, flags,
  the message log, and which NPC (if any) you're talking to. Every screen
  re-renders from this object, so it's a natural place to hook up save/load
  later (`JSON.stringify(state)` into `localStorage`, or a downloadable
  save file).
- **The map** (`MAP` in `data.js`) is a 2D array. `0` = floor, `1` = wall,
  `4` = the locked cellar door. Numbers `2` and `3` are NPCs — add more by
  picking a new number, placing it on the grid, and giving it a matching
  entry in `DIALOGUES`.
- **Dialogue trees** are plain objects keyed by node name. Each choice can:
  - `next`: which node to jump to (or `null` to end the conversation)
  - `check`: `{ stat: "insight", min: 4 }` — greys out the option unless the
    player's stat meets the threshold
  - `requiresFlag`: only show this option if a flag was set earlier
  - `setFlags`: `{ hasCaretakerLead: true }` — remembered for the rest of
    the playthrough and can gate later choices with other NPCs (e.g. the
    Groundskeeper only opens the cellar if you have the Caretaker's lead)

## Natural next steps

1. **Bigger map + camera scrolling** — right now the whole map fits on
   screen; a real haunted house will need more rooms than one screen.
2. **Sprites and lighting** — swap the `@`/`C`/`G` text tiles for actual
   images, and consider a flashlight-cone or fog-of-war effect for dread.
3. **A dread/sanity meter** — a fourth stat that rises with certain choices
   or areas and starts warping the UI or dialogue options at high values.
4. **Sound design** — the Web Audio API can add ambient creaks, stingers on
   jump-scare moments, or a heartbeat that speeds up near danger.
5. **Inventory / items** that unlock new dialogue options (a key, a journal
   page, a photograph).
6. **Save/load** using `localStorage`, since the state object is already
   structured for it.
7. **Combat or other consequences** beyond dialogue — a failed check could
   trigger something other than just a closed door.