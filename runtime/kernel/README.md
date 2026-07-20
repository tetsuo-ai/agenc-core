# Bare-metal x86_64 kernel

Minimal long-mode kernel with Multiboot2 boot, GDT/IDT, VGA text, PS/2 keyboard, and a tiny shell.

## Layout

```
kernel/
  boot/boot.S      Multiboot2 header, 32-bit entry, paging, long-mode jump
  boot/isr.S       Exception/IRQ stubs
  src/kernel.c     C entry point
  src/gdt.c        64-bit GDT + TSS
  src/idt.c        IDT + 8259 PIC remap
  src/vga.c        80x25 VGA text driver
  src/keyboard.c   PS/2 scancode set 1 -> ASCII ring buffer
  src/shell.c      Interactive shell
  src/string.c     freestanding string helpers
  include/         public headers
  linker.ld        link at 1 MiB
  grub.cfg         Multiboot2 GRUB config
  Makefile
```

## Requirements

- `gcc` targeting x86_64 (host freestanding works on Linux amd64), or `x86_64-elf-gcc` cross compiler
- GNU `binutils` (`as`, `ld`)
- `grub-mkrescue` + `xorriso` (for ISO)
- `qemu-system-x86_64` (to run)

Optional packages on Debian/Ubuntu:

```bash
sudo apt install build-essential nasm qemu-system-x86 grub-pc-bin grub-common xorriso
```

(`nasm` is not required — boot code is GAS / AT&T syntax.)

## Build

```bash
cd kernel
make            # -> build/kernel.elf
make iso        # -> build/kernel.iso  (needs grub-mkrescue)
```

## Run

```bash
make run          # build ISO (if needed) and boot in QEMU
```

QEMU needs Multiboot2 via GRUB — plain `qemu -kernel` cannot load this ELF64 image. The VGA window shows the shell; type commands there.

Host packages for ISO + QEMU (Debian/Ubuntu):

```bash
sudo apt install build-essential qemu-system-x86 grub-pc-bin xorriso mtools
```

## Shell commands

| Command   | Description                          |
|-----------|--------------------------------------|
| `help`    | list commands                        |
| `clear`   | clear VGA screen                     |
| `echo …`  | print arguments                      |
| `info`    | kernel addresses / mode              |
| `peek hex`| read byte at identity-mapped address |
| `reboot`  | pulse keyboard-controller reset      |
| `halt`    | CLI + HLT loop                       |

## Boot flow

1. GRUB loads ELF via Multiboot2, jumps to `_start` in 32-bit protected mode.
2. `boot.S` builds identity-mapped 2 MiB pages for the low 1 GiB, enables PAE + EFER.LME + paging.
3. Far jump into 64-bit CS → `kernel_main`.
4. C code installs a fuller GDT/TSS, IDT, remaps the PIC, enables keyboard IRQ1, and drops into the shell.

## Notes

- Identity map only covers 0–1 GiB (512 × 2 MiB pages).
- No heap, no SMP, no APIC — 8259 PIC only.
- Keyboard is US QWERTY set-1; extended keys ignored.
