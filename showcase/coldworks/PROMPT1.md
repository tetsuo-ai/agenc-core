Build an original first-person shooter mission that runs in Chrome: one intense mission of about a minute, made to look and feel as realistic as you can.

## The mission
- The player fights through an abandoned factory on the edge of a ruined city (you choose the exact place and the story): from an entry point, across the factory floor and a catwalk or a loading yard, to an extraction point.
- Six to ten enemies along the way. They take cover, peek, shoot back, react to hits and go down convincingly.
- The player can walk, sprint, crouch and jump, shoot, reload, and aim down sights with a zoomed optic. One main rifle with an optic and a sidearm.
- A short end screen with time, kills and accuracy. One key restarts.

## The look and feel
- A gritty, realistic modern-military look: muted, desaturated colors, cinematic color grading, dust and haze in light beams, wet concrete, rust, grime, film grain.
- Realistic lighting and shadows, physically based materials, detailed props and debris.
- The weapon: a first-person weapon model with sway, recoil, a reload animation, an aim-down-sights transition with zoom, muzzle flash, smoke, shell ejection, bullet impacts with sparks and dust, bullet holes, camera shake and hit markers.
- Audio: punchy gunshots that echo in the factory, reloads, footsteps, enemy shouts, wind and creaking metal.
- A minimal HUD: ammo, health, a crosshair that hides when aiming, hit and damage indicators.

## It must be your own game
Invent the name, the setting, the characters, the weapon model names, the HUD and every sound. Do not copy or imitate the names, logos, HUD, characters, maps, voice lines, music or art of Call of Duty, Counter-Strike or any other existing game.

## Tech and assets
- Choose the stack yourself. Build with npm into a static site in `/work/game/dist` that runs from any static file server.
- Assets must be made by your code or downloaded from CC0 sources (for example Poly Haven, ambientCG, Kenney, Quaternius). List every downloaded file with its source URL and license in `/work/game/ASSETS.md`. Never use assets from commercial games or with unclear licenses.

## Demo mode for video
`?demo=1` in the URL plays the whole mission by itself in first person, like a recorded playthrough by a skilled player: it moves along the route, aims down sights, fires, reloads and takes out every enemy, then shows the end screen. `?seed=N` makes it repeatable.

## Check your own work
Playwright with Chromium is installed (`/opt/ms-playwright`). Write `/work/game/verify.mjs` that serves `dist`, loads the game headless and fails on any console error, runs the demo mode to the end screen, and saves screenshots in `/work/game/shots/` of the start, moving through the factory, aiming down sights, firing, a reload, an enemy hit and the end screen. Look at those screenshots yourself and fix what looks wrong. Write `/work/game/DESIGN.md` and `/work/game/VERIFY.md`.

Work until the mission is complete and verified. Do not ask me questions; make every design decision yourself.
