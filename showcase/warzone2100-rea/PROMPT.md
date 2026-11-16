# Task: reconstruct a playable Warzone 2100 browser skirmish from its native binary and assets, using REA

You are AgenC Core running DeepSeek at max effort in /work on an isolated Linux machine. Work autonomously from this single prompt. Produce a real playable browser game and evidence of what you recovered. Do not ask for follow-up instructions.

## Inputs and strict evidence boundary

- `/work/original/warzone2100` is the unmodified official Warzone 2100 4.7.0 Linux x86-64 ELF executable (28,501,312 bytes). Its built-in symbol table is available. No external debug symbols or original game source code have been supplied.
- `/work/original/assets/` contains filtered versions of the official resource archives: `base-assets.wz`, `mp-assets.wz`, and `classic-assets.wz`. Their entries are genuine models, textures, sprites, sound, terrain, maps, resource indexes, localization and data tables. JavaScript, shader source and other source-like entries have been withheld. Compiled SPIR-V shader binaries may remain as binary assets.
- **Never obtain or consult the original game source, an existing browser port, walkthroughs, or previous reconstructions.** Do not recreate the game from memory or guess mechanics and call them recovered. There is no internet access from this environment. Leave `/work/original` unchanged.
- Use **REA** for all static analysis of the native executable: function discovery, decompilation, calls, cross references, strings, binary data and evidence. REA is connected as MCP server `rea`; the `rea` CLI is also installed. Ghidra is installed and ready. Python and general file tools may inspect and extract resource archives and use REA-derived binary offsets; do not substitute a different native decompiler or read game source.
- The original game is running independently on **X display `original:99`** at 1280x800. You can inspect and operate it using `DISPLAY=original:99 xdotool ...`, and capture it using `DISPLAY=original:99 import -window root /work/screenshots/reference.png`. It is an observation reference, not a shared filesystem. Its original scripts are intentionally inaccessible. Use its UI to start the campaign or a simple skirmish and compare behaviors. Do not kill the X server.

## Available development tools

- Node, Python 3 with Pillow and NumPy, ffmpeg, Xvfb, xdotool, ImageMagick, Playwright with Chromium, and Three.js are installed locally.
- Set `NODE_PATH=/usr/local/lib/node_modules` for Node scripts. Playwright is available through `require('playwright')`; its Chromium is preinstalled under `/opt/ms-playwright`.
- Three.js is installed at `/usr/local/lib/node_modules/three`; copy the needed modules and loaders into your game to keep it fully offline. Use local browser modules and an import map if useful. No CDN and no package downloads.
- `GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.4_PUBLIC` and `JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64` are configured. The JVM has a bounded heap. This is a large binary: use targeted REA analyses and symbol searches instead of attempting an indiscriminate decompilation of every function.
- The initial Ghidra profile disables the automatic passes `Decompiler Parameter ID`, `Decompiler Switch Analysis`, and `GCC Exception Handlers` to keep import within the available resources. Targeted function decompilation remains enabled. Preserve this setting and report its limitations; it does not prove that all indirect calls or exception paths have been recovered.
- Original license notices are available in `/work/original/licenses/`.
- You can create your own Xvfb display, e.g. `:100`, for headed browser testing. Do not use the reference game's display for your browser.
- Serve `/work/game` with `python3 -m http.server 8000 --bind 0.0.0.0 --directory /work/game`. Browser data fetches must stay local.

## Goal and priorities

Reconstruct a faithful, visually recognizable **small offline Warzone skirmish** in `/work/game`, using genuine extracted assets. This is a bounded gameplay reconstruction, not a claim to reproduce the full campaign, every unit or multiplayer.

The playable sequence must let a human:

1. See a real textured 3D terrain with the original visual style, buildings and units; move the camera and select a unit or a group with the mouse.
2. Order a construction unit to move and construct a building, with a visible build process and resource cost.
3. Acquire power/resources and use a factory to queue and produce combat units.
4. Order combat units around terrain and into combat against an opponent, with visible projectiles/effects, health, damage and destruction.
5. Win or lose the small scenario through actual gameplay.

Include working UI controls, readable resource and selection information, original audio where possible, a restart action, and concise instructions. A coherent complete gameplay loop is more valuable than a large nonfunctional feature list.

## Work process

1. **Discover and recover with REA.** Open the ELF with the Ghidra provider. Identify a focused set of relevant engine functions and data: simulation timing; movement and pathfinding; selection and orders; construction and production; power/resources; weapons, damage and destruction; asset/model/map loading. Recover concrete constants and rules with evidence. Prioritize analysis that directly informs a feature you will implement. Avoid spending the whole run analyzing without producing a working game.
2. **Extract original assets.** Write reproducible extraction/conversion scripts under `/work/tools`. Recover the model and terrain formats from binary evidence and supplied data. Convert the genuine units/buildings, textures, terrain and sounds you need into browser-compatible files. Prefer original geometry and textures over substitute primitives. Explain any substitute or simplification.
3. **Implement progressively.** Build a browser-native implementation in HTML/JavaScript, Canvas/WebGL/Three.js as appropriate. Get one unit and terrain rendering early, then controls, construction/production, combat and the scenario. Do not execute the supplied native game through an emulator in the browser or wrap the reference display as the result.
4. **Compare and test.** Observe the real game with screenshots and UI inputs. Test your reconstruction in Chromium with Playwright. Check errors, selection, movement, power changes, construction, production, combat and the end condition. Save screenshots of actual states. Fix failures you find, then repeat the affected checks. Record observed differences candidly.
5. **Prepare a reproducible demonstration.** Provide `/work/tools/demo.cjs`, using the installed Playwright, to drive a 60–120 second recording through the game's ordinary mouse and keyboard controls. Support `BASE_URL` (default `http://127.0.0.1:8000`) and `HEADLESS=0` for a headed Chromium on an existing Xvfb display, with a 1280x800 viewport. It should show camera motion, selection, movement, building, production and combat. Do not use a fake video, render-only scene or hidden state mutation to simulate successful mechanics. A visibly labeled optional accelerated demo speed is fine if it advances the actual simulation consistently.

## Time management

Work through one autonomous attempt. Aim for a complete small scenario within about two hours of agent work. Reserve substantial time for browser verification and the recording script. The runner has a four-hour hard ceiling; do not rely on follow-up prompts. Do not stop after writing only an analysis report or plan.

## Required artifacts

- `/work/game/`: a self-contained playable browser build, all dependencies and assets local.
- `/work/tools/`: extraction/conversion scripts and `demo.cjs`.
- `/work/REVERSE_NOTES.md`: engine findings with function names/addresses and REA tool evidence; asset provenance and conversions; distinguish recovered behavior, observations, deliberate simplifications and unknowns.
- `/work/screenshots/`: reference and browser captures, with a short comparison index.
- `/work/TEST-RESULTS.json`: what you actually tested, pass/fail, evidence filenames and known gaps; do not mark untested functionality passed.
- `/work/README.md`: exact local launch command, controls, what works, known limitations, and how to run the demo recorder.
- `/work/ATTRIBUTION.md`: Warzone 2100 and resource credits/license notices applicable to the selected material; avoid any claim of endorsement.

Finish with an honest short summary of the playable result, the strongest REA-derived findings, and material gaps. The supervising runner records API tokens, cached tokens, elapsed time and estimated cost independently; do not invent those numbers.
