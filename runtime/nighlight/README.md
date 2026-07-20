# NIGHLIGHT

Top-down terminal horror. You are trapped in a pitch-black house with a dying flashlight and something that hunts by sight and sound. Collect keys, unlock the exit, escape.

## Why terminal?

This machine has SDL2/ncurses **runtime** libraries but no development headers (`SDL.h`, `ncurses.h`, `raylib.h` missing). NIGHLIGHT uses **raw ANSI escape codes** and POSIX termios only — zero extra dependencies beyond `gcc` and libc.

## Build

```bash
cd nighlight
make
```

Binary: `./nighlight`

```bash
make smoke   # scripted non-interactive smoke test
make clean
```

## Run

```bash
./nighlight
./nighlight --smoke   # headless/scripted path for CI
```

Requires a terminal with truecolor (`38;2;r;g;b`) for best look; still playable without.

## Controls

| Key | Action |
|-----|--------|
| `W` `A` `S` `D` or arrows | Move |
| `F` | Toggle flashlight |
| `.` or `Space` | Wait a turn |
| `R` | Restart run |
| `Q` | Quit |
| `Enter` / `Space` | Start from title |

## Gameplay

- **Flashlight / FoV** — Recursive shadowcasting; you only see a small radius. Battery drains while the light is on and **flickers** when low.
- **Batteries (`b`)** — Pick up to restore power.
- **Keys (`k`)** — Collect all keys to unlock the exit (`E`). Keys also open locked doors (`+`).
- **Stalker (`&`)** — Wanders the house. Line-of-sight + proximity hearing. Chases when it sees or hears you. Light makes you easier to spot; darkness hides you but costs **sanity**.
- **Sanity** — Drops in the dark and near the stalker. Low sanity causes screen shake and color pulses. Hitting 0 is a loss.
- **Win** — Step on the unlocked exit. **Lose** — Stalker catches you, or sanity breaks.

## Layout

| File | Role |
|------|------|
| `main.c` | Entry, loop, smoke mode |
| `game.c` | State, battery/sanity, tick |
| `map.c` | Procedural rooms/corridors |
| `fov.c` | Shadowcasting visibility |
| `entity.c` | Player, stalker AI, LOS |
| `render.c` | ANSI renderer |
| `input.c` | Raw terminal input |
| `util.c` | RNG / clamps |
| `nighlight.h` | Shared types |

## License

MIT-style: use and modify freely.
