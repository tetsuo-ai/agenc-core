# Task: recover the 1993 engine inside DOOM.EXE with REA, then build an original browser shooter on it

You are working in /work inside an isolated Linux container with no internet access. Everything you need is already installed.

## What you have

- **/work/original/DOOM.EXE** is the MS-DOS executable of the shareware release of DOOM v1.9 (id Software). The shareware release may be freely copied.
  - It is your only source for the engine. You do not have its source code, its WAD data file, or any of its art, maps or sounds. Do not try to obtain them, and do not recreate any of them from memory.
  - The program is 32-bit protected-mode code built with Watcom C and bound to the DOS/4GW extender. The file starts with a 16-bit MZ stub, which is the extender, about 61 KB of 16-bit code. The program itself is a Linear Executable ("LE"). Its header starts at the file offset stored in the dword at 0x3C.
  - REA's Ghidra loader only sees the 16-bit stub. Step 1 turns the LE program into a 32-bit ELF file that REA can analyze.
- **REA**, a reverse-engineering toolkit, is connected to you as MCP tools (server name "rea"). It analyzes executables through Ghidra 12.1.4, including 32-bit x86 ELF files.
  - You can open a binary and get an overview, list and search procedures, and decompile functions to pseudo-code.
  - You can also read instructions and raw bytes, follow cross-references, and name functions and add comments.
  - Use REA for all static analysis. The `rea` command line is also installed.
- **Node 22, Python 3, Playwright with Chromium, and ImageMagick** are installed for building and testing.

## Goal

1. **A recovered engine.** Document how DOOM.EXE renders a world from a BSP tree and how its game loop, physics, collision, line of sight, moving sectors and actor logic work, with addresses.
2. **An original game built on that engine.** Write a first-person shooter called **CORE BREACH** in plain HTML5 and JavaScript.
   - Everything the player sees and hears is new: the name, setting, level, textures, enemies, weapons, HUD and sounds.
   - Nothing from DOOM's art, levels, sounds, names, characters or text appears in it.

## Step 1: make the LE program analyzable

Write **/work/tools/le2elf.py**. It reads DOOM.EXE and writes **/work/analysis/doom-le.elf**.

- **LE header.** All offsets are from the start of the LE header, and all fields are dwords.
  - 0x18: object number holding EIP. 0x1C: EIP.
  - 0x28: page size. 0x2C: bytes on the last page.
  - 0x40: object table offset. 0x44: number of objects.
  - 0x48: object page map offset.
  - 0x68: fixup page table offset. 0x6C: fixup record table offset.
  - 0x80: data pages offset. This one is relative to the start of the file, not the LE header.
- **Object table.** Each entry is 24 bytes: virtual size, relocation base address, flags, first page-map index (1-based), page count, reserved. Flag 0x4 marks an executable object.
- **Page map.** It has 4 bytes per page. Watcom writes the pages in order: check that the page numbers in the map run in sequence.
  - Page n (1-based) starts at data_pages_offset + (n - 1) * page_size.
  - Only the last page of the file is shorter ("bytes on the last page").
  - Space between an object's file data and its virtual size is zero-filled memory.
- **Fixup page table.** It holds (number of pages + 1) dwords. The records for page n are the bytes [fpt[n-1], fpt[n]) of the fixup record table.
- **Fixup record fields, in order:**
  - **Source-type byte.** Its low nibble gives the type: 7 = 32-bit offset, 8 = 32-bit self-relative, 2 = 16-bit selector, 5 = 16-bit offset, 6 = 16:32 pointer. Bit 0x20 means a list of source offsets follows instead of one.
  - **Target-flags byte.** The low two bits are 0 for an internal reference. Bit 0x04: additive. Bit 0x10: 32-bit target offset. Bit 0x20: 32-bit additive value. Bit 0x40: 16-bit object number.
  - **Source offset.** A signed 16-bit offset within the page. With a source list, this is a count byte instead.
  - **Target object number.** 1 byte, or 2 bytes when bit 0x40 is set.
  - **Target offset.** 2 or 4 bytes. Selector fixups (type 2) have no target offset.
  - **Additive value**, if bit 0x04 is set.
  - **The list of 16-bit source offsets**, if this is a list record.
- **Applying fixups** to a flat image of all objects:
  - 32-bit offset: write object_base[target] + target_offset (+ additive).
  - Self-relative: write that value minus (source address + 4).
  - 16:32 pointer: write only its offset part.
  - Selectors and 16-bit fields: leave them alone.
  - A value that crosses a page boundary appears in the records of both pages. Writing it twice is harmless.
- **The ELF.** Write a little-endian ELF32 file for i386 (EM_386, ET_EXEC).
  - One PT_LOAD per object, at its relocation base, with filesz equal to the bytes present and memsz equal to the virtual size.
  - Code objects are R+X; the others are R+W.
  - e_entry = base of the EIP object + EIP.
  - Add matching section headers (.text for code objects, .data for the others) and a section-name string table.
- **Check the conversion before you go on.**
  - The entry point must decompile as the Watcom C startup code.
  - Call targets and data addresses in the code must land inside objects.
  - Text strings in the data object, such as startup messages, must be referenced from code.
  - Fix the converter until all of this holds.
- Then open /work/analysis/doom-le.elf with REA and work from it. Keep /work/original untouched.

## Step 2: recover the engine with REA

Find, decompile, name and comment the code for each part below. For each part, write down in /work/REVERSE_NOTES.md the addresses, what the code does, and the REA call that showed it.

- **Math.** 16.16 fixed-point arithmetic and its multiply and divide helpers. Binary angles, the fine sine and tangent tables and how they are indexed, and the point-to-angle routine. Generate equivalent tables yourself from what you learn. Do not copy table data out of the binary.
- **Renderer.**
  - BSP traversal: front to back, the side-of-partition test, and the bounding-box check.
  - Wall segments: projection to screen columns and the list of solid screen ranges used for clipping.
  - Wall texturing: upper, lower and middle textures, with the pegging rules.
  - Visplanes: how floor and ceiling spans are collected and drawn.
  - Lighting: sector light levels and the drop-off with distance through light tables.
  - The sky.
  - Sprites: projection, sorting, and clipping against the walls in front of them.
  - The column and span drawers, and the view window size.
- **Map data model.** Vertexes, linedefs (flags, special types, tags), sidedefs, and sectors (floor and ceiling heights, light, special, tag). Also segs, subsectors, nodes, the blockmap and the reject table. Learn these from the code that loads and uses them.
- **Game loop.** The fixed tic rate, how input becomes a per-tic command, and the order of the world update.
- **Player movement.** Thrust, friction, maximum speed, view bob, step-up height and gravity. Collision: the try-move routine, the blockmap search and sliding along walls.
- **Line of sight and shots.** How a line is traced through the map to check sight, to resolve hitscan shots and to aim.
- **Moving sectors.** Doors, lifts and switches, and how a "use" press finds the line in front of the player.
- **Actors.** The thinker list and the state machine (states with durations and actions). How an enemy wakes, chases, picks an attack, takes damage, flinches and dies. Recover the mechanism, not DOOM's particular monsters.
- **Random numbers.** The pseudo-random number generator and how the game uses it.

## Step 3: build CORE BREACH

Write it in plain HTML5 and JavaScript (ES modules) on a Canvas 2D: no frameworks, no build step, no network. /work/game/index.html loads everything through relative paths.

### Engine

Port what you recovered:
- **Rendering.** A BSP-tree renderer with front-to-back traversal and solid-range clipping. Visplanes for floors and ceilings. Sector lighting with distance drop-off. Textured walls, floors and ceilings, a sky, and sprites clipped against walls.
- **Resolution.** 320x200 internally, in 8-bit palette color (a 256-color palette and light tables that you build), scaled to the window with crisp pixels.
- **Timing.** 16.16 fixed point and binary angles for the game logic, and a 35 Hz tic rate, with rendering at the screen's frame rate.
- **Movement.** Player movement, collision, step-up, doors, lifts, switches and "use", as you recovered them.
- **Actors.** A thinker and state-machine system for enemies and projectiles, with the recovered line of sight and hitscan.
- **Map compiler.** Write /work/tools/build-map.mjs. It compiles a hand-authored map source (vertices, lines, sectors and things, in a format you design) into segs, subsectors, nodes, a blockmap and a reject table, the data model the engine expects. The game loads the compiled map.

### Content

All of it is original and generated by your code. No image, audio or map file is copied from anywhere.
- **Setting.** A fusion reactor station taken over by its own maintenance robots. The player is an engineer sent to shut the core down.
- **Level.** One complete level, "Reactor Deck 7", built to show off the engine:
  - at least 40 sectors with different floor and ceiling heights;
  - stairs and a lift;
  - two keycard doors (yellow and cyan);
  - windows onto a large outdoor area under the sky;
  - a coolant pool that hurts the player;
  - changes of light: dark corridors, flickering lights and a bright reactor hall;
  - an exit switch at the reactor core;
  - at least two secret areas.
  A walkthrough takes 3 to 6 minutes.
- **Textures.** At least 12 wall textures and 6 floor and ceiling textures, 64x64 or 128x128, made procedurally at startup in a palette you design. Examples: panel plating, pipes, warning stripes, grilles, computer banks, rock, coolant.
- **Enemies.** Drawn procedurally as sprites, with 8 rotations where it matters. Each has idle, move, attack, pain and death states, with sounds.
  - Cutter: a small, fast wheeled robot with saw arms that rushes in and slashes.
  - Drone: a hovering robot that fires slow plasma bolts.
  - Sentinel: a heavy two-legged walker with a hitscan burst. It takes many hits.
- **Weapons.** Shown in first person with firing animations.
  - Rivet gun: fast hitscan.
  - Scatter cannon: a spread of pellets.
  - Arc launcher: a projectile with blast damage.
- **Pickups.** Ammo, health, armor and the keycards, placed in the level.
- **HUD.** An original status bar showing health, armor, ammo, the current weapon and keycards, plus short messages such as "Picked up the cyan keycard". No face portrait.
- **Sound.** Every effect is synthesized with the Web Audio API at runtime: shots, impacts, doors, lifts, enemy alerts, pain, deaths and pickups. No music is needed.
- **Screens.**
  - A title screen with the name CORE BREACH, a one-line premise and the controls.
  - A death screen.
  - A level-complete screen with time, kills and secrets.
- **Controls.**
  - Move: W A S D, or the arrow keys.
  - Turn: the mouse, with pointer lock on click.
  - Fire: left click or Ctrl.
  - Use: E or Space.
  - Weapons: 1 to 3.
  - Pause: Esc.

### Hooks for recording a video later

- **window.__GAME__** exposes:
  - the state: title, playing, dead or done;
  - the tic counter;
  - the player: position, angle, health, armor, ammo, weapon and keys;
  - the live enemies, with positions and states;
  - the map.
- **window.__GAME__.input.** When a script sets it to an object such as {forward, strafe, turn, fire, use, weapon}, that object replaces keyboard and mouse input from the next tic on.
- **Attract mode at index.html?attract=1.** It starts straight in the level and plays it by itself along a route you author with the map: waypoints, smooth turns, opening doors, riding the lift, and shooting the enemies it sees. It then loops. In about 90 seconds it shows the best parts of the level.
- **Timing.** Use requestAnimationFrame and performance.now, never setInterval, so a test clock can step the game frame by frame.
- **Performance.** A steady 60 fps in Chrome on a normal laptop.

## Step 4: verify

- Serve /work/game with `python3 -m http.server` and test it in headless Chromium with Playwright:
  - there are no console errors;
  - drive the player with scripted input;
  - walls stop the player;
  - steps can be climbed and high ledges cannot;
  - doors and the lift work;
  - keycard doors stay shut without their key;
  - enemies wake, attack and die;
  - pickups work and the coolant hurts;
  - the exit switch ends the level.
- Take screenshots of at least eight moments into /work/screenshots: the title, the start, a corridor, the outdoor area with sky, a fight, the lift, the reactor hall, and level complete. Look at them.
  - Fix anything that looks wrong: gaps in walls, sprites showing through walls, flicker, stretched textures, wrong light.
- Run the attract mode for a full loop in headless Chromium. Confirm it reaches the reactor core without getting stuck.
- Write /work/game/verify.mjs. It repeats these checks automatically and exits non-zero on any failure.

## Deliverables

- **/work/game/**: the playable game.
- **/work/tools/le2elf.py**: the converter.
- **/work/tools/build-map.mjs**: the map compiler.
- **/work/REVERSE_NOTES.md**: every function and data structure you used. For each, give its address, what it does, the REA call that showed it, and where your engine uses it.
- **/work/screenshots/**: the screenshots from Step 4.
- **/work/REPORT.md**: what came from the binary, what is new, what is approximated and why, and how to run the game.

## Rules

- Recover the engine from DOOM.EXE with REA, and say in the notes which REA output each part rests on. Do not reproduce DOOM's source code from memory.
- Nothing from DOOM may appear in CORE BREACH.
  - No art, sprites, textures, maps, sounds, music, characters, enemy or weapon designs, text, names or logos.
  - Do not copy data tables (palettes, light tables, sine tables, random tables) out of the binary. Regenerate what you need from what you recover.
- There is no network. Do not try to download anything.
- Keep /work/PROGRESS.md updated after every step: what is done, what is next, and any problems. If your session restarts or your context is cleared, read it first and continue from there.
- Do not ask questions. Make sensible decisions and keep going until every deliverable exists and verify.mjs passes.
