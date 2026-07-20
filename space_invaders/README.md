# Space Invaders (SDL2)

Classic Space Invaders-style arcade game written in C11 with SDL2.

## Features

- 11×5 alien formation with accelerating march
- Player ship, shields, UFO bonus saucer
- Waves that get faster over time
- Particle explosions and simple square-wave SFX
- Menu / pause / game-over / wave-clear states
- 60 FPS fixed timestep

## Controls

| Key | Action |
|-----|--------|
| ← → or A D | Move |
| Space | Fire |
| P | Pause / resume |
| Enter | Start / retry |
| Esc | Quit |

## Dependencies

- GCC (C11)
- Make
- SDL2 development libraries
- pkg-config

### Install deps

```bash
# Debian / Ubuntu
sudo apt install build-essential libsdl2-dev pkg-config

# Fedora
sudo dnf install gcc make SDL2-devel pkgconf-pkg-config

# Arch
sudo pacman -S base-devel sdl2
```

## Build & run

```bash
cd space_invaders
make
./space_invaders
# or
make run
```

## Project layout

```
space_invaders/
├── Makefile
├── README.md
├── include/game.h
└── src/
    ├── main.c
    ├── game.c       # simulation, collision, input
    ├── render.c     # drawing + bitmap font
    ├── particles.c
    └── audio.c      # callback square-wave beeps
```

## Scoring

| Target | Points |
|--------|--------|
| Squid (top row) | 30 |
| Crab | 20 |
| Octopus | 10 |
| UFO | 50 / 100 / 150 / 300 |
