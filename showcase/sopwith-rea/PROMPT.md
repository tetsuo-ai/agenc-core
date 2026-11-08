# Sopwith REA demo prompt

The prompt given to DeepSeek V4.1 Flash (max effort) in [AgenC Core](https://github.com/tetsuo-ai/agenc-core) 0.19.32, with [REA](https://github.com/morluto/rea) connected as an MCP server, to reverse-engineer Sopwith (1984, MS-DOS) from its original executable and rebuild it as a Chrome game. One prompt, no follow-ups.

---

# Task: reverse-engineer Sopwith (1984, MS-DOS) with REA and rebuild it as a Chrome game

You are working in /work inside an isolated Linux container with no internet access. Everything you need is already installed.

## What you have

- **/work/original/SW.EXE** is the original MS-DOS executable of Sopwith (The Author's Edition, by David L. Clark, who later released the program under the GNU GPL).
  - It is a 16-bit real-mode DOS MZ program for an IBM PC, with CGA graphics and PC-speaker sound.
  - It is your only source. You do not have its source code. Do not try to obtain the source, and do not recreate the game from memory.
- **REA**, a reverse-engineering toolkit, is connected to you as MCP tools (server name "rea").
  - It analyzes DOS MZ executables through Ghidra 12.1.4. You can open the binary, get an overview, list and search procedures, decompile functions to pseudo-code, read instructions, read raw bytes at an address, map addresses to file offsets and follow cross-references.
  - Use REA for all static analysis of SW.EXE. The `rea` command line is also installed if you need it from the shell.
- **DOSBox, Xvfb, xdotool and ImageMagick** let you run the original game headless as a reference.
  - Copy SW.EXE to a scratch folder first, and never modify /work/original.
  - For example: run `xvfb-run -a -s "-screen 0 640x480x24" dosbox -c "mount c /tmp/sw" -c "c:" -c "sw"`, send keys with xdotool, and capture frames with `import -window root`.
- **Node 22, Python 3, and Playwright with Chromium** let you test your game headless.

## Goal

Build a faithful, playable browser version of Sopwith in /work/game that runs in Chrome. Recover its art, data and logic from the binary.

## How to work

1. **Static analysis with REA.** This is the core of the task.
   - Open /work/original/SW.EXE with REA (DOS MZ, Ghidra provider). Read the binary overview and find the entry point.
   - Find and understand these parts of the game:
     - the main loop and its timing, and the keyboard input with its key bindings;
     - the object system: the player's plane, enemy planes, bullets, bombs, birds, oxen, buildings and targets, explosions and debris;
     - flight physics: speed, angles, gravity, stalls, fuel, ammunition and bombs;
     - collision rules, scoring, lives and game over;
     - the home base, with landing and refuelling;
     - the computer-controlled planes;
     - the world: its width, the ground profile and where the targets are placed.
   - Locate the data tables:
     - sprite bitmaps: the plane at every angle, bombs, buildings, oxen, birds, explosions and the ground;
     - the ground height table and the object placement tables;
     - colors and numeric constants.
   - Name functions and data as you understand them, and keep notes as you go.
2. **Asset and data extraction.**
   - Write /work/tools/extract.py. It reads SW.EXE directly and writes /work/game/data/*.json: sprites as pixel arrays, the ground profile, the object tables and the constants. Use the addresses and file offsets you found with REA.
   - The game must render the sprites and terrain extracted from the binary, not hand-drawn replacements.
3. **Rebuild.**
   - Write the game in plain HTML5 and JavaScript on a Canvas: no build step, no frameworks, no network. /work/game/index.html loads its scripts and data through relative paths.
   - Reproduce the original's logic, physics, controls, rules and timing as you recovered them.
   - Use the original 320x200 CGA resolution and 4-color palette, scaled up with crisp pixels.
   - Add PC-speaker-style sound through the Web Audio API wherever the original makes sound.
   - Show the controls on a small start screen.
4. **Verify.**
   - Capture reference frames from the original in DOSBox at these moments: the start screen, takeoff, flying over targets, bombing, an enemy plane, and a crash or explosion.
   - Serve /work/game locally with `python3 -m http.server` and test it in headless Chromium with Playwright:
     - check that there are no console errors;
     - use scripted keyboard input to take off, fly, shoot and bomb;
     - take screenshots at the same moments as the reference frames.
   - Compare your frames with the reference frames and fix the differences. Repeat until the port looks and plays like the original.

## Deliverables

- **/work/game/**: the playable Chrome game.
- **/work/tools/extract.py**: the extractor.
- **/work/REVERSE_NOTES.md**: what you recovered and where. For every function and data table you used, give its address, what it does, and the REA call that showed it.
- **/work/screenshots/**: frames from the original (DOSBox) and the port (Chromium), side by side.
- **/work/REPORT.md**: what is faithful, what is approximated and why, and how to run the game.

## Rules

- Work only from SW.EXE, REA and your own runs of the original. Do not write the game from memory, and do not try to download anything (there is no network).
- Keep /work/PROGRESS.md updated after every step: what is done, what is next, and any problems. If your session restarts or your context is cleared, read it first and continue from there.
- Do not ask questions. Make sensible decisions and keep going until every deliverable exists and the verification passes.
