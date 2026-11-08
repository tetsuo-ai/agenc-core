I played CORE BREACH and watched the attract mode for a full loop. It runs well. Please fix these points, keep everything else as it is, and keep verify.mjs passing.

1. **Names and art that are too close to DOOM.**
   - The pickups "stimpack", "medikit" and "megaarmor" use DOOM's item names. Rename them everywhere: identifiers, map things, sprite keys and messages. Use "patch cell" (+25 health), "trauma kit" (+50 health) and "heavy plating" (armor).
   - The health pickups are white boxes with a red cross. Redraw them as a green canister with a white pulse line, so there is no cross.
   - Then check every name, message and identifier in the game, and rename anything else that comes from DOOM.
   - Add a check to verify.mjs that fails if any DOOM term appears in /work/game.

2. **Attract mode, which I will record as the game's trailer.**
   - Show normal values on the HUD: health and armor at most 100. Keep the player alive another way, for example with reduced enemy damage in attract mode only.
   - Fire only while an enemy is in view. Right now the muzzle flash never stops.
   - Use all three weapons: the scatter cannon on Cutters up close, and the arc launcher on Drones and Sentinels, so its blast shows.
   - Press use only at doors, switches and the lift. "NOTHING TO USE" should never appear.
   - The loop must show a fight with each enemy type, a keycard door opening, the lift ride, the coolant area, the outdoor windows, and the reactor core shutdown with its completion screen.
   - Turn smoothly and look around a little, the way a player would.
   - The loop should last at least 75 seconds.

3. **One texture.** At a distance, the rock floor around the coolant looks like orange and black static. Make it calmer, with less fine noise and contrast, so it reads as rock.

When you are done, run verify.mjs and the attract mode for a full loop again. Take new screenshots and update REPORT.md with what changed.
