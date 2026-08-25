---
name: iot-builder
description: Build, flash, and debug IoT and embedded projects across Arduino, ESP32/ESP8266, Raspberry Pi, RP2040, Orange Pi, Radxa, and STM32 with measured hardware identification and electrical-safety checks.
when_to_use: Use when the user works with microcontrollers, single-board computers, sensors, GPIO/I2C/SPI/UART, firmware, flashing, serial debugging, embedded toolchains, SBC device trees, or wiring safety.
argument-hint: "[board or project goal]"
---

# IoT builder

Build, flash, and debug microcontroller and embedded-Linux projects end to
end: Arduino (Uno/Nano/Mega/R4), ESP32/ESP8266, Raspberry Pi (SBC and
Pico/RP2040), Orange Pi, Radxa, STM32, sensors, GPIO/I2C/SPI/UART, firmware,
and serial monitoring. Follow the orchestration loop below in order.

## 1. Identify the hardware — by measuring, not by recalling

Read references/boards/identify.md before this step. It is the longest reference file
here because this is where the most time gets lost.

Ask ONCE, briefly, what the board is — and if they don't know, **ask for
the listing they bought it from**. That second question is the one that
actually works: measured on a real session, a day of probing, flash dumps
and eFuse reads never named the board, and the AliExpress title named it in
ten minutes, which then led to the vendor wiki, the hardware revision, and
an official factory image. Nothing you can read over USB competes with a
page that states the product outright.

Expect "I don't know" to the first question — a board off a marketplace with
no silkscreen model is the normal case, not the edge case. It is not a dead
end, it is the start of the ladder in references/boards/identify.md.

What the obvious probes actually tell you:

```
ls /dev/ttyUSB* /dev/ttyACM*      # candidate ports; native-USB boards are ttyACM
lsusb                             # 0403:6001 FTDI, 10c4:ea60 CP210x, 1a86:7523 CH340, 303a:* Espressif native USB
arduino-cli board list            # matches USB ids against installed cores
pio device list                   # serial ports + descriptions
esptool -p /dev/ttyACM0 flash-id  # chip model, revision, flash part + size
```

Every one of those identifies the **chip**, not the **board**. On an
Espressif native-USB board the descriptors read Manufacturer "Espressif",
Product "USB JTAG/serial debug unit", Serial = the MAC — those strings live
in the chip ROM and are byte-identical across every board using that chip.
47 different boards in the local PlatformIO manifests share 303a:1001. Chip
identity is free and certain; board identity is neither.

That matters because what you actually need is almost never the board's
name — it is its pin map, its display controller, its LED pin. Separate the
two questions and only the second one has to be answered.

**Never write a pin number, FQBN, flash offset or display driver from
memory.** Quote it from a file you read: the installed core's
variants/<board>/pins_arduino.h, a board manifest, or vendor documentation.
Record where each fact came from — see references/boards/identify.md for the HARDWARE.md
convention. A recalled value presented as a measured one is the single most
expensive mistake in this workflow.

## 1b. Get a serial channel before you need it

The serial monitor is the only instrument you have, and steps 3-6 put it
last. Invert that when the board is uncertain: flash a minimal generic
build first (esp32-s3-devkitc-1 and friends run on nearly any board of that
chip), confirm build → flash → monitor works end to end, and only then use
that live channel to interrogate the hardware. A probe sketch that prints
esp_chip_info(), flash and PSRAM size, an I2C scan and a display-controller
ID turns "which board is this?" from a question into a measurement.
references/boards/identify.md has the sketch.

Getting the channel working first is also the cheapest possible test of the
whole toolchain, and it never depends on knowing the board.

## 2. Pick the toolchain

Choose in this preference order unless the user says otherwise:

1. **PlatformIO** — default for any compiled (C/C++, Arduino-framework)
   project and any multi-board work. One platformio.ini pins platform,
   board, framework, upload and monitor settings; trivial CI.
2. **Arduino CLI** — the user comes from Arduino IDE, wants official cores
   only, or needs a quick compile/upload against an FQBN with no project
   scaffold.
3. **ESP-IDF** — advanced ESP32 work: custom partition tables, BLE/ESP-NOW
   at the IDF level, menuconfig-tuned builds, production OTA.
4. **MicroPython** — rapid prototyping, teaching, sensor demos where a REPL
   beats a reflash cycle.
5. **SBC native / cross-compile** — Raspberry Pi, Orange Pi, Radxa run full
   Linux: there is no "firmware flashing" for app code. Build on-device or
   cross-compile (aarch64-linux-gnu-gcc), then deploy over SSH. GPIO access
   goes through libgpiod, not legacy sysfs or wiringPi.

Read the matching references/toolchains/*.md file under the skill base directory before
invoking a toolchain you have not already verified on this machine.

## 3. Work loop

Always: scaffold → generate code/config → build → flash → serial monitor →
debug, iterating until the observed behavior matches the goal.

PlatformIO example (ESP32 DevKit):

```
pio project init --board esp32dev          # or hand-write platformio.ini
pio run                                    # build
pio run -t upload --upload-port /dev/ttyUSB0
pio device monitor -b 115200
```

Arduino CLI example (Uno R3):

```
arduino-cli core update-index
arduino-cli core install arduino:avr
arduino-cli compile --fqbn arduino:avr:uno MySketch
arduino-cli upload -p /dev/ttyUSB0 --fqbn arduino:avr:uno MySketch
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=9600
```

Generate the real config, not a placeholder: platformio.ini with the exact
board id, the correct FQBN, ESP-IDF partition CSV, or the device-tree
overlay line for SBCs — whatever the board guide requires.

Back up before the FIRST write to a board you did not flash yourself. A
board that shipped with a factory demo has no other copy of it, and the
dump doubles as identification evidence (see references/boards/identify.md):

```
esptool -p /dev/ttyACM0 read-flash 0 ALL backup.bin
```

Flash operations are destructive: ALWAYS confirm with the user before any
flash erase or low-level write — esptool.py erase_flash / write_flash,
st-flash erase / write, STM32_Programmer_CLI -w, dfu-util -D, rkdeveloptool
wl (eMMC), dd to a removable device. Routine compile+upload of the firmware
you just built (pio run -t upload, arduino-cli upload, idf.py flash) is
fine without re-asking once the user asked you to build and flash; mass
erase, bootloader writes, and OS/eMMC imaging always need an explicit yes.

## 4. Electrical safety checklist — run ALWAYS before wiring instructions

Before telling the user to connect anything, state the relevant checks from
references/safety.md (read it first). The non-negotiables:

- Logic levels: ESP32/RP2040/RPi/Orange Pi/Radxa GPIO are 3.3V and NOT
  5V-tolerant. Classic AVR Arduinos are 5V. Mixing needs a level shifter.
- Per-pin current limits are tens of milliamps (AVR ~20 mA, ESP32 ~20 mA,
  RP2040 ~12 mA, RPi ~16 mA). Drive loads through a transistor/MOSFET.
- NEVER power motors, solenoids, or LED strips from the board's 5V/3V3 rail.
  Separate supply, common ground, flyback diode across every inductive load.
- I2C between different-voltage devices needs a bidirectional level shifter
  (BSS138 module), not a resistor divider.
- Power off before rewiring. Double-check VCC/GND polarity before powering.

## 5. Use the extracted reference files

The prompt you received is prefixed with "Base directory for this skill:
<dir>". Before acting on a specific board or toolchain, Read the matching
file there and Grep it for exact pin numbers, FQBNs, board IDs, and error
signatures:

- references/boards/identify.md — the ladder for a board nobody can name: what USB
  actually proves, the local board databases, mining the stock firmware,
  the probe sketch, and the HARDWARE.md provenance convention
- references/boards/esp32.md, references/boards/arduino.md,
  references/boards/raspberry-pi.md, references/boards/rp2040.md,
  references/boards/orange-pi.md, references/boards/radxa.md,
  references/boards/stm32.md
- references/toolchains/platformio.md, references/toolchains/arduino-cli.md,
  references/toolchains/esp-idf.md, references/toolchains/micropython.md
- references/workflows/when-stuck.md — READ THIS THE MOMENT ANYTHING FAILS: symptom →
  cause → next command, bounded-retry discipline, and how to verify on the
  hardware instead of on an exit code
- references/workflows/end-to-end.md — full recipe: I2C sensor + WiFi + OTA
- references/safety.md — the detailed electrical-safety reference

These files are the source of truth for commands. Quote real values from
them; do not invent FQBNs, board IDs, offsets, or pin numbers.

## 6. Serial debugging patterns

- Baud: 115200 is the modern default (ESP32 boot log, PlatformIO, ESP-IDF).
  9600 is the classic Arduino default. ESP8266 boot ROM logs at 74880 even
  when the app uses 115200. Wrong baud shows as garbage — switch before
  assuming a crash.
- Reset while monitoring: pulse EN/RST (ESP32), press the board reset
  button, or toggle DTR via the monitor. If output only appears at boot,
  the app crashed before setup() logging.
- Boot loops (repeating boot banner or "rst:0x..." on ESP32): brownout from
  an undersized supply or USB cable, a peripheral dragging a strapping pin
  (GPIO0/2/12/15), or a panic in early init. Read the reset reason line.
- Linux permissions: "Permission denied" opening /dev/ttyUSB* OR /dev/ttyACM*
  (native-USB boards land on ttyACM) means the PROCESS lacks the device's
  group — dialout on Debian/Ubuntu, uucp on Arch. Read the device, not the
  docs: ls -l /dev/ttyACM0 names the group that actually matters.
  The trap that wastes the most time here: supplementary groups are fixed at
  login. After sudo usermod -aG dialout $USER every already-running process
  keeps its old set, and "id $USER" reads /etc/group so it cheerfully lists
  dialout while nothing running has it. Believe neither until you compare:
    id -nG            # groups THIS process actually carries
    id -nG $USER      # what /etc/group claims
  If those differ, the fix is a re-login or reboot. Nothing else works, and
  no amount of retrying the failing command will change it.
  Never "fix" this by chmod 666 or chown on the device node. It makes a
  world-writable serial port, it does not survive a replug, and it is not
  the actual problem. When a re-login is genuinely impossible, add a udev
  rule scoped to that board's VID:PID granting a group the session already
  has (check id -nG), e.g. in /etc/udev/rules.d/99-board.rules:
    SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", ATTRS{idProduct}=="1001", GROUP="plugdev", MODE="0660"
  then: sudo udevadm control --reload-rules && sudo udevadm trigger
  Unrelated red herring while debugging this: apparmor="DENIED" lines for the
  lsusb profile reading /sys/.../uevent are stock Ubuntu confinement and have
  nothing to do with serial-port access.
- "side-effecting and interactive dispatch remain blocked" mid-session: a
  tool call died with an unknown outcome (commonly write_stdin against a
  serial monitor that went away) and the M4 gate is refusing every later
  build, upload and edit. This does NOT need a new session — do not tell the
  user to restart. Run `/resolve <call-id> <disposition> <evidence-ref>
  <evidence-sha256>`; use confirmed_no_effect when you can show the write
  never reached the device, confirmed_committed when it did.
- Port vanished after flash: native-USB boards (ESP32-S2/S3/C3, RP2040,
  Uno R4) re-enumerate; re-run pio device list / arduino-cli board list.
- Always end an iteration by reporting what the serial output actually
  showed, and what you will change next.

## 7. When something fails — non-negotiable

Read references/workflows/when-stuck.md the moment any step fails. Three rules that
belong here because they decide whether the session survives:

**A clean build and a verified flash prove nothing.** Firmware that compiles
and writes with "Hash of data verified" routinely does nothing on the
device. Never report "working" off a toolchain exit code. Get a signal FROM
the hardware — a serial heartbeat the firmware prints itself, a read-back,
or the human telling you what they see. Say which one you have, and say
"behaviour unconfirmed" when you have none.

**Never re-run a failed command unchanged.** Two attempts per hypothesis,
then change the hypothesis. Two dead hypotheses in the same area: stop and
report what you ruled out. Retrying variants of a denied command is how
whole sessions get burned — chmod, chown, setpriv and docker against one
permission error whose real fix was a re-login.

**Never end a turn announcing what you are about to do.** Either run the
commands, or state that you are stopping and why. "I'll now write the
firmware" followed by nothing is the most common way this work stalls, and
it looks identical to a crash from the outside.

## 8. Keep HARDWARE.md current — it is your memory

A project is a SET of things: a board plus sensors, a display, actuators,
a power path, sometimes several boards. Track them all in one HARDWARE.md
inventory (format in references/boards/identify.md), each entry tagged
`[measured: cmd]`, `[vendor: src]`, `[user-reported]` or `[ASSUMED]`.

Update it the MOMENT a fact changes state, before using that fact. Sessions
end: context fills, runs die, chats get restarted. That is survivable when
the inventory is on disk and costs the whole day's work when it lives only
in the conversation. Treat "what do we know about this hardware" as a file
you maintain, not something you hold in your head.

When several boards are involved, name them (board-main, board-sensor) and
use those names in platformio.ini env names, ports and log prefixes. "The
board" is ambiguous the moment there are two, and a command sent to the
wrong port fails silently.
