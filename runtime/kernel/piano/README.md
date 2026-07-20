# Piano App for Bare-metal x86_64 Kernel

This is a piano application built on top of the existing kernel infrastructure. It allows playing tones through the PC speaker using the Programmable Interval Timer (PIT) channel 2, with an on-screen keyboard display.

## How it works

- Keyboard keys A-S-D-F-G-H-J-K are mapped to C major scale notes (C4, D4, E4, F4, G4, A4, B4, C5)
- Notes start when a key is pressed and stop when released
- PIT channel 2 is configured to generate square-wave tones at specific frequencies
- The keyboard itself is displayed on-screen using the VGA text driver
- The pressed key (e.g., "A", "S", "D", etc.) is shown in real-time

## Build

From the kernel directory:

```bash
cd kernel
make
```

The compiled piano app will be available at `build/kernel.elf`. To integrate with the main kernel, you may need to modify the kernel Makefile to include it.

## Running

Run the whole kernel with the piano app in QEMU. The existing kernel's boot flow and shell will be replaced by the piano application.

```bash
cd kernel
make run
```

In QEMU, you can press keys A-S-D-F-G-H-J-K to play different notes.

## Files

- `pit.h` - PIT driver headers and constants
- `pit.c` - PIT initialization and tone generation
- `piano.asm` - Main piano application assembly code
- `piano.S` - Assembly startup with keyboard handling

## Keyboard Mapping

| Key | Note | Frequency |
|-----|------|-----------|
| A   | C4   | 261.63 Hz |
| S   | D4   | 293.66 Hz |
| D   | E4   | 329.63 Hz |
| F   | F4   | 349.23 Hz |
| G   | G4   | 392.00 Hz |
| H   | A4   | 440.00 Hz |
| J   | B4   | 493.88 Hz |
| K   | C5   | 523.25 Hz |