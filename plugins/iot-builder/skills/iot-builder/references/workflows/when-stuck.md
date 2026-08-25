# When it fails: symptom, cause, next command

A clean build and a verified flash prove NOTHING about behaviour. Firmware
that compiles and writes with "Hash of data verified" routinely does nothing
visible on the device. Treat toolchain success as the start of the test, not
the end of it.

## Verify on the hardware, never on the exit code

Before reporting anything as working, get a positive signal FROM the device:

1. A serial heartbeat the firmware prints itself — not a boot banner:
   `Serial.printf("alive %lu fill=0x%04X\n", millis(), color);` every second.
2. A read-back where possible: `esptool -p PORT read-flash 0x10000 0x100 v.bin`
   and compare with what you wrote.
3. For anything visual (display, LED), the only ground truth is a human
   looking at it. ASK: "what do you see — black, backlight glow, colour?"
   "Nothing" and "dark grey glow" are different diagnoses.

State plainly which of these you have. "Flashed successfully" is not
"working"; say "flashed and verified, device behaviour unconfirmed".

## Bounded retry — the rule that saves the session

- NEVER re-run a failed command unchanged. If it failed, the input must
  change or the hypothesis must change.
- Two attempts per hypothesis. Then switch hypothesis or stop.
- Two hypotheses dead in the same area => stop and report with evidence. Do
  not keep trying variants. A real session burned twenty minutes and its
  entire context retrying chmod/chown/setpriv/docker against one permission
  error whose fix was a re-login.
- Log what each attempt ruled OUT. That is the deliverable when you stop.

## Playbook

**Flash succeeds, display stays black — and the board is a module you did
not identify from a listing.** Suspect the CONTROLLER before the wiring. A
real case: an ST7789 driver on a board whose panel is a QSPI AMOLED
(SH8601). No pin, offset or backlight change can ever light that up, and
the assumption survived a full day and several sessions because it was
never restated as an assumption. Ask for the purchase listing, get the
vendor's factory image, flash it, and ask the user if the screen lit. That
settles panel + controller in minutes.

**Flash succeeds, display stays black.** Most common real failure. In order:
backlight/panel power pin not driven; wrong panel controller entirely
(ST7789 vs GC9A01 vs a QSPI AMOLED — a T-Display-S3 driver on an AMOLED
board gives exactly this); wrong bus (i80 parallel vs SPI vs QSPI); panel
geometry/offset wrong so pixels land off-glass. Do not iterate on colours or
offsets until you have proven the panel is powered and answering: read its
ID register first (see boards/identify.md), and drive the backlight pin
alone as a standalone test.

**Permission denied on /dev/ttyUSB* or /dev/ttyACM*.** Compare
`id -nG` with `id -nG $USER`. If they differ, the group was added after
this login and only a re-login fixes it. Never chmod/chown the node.

**"side-effecting and interactive dispatch remain blocked".** A tool call
died with an unknown outcome. Recoverable in place with
`/resolve <call-id> <disposition> <evidence-ref> <evidence-sha256>`. Do not
tell the user to restart the session.

**Tool blocked "while this workspace has protected Editor authority".** A
stale editor lease, often from a dead session. Work in a different directory
or release the editor buffer; it is not a permissions problem.

**Build succeeds, board boot-loops or is silent.** Read the reset reason
over serial before changing code. Brownout means power, not firmware. Wrong
flash mode (qio vs dio) and wrong PSRAM mode (quad vs octal) both produce a
board that flashes fine and never boots — `espefuse summary` is the
authority on which the chip actually has.

**Port disappears after flash.** Native-USB parts re-enumerate; wait and
re-list. If it never returns, the firmware crashed before USB init — hold
BOOT, tap RST, and flash a known-good minimal image.

**esptool reports a different chip than expected.** Believe esptool. The
board silkscreen and the seller's listing are both routinely wrong.

## When you genuinely cannot proceed

Report, in this order: what you measured (with the commands), what you
ruled out, what you believe is wrong, and the single thing you need from
the human. One question, answerable by looking or plugging something in.

Never end a turn by announcing what you are about to do. Either do it, or
say you are stopping and why. "I'll now write the firmware" followed by
nothing is the single most common way these sessions stall.
