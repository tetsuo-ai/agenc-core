/**
 * Bundled `iot-builder` skill: turns the agent into a native IoT/embedded
 * project builder. Covers board detection, toolchain selection (PlatformIO,
 * Arduino CLI, ESP-IDF, MicroPython, SBC cross-compilation), the
 * scaffold → build → flash → monitor → debug loop, and a mandatory
 * electrical-safety checklist. Ships dense per-board and per-toolchain
 * reference files via the `files` contract so the model can Read/Grep them
 * on demand. Pure data — registered from `bundledSkills.ts` so there is no
 * circular import back into this module.
 *
 * @module
 */

import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import type { BundledSkillDefinition } from "../bundledSkills.js";

const IOT_BUILDER_GUIDE = `# IoT builder

Build, flash, and debug microcontroller and embedded-Linux projects end to
end: Arduino (Uno/Nano/Mega/R4), ESP32/ESP8266, Raspberry Pi (SBC and
Pico/RP2040), Orange Pi, Radxa, STM32, sensors, GPIO/I2C/SPI/UART, firmware,
and serial monitoring. Follow the orchestration loop below in order.

## 1. Identify the hardware — by measuring, not by recalling

Read boards/identify.md before this step. It is the longest reference file
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
end, it is the start of the ladder in identify.md.

What the obvious probes actually tell you:

\`\`\`
ls /dev/ttyUSB* /dev/ttyACM*      # candidate ports; native-USB boards are ttyACM
lsusb                             # 0403:6001 FTDI, 10c4:ea60 CP210x, 1a86:7523 CH340, 303a:* Espressif native USB
arduino-cli board list            # matches USB ids against installed cores
pio device list                   # serial ports + descriptions
esptool -p /dev/ttyACM0 flash-id  # chip model, revision, flash part + size
\`\`\`

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
Record where each fact came from — see identify.md for the HARDWARE.md
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
identify.md has the sketch.

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

Read the matching toolchains/*.md file under the skill base directory before
invoking a toolchain you have not already verified on this machine.

## 3. Work loop

Always: scaffold → generate code/config → build → flash → serial monitor →
debug, iterating until the observed behavior matches the goal.

PlatformIO example (ESP32 DevKit):

\`\`\`
pio project init --board esp32dev          # or hand-write platformio.ini
pio run                                    # build
pio run -t upload --upload-port /dev/ttyUSB0
pio device monitor -b 115200
\`\`\`

Arduino CLI example (Uno R3):

\`\`\`
arduino-cli core update-index
arduino-cli core install arduino:avr
arduino-cli compile --fqbn arduino:avr:uno MySketch
arduino-cli upload -p /dev/ttyUSB0 --fqbn arduino:avr:uno MySketch
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=9600
\`\`\`

Generate the real config, not a placeholder: platformio.ini with the exact
board id, the correct FQBN, ESP-IDF partition CSV, or the device-tree
overlay line for SBCs — whatever the board guide requires.

Back up before the FIRST write to a board you did not flash yourself. A
board that shipped with a factory demo has no other copy of it, and the
dump doubles as identification evidence (see boards/identify.md):

\`\`\`
esptool -p /dev/ttyACM0 read-flash 0 ALL backup.bin
\`\`\`

Flash operations are destructive: ALWAYS confirm with the user before any
flash erase or low-level write — esptool.py erase_flash / write_flash,
st-flash erase / write, STM32_Programmer_CLI -w, dfu-util -D, rkdeveloptool
wl (eMMC), dd to a removable device. Routine compile+upload of the firmware
you just built (pio run -t upload, arduino-cli upload, idf.py flash) is
fine without re-asking once the user asked you to build and flash; mass
erase, bootloader writes, and OS/eMMC imaging always need an explicit yes.

## 4. Electrical safety checklist — run ALWAYS before wiring instructions

Before telling the user to connect anything, state the relevant checks from
safety.md (read it first). The non-negotiables:

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

- boards/identify.md — the ladder for a board nobody can name: what USB
  actually proves, the local board databases, mining the stock firmware,
  the probe sketch, and the HARDWARE.md provenance convention
- boards/esp32.md, boards/arduino.md, boards/raspberry-pi.md,
  boards/rp2040.md, boards/orange-pi.md, boards/radxa.md, boards/stm32.md
- toolchains/platformio.md, toolchains/arduino-cli.md, toolchains/esp-idf.md,
  toolchains/micropython.md
- workflows/when-stuck.md — READ THIS THE MOMENT ANYTHING FAILS: symptom →
  cause → next command, bounded-retry discipline, and how to verify on the
  hardware instead of on an exit code
- workflows/end-to-end.md — full recipe: I2C sensor + WiFi + OTA
- safety.md — the detailed electrical-safety reference

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
  user to restart. Run \`/resolve <call-id> <disposition> <evidence-ref>
  <evidence-sha256>\`; use confirmed_no_effect when you can show the write
  never reached the device, confirmed_committed when it did.
- Port vanished after flash: native-USB boards (ESP32-S2/S3/C3, RP2040,
  Uno R4) re-enumerate; re-run pio device list / arduino-cli board list.
- Always end an iteration by reporting what the serial output actually
  showed, and what you will change next.

## 7. When something fails — non-negotiable

Read workflows/when-stuck.md the moment any step fails. Three rules that
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
inventory (format in boards/identify.md), each entry tagged
\`[measured: cmd]\`, \`[vendor: src]\`, \`[user-reported]\` or \`[ASSUMED]\`.

Update it the MOMENT a fact changes state, before using that fact. Sessions
end: context fills, runs die, chats get restarted. That is survivable when
the inventory is on disk and costs the whole day's work when it lives only
in the conversation. Treat "what do we know about this hardware" as a file
you maintain, not something you hold in your head.

When several boards are involved, name them (board-main, board-sensor) and
use those names in platformio.ini env names, ports and log prefixes. "The
board" is ambiguous the moment there are two, and a command sent to the
wrong port fails silently.`;

const BOARD_IDENTIFY = `# Identifying an unknown board

The user usually cannot name their board, and the ecosystem's own advice
("count the pins, read the silkscreen, pick a generic profile") is where
this normally stops. You can do better, because identification is a search
over a finite set with cheap experiments — not a recall problem.

Work the ladder in order. Stop as soon as the remaining ambiguity no longer
affects the task: a WiFi or I2C-sensor project needs nothing board-specific,
so a generic profile for the right chip is a complete answer.

## Rung 0 — ask for the purchase listing FIRST

Before any probe. If the user bought the board, they have the order page,
and it names the product. This is the single highest-value question in the
whole ladder and it costs one line:

> "Do you still have the listing you bought it from? Paste the title."

Measured against everything below it: a full day of probing, flash dumps,
eFuse reads and firmware string-mining failed to name a board. The listing
title named it in ten minutes — and from the name came the vendor wiki, TWO
hardware revisions with different display controllers, and official factory
images. Nothing on the wire can tell you what a seller's page states
outright.

Ask for it even when probes are already running. It costs nothing and it is
the only source that can be authoritative about the PCB.

### Then use the vendor's own images

Once the model is known, check the vendor's GitHub/wiki for a factory or
recovery image. Two payoffs:

- **Restore.** A board bricked by wrong-driver experiments comes straight
  back: \`esptool -p PORT write-flash 0x0 <factory>.bin\` for a full-flash
  dump. Verified on a Waveshare AMOLED board — 16 MB written, hash
  verified, display alive again after a replug.
- **Disambiguate revisions without opening anything.** Vendors ship one
  image per hardware revision. Fingerprint them:

\`\`\`
strings -n 5 vendor-v1.bin | grep -oiE 'sh8601|co5300|ft3168|cst820'
strings -n 5 vendor-v2.bin | grep -oiE 'sh8601|co5300|ft3168|cst820'
\`\`\`

That printed SH8601 for V1 and CO5300 for V2 of the same product. Flashing
one and asking the user whether the screen lit is then a two-option test
with an immediate, unambiguous answer — far cheaper than deducing the panel
from the outside.

## Rung 0b — what the host already knows (free, no connection)

\`\`\`
ls -l /dev/serial/by-id/                   # symlinks carry vendor strings
lsusb -v -d <vid>:<pid> 2>/dev/null | head -40
cat /sys/bus/usb/devices/*/{idVendor,idProduct,manufacturer,product,serial}
journalctl -k --since "-10 min" | grep -i usb   # enumeration, re-plug events
\`\`\`

Read the strings, but know their worth. A board behind a UART bridge
(CP210x/CH340/FTDI) sometimes carries a real vendor string — occasionally
decisive. A board using the ESP32's native USB does not: Manufacturer
"Espressif", Product "USB JTAG/serial debug unit" and Serial = MAC come from
chip ROM and are identical across every board built on that chip. Do not
over-read them.

## Rung 1 — chip truth (read-only, always works)

\`\`\`
esptool -p /dev/ttyACM0 flash-id     # chip model + revision, flash mfr/part/size
esptool -p /dev/ttyACM0 read-mac
espefuse -p /dev/ttyACM0 summary     # factory MAC, package, burned flash/PSRAM config
\`\`\`

espefuse is the authority on whether PSRAM is quad or octal, which is the
setting that most often produces a board that builds fine and never boots.
This rung is deterministic: whatever it says is true.

## Rung 2 — enumerate candidates from local board databases

Nobody queries these, and they are already on disk — hundreds of
machine-readable board definitions, offline:

\`\`\`
ls ~/.platformio/platforms/*/boards/*.json | wc -l
grep -l '"0x303A"' ~/.platformio/platforms/*/boards/*.json      # by USB hwid
grep -l 'ESP32_S3R8N16' ~/.platformio/platforms/*/boards/*.json # by memory config
arduino-cli board listall
arduino-cli board details --fqbn <fqbn>
\`\`\`

Each manifest carries hwids, mcu, f_cpu, flash_mode, memory_type and the
partition scheme. Filtering by hwid plus the memory configuration from rung 1
turns "some ESP32-S3" into a reviewable list.

Two honest limits. Filtering 303a:1001 leaves ~47 candidates, so this narrows
but does not resolve. And the manifests describe the **chip configuration,
not the peripherals** — the LilyGO T-Display-S3 manifest contains its name,
mcu and partition table and says nothing whatsoever about the ST7789 panel
that is the entire reason to buy that board.

The real pin map lives in the installed core, not the manifest:

\`\`\`
find ~/.platformio/packages ~/.arduino15 -path '*variants*' -name pins_arduino.h | head
\`\`\`

That file is the truth that gets compiled. Quote pin numbers from it, with
the path.

## Rung 3 — interrogate the existing firmware (before you overwrite it)

A board that arrived with a factory demo is carrying a description of
itself. Back it up first — this is also your only restore point:

\`\`\`
esptool -p /dev/ttyACM0 read-flash 0 ALL backup.bin   # ALL autodetects size
\`\`\`

Then mine it. Driver and framework strings survive in the binary:

\`\`\`
strings -n 5 backup.bin | grep -iE 'st77|ili9|ssd13|gc9a|lvgl|tft_espi|lilygo|t-display|m5|waveshare|heltec'
strings -n 5 backup.bin | grep -iE 'esp-idf|loopTask|app_main'   # IDF vs Arduino core
\`\`\`

Recovered from a real unknown board this way: chip, flash part number,
that it ran the Arduino core, and its partition layout. Framework and
display driver are exactly the facts the manifests lack.

## Rung 4 — measure with a probe sketch

Flash a disposable diagnostic and read the answers over serial. This is the
rung that works when the board is in no database at all.

\`\`\`cpp
#include <Wire.h>
#include "esp_chip_info.h"
void setup() {
  Serial.begin(115200);
  while (!Serial) {}
  delay(2000);                       // native USB re-enumerates after reset
  esp_chip_info_t info; esp_chip_info(&info);
  Serial.printf("model=%d rev=%d cores=%d features=0x%x\\n",
                info.model, info.revision, info.cores, info.features);
  Serial.printf("flash=%u psram=%u mac=%llx\\n",
                ESP.getFlashChipSize(), ESP.getPsramSize(), ESP.getEfuseMac());
  // Sweep plausible I2C pin pairs; print every address that answers.
  const int pairs[][2] = {{21,22},{8,9},{6,7},{17,18},{43,44}};
  for (auto &p : pairs) {
    Wire.begin(p[0], p[1]);
    for (uint8_t a = 1; a < 127; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0)
        Serial.printf("i2c sda=%d scl=%d addr=0x%02x\\n", p[0], p[1], a);
    }
  }
}
void loop() {}
\`\`\`

Common I2C answers: 0x3C/0x3D SSD1306 or SH1106 OLED, 0x27/0x3F PCF8574 LCD
backpack, 0x68 MPU6050 or DS3231, 0x76/0x77 BMP/BME280, 0x5A touch.

For an SPI panel, read its ID **before** initialising any driver: RDDID
(0x04), then 0xD3 and 0xDA/0xDB/0xDC. Different controllers answer
differently, which distinguishes ST7789 from ILI9341 without guessing.
Candidate CS/DC/SCK/MOSI sets come from rung 2 — a finite sweep, not a shot
in the dark.

## Rung 5 — use the human as an observer, not an oracle

They cannot name the board. They can see it. Ask questions that eliminate
candidates:

- Does it have a screen? Roughly what size and shape?
- How many buttons besides reset, and where?
- USB-C or micro-USB, and on which end?
- Anything printed near the module or on the underside?
- I just toggled a pin — did an LED light up?

That last one turns a pin sweep into a binary search. One question per round,
tied to a specific hypothesis.

## Rung 6 — HARDWARE.md: the inventory, and your memory across sessions

A project is almost never one board. It is a board plus sensors, a display,
actuators, a power path — and sometimes several boards talking to each
other. Identification applies to every one of them, and each is at a
different level of certainty at any moment. Keep them all in one
HARDWARE.md, as an INVENTORY, not a single spec.

**Write it as you learn, not at the end.** This file is also the answer to
losing a session: context windows fill, runs die, chats get restarted. A
session that ends with HARDWARE.md current costs nothing to resume — the
next one reads facts instead of re-deriving them. A session that kept
everything in the conversation loses all of it. Update the file the moment
a fact changes state, before doing anything else with it.

Every entry carries provenance, and only four tags are allowed:
\`[measured: <command>]\`, \`[vendor: <source>]\`, \`[user-reported]\`,
\`[ASSUMED]\`. Anything ASSUMED or unverified must be restated as an
assumption every time you report on it. Never silently promote it.

\`\`\`markdown
# Hardware inventory

## Targets
### board-main — ESP32-S3-Touch-AMOLED-1.8 rev V1
- Port: /dev/ttyACM0            [measured: /dev/serial/by-id]
- Chip: ESP32-S3 rev v0.2, 16 MB flash, 8 MB octal PSRAM
                                [measured: esptool flash-id + build both ways]
- Identified by: AliExpress listing title   [user-reported]
- Display: SH8601 QSPI AMOLED   [confirmed: vendor V1 factory image lit it]
- Touch: FT3168 I2C             [vendor: waveshare wiki, rev V1]
- Firmware now: vendor factory image  [measured: write-flash 0x0, hash ok]

### board-sensor — Arduino Nano (second target, not yet connected)
- Role: battery-powered sensor node, talks to board-main over ESP-NOW
- Port: not connected           [pending]

## Components on board-main
| Part | Bus / address | Pins | Status |
| --- | --- | --- | --- |
| QMI8658 IMU | I2C | ? | [vendor] not probed |
| ES8311 audio | I2C | ? | [measured: strings in factory image] |
| AXP2101 PMIC | I2C | ? | [measured: strings in factory image] |
| PCF85063 RTC | I2C | ? | [vendor] UNVERIFIED |

## External components
| Part | Interface | Wiring | Status |
| --- | --- | --- | --- |
| BME280 | I2C 0x76 | SDA=8 SCL=9, 3.3V | [measured: I2C scan] |
| Relay | GPIO 12 | via 2N2222 + flyback | [ASSUMED] not built yet |

## Open questions
- QMI8658 I2C address unconfirmed — needs a bus scan
- Whether the RTC shares the touch bus
\`\`\`

With several boards, give each a stable name (board-main, board-sensor) and
use it everywhere: platformio.ini env names, serial ports, log prefixes. "The
board" stops meaning anything the moment there are two, and a command aimed
at the wrong port is silent and confusing.

## Where to look, in order of reliability

1. variants/<board>/pins_arduino.h in the installed core — the truth that
   compiles
2. Local board manifests (PlatformIO JSON, arduino-cli board details)
3. Vendor repository and datasheet for the specific board
4. Espressif/vendor docs for the chip (authoritative for the chip, silent
   about the board)
5. Never your own memory for pin numbers, offsets or FQBNs
`;

const BOARD_ESP32 = `# ESP32 family

## Variants and how to tell them apart

| Chip | Key traits | PlatformIO board | Arduino FQBN |
| --- | --- | --- | --- |
| ESP32 (classic, e.g. DevKit V1 "ESP32-WROOM-32") | dual-core 240 MHz, WiFi + BT classic/BLE, ADC1+ADC2, DAC | esp32dev | esp32:esp32:esp32 |
| ESP32-S2 | single-core, native USB, no Bluetooth, no classic DAC issues | esp32-s2-saola-1 | esp32:esp32:esp32s2 |
| ESP32-S3 | dual-core, native USB, BLE 5, AI vector instructions | esp32-s3-devkitc-1 | esp32:esp32:esp32s3 |
| ESP32-C3 | single-core RISC-V, BLE 5, native USB on some devkits | esp32-c3-devkitm-1 | esp32:esp32:esp32c3 |
| ESP32-C6 | RISC-V, WiFi 6, BLE 5, 802.15.4 (Thread/Zigbee) | esp32-c6-devkitc-1 | esp32:esp32:esp32c6 |
| ESP32-H2 | RISC-V, BLE 5 + 802.15.4, NO WiFi | esp32-h2-devkitm-1 | esp32:esp32:esp32h2 |
| ESP8266 (NodeMCU, Wemos D1 mini) | legacy 80/160 MHz, WiFi only, 3.3V, 4 MB typical | nodemcuv2 / d1_mini | esp8266:esp8266:nodemcuv2 / esp8266:esp8266:d1_mini |

Identify silicon on a connected board:

\`\`\`
esptool.py --port /dev/ttyUSB0 flash_id     # or: esptool.py flash_id --port ...
\`\`\`

Prints "Detecting chip type... ESP32-S3" plus flash size and MAC. (esptool
v5 accepts dashed aliases: flash-id, write-flash, read-flash, erase-flash;
the underscore forms still work.)

## Strapping pins — the #1 cause of "won't flash / won't boot"

Classic ESP32 boot strapping (sampled at reset):

| Pin | Boot meaning | Practical rule |
| --- | --- | --- |
| GPIO0 | LOW at reset = UART download (flash) mode | Flash button pulls it low. Do not hard-tie a peripheral that holds it low, or the chip never boots normally. |
| GPIO2 | must be LOW or floating for download boot | Keep free or use carefully; on-board LED on many devkits. |
| GPIO12 (MTDI) | HIGH at reset selects 1.8V flash -> 3.3V flash chip fails to boot | Avoid as an input with a pull-up at boot. |
| GPIO15 (MTDO) | HIGH enables boot log on U0TXD | Silences boot log if pulled low; fine otherwise. |

Input-only pins on classic ESP32: GPIO34, 35, 36, 39 (no internal pull-ups).
GPIO6–GPIO11 connect to internal SPI flash — never use them.

ESP32-S2/S3 use GPIO0 for boot mode plus GPIO45/46 as strapping pins
(GPIO46 must be low for download boot on S3).

## ADC2 is unusable while WiFi is on

On classic ESP32 (and S2/S3 with caveats), the ADC2 block is shared with
the WiFi radio: any analogRead on ADC2 channels (GPIO0, 2, 4, 12, 13, 14,
15, 25, 26, 27 — ADC2_CH0..CH9) returns garbage or fails once WiFi starts.
Use ADC1 pins (GPIO32–39 on classic; note 32/33 are ADC1, NOT ADC2) for
analog reads in WiFi projects. Bonus trap: several ADC2 pins (GPIO0/2/12/15)
are also strapping pins — yet another reason to prefer ADC1.

## Flashing

esptool directly (Arduino/PlatformIO images):

\`\`\`
esptool.py --port /dev/ttyUSB0 --baud 460800 write_flash \\
  0x1000 bootloader.bin 0x8000 partitions.bin 0x10000 firmware.bin
\`\`\`

Offsets: the partition table is at 0x8000 and the app at 0x10000 on every
chip, but the BOOTLOADER offset is chip-specific:

| Chip | Bootloader offset |
| --- | --- |
| ESP32, ESP32-S2 | 0x1000 |
| ESP32-S3, C2, C3, C6, H2 | 0x0 |
| ESP32-P4 | 0x2000 |

S2 is the trap: it is a newer chip but still uses 0x1000, like the classic
ESP32. Flashing a bootloader to the wrong offset gives a chip that never
boots. Never type these from memory — the build output's
flasher_args.json (ESP-IDF) or the upload command PlatformIO/Arduino
prints always lists the exact offsets for the target you just built.

Erase when a board behaves erratically after many reflashes:

\`\`\`
esptool.py --port /dev/ttyUSB0 erase_flash
\`\`\`

Flash modes: qio (fastest, 4 data lines) is the default for WROOM modules;
dio for modules where flash pins are broken out; if a board boots only in
dio, forcing qio crashes at boot ("flash read err, 1000").

## S3 traps verified on hardware (ESP32-S3R8, 16 MB flash, native USB-JTAG)

Each of these cost a wrong conclusion before it was measured. Every one is
reproducible on a stock S3 devkit.

**Toggling DTR/RTS on native USB-JTAG does NOT reset the board — it puts it
in download mode.** A reader that pulses RTS to "reset before reading" then
sees total silence and looks exactly like firmware that crashed on boot.
Twice this produced a confident, wrong diagnosis. Open the port with
dtr=False, rts=False and leave the lines alone; the board already reset
after upload. To force a run: \`esptool -p PORT run\`.

**eFuse FLASH_TYPE describes the FLASH, not the PSRAM.** \`espefuse summary\`
on an S3R8 reports \`FLASH_TYPE = 4 data lines (quad)\` while the in-package
PSRAM is octal. PSRAM_CAP/PSRAM_VENDOR give capacity and vendor, neither
says quad vs octal. Reading FLASH_TYPE as the PSRAM mode leads straight to
a build that will not boot.

**The only reliable PSRAM test is to build both ways and look:**

\`\`\`ini
board_build.arduino.memory_type = qio_opi   ; octal
board_build.psram = opi
\`\`\`

then print \`ESP.getPsramSize()\` and \`psramFound()\`. Measured on an S3R8:
opi gives 8386295 bytes / YES; quad (qio_qspi + psram=enabled) gives 0 / NO
with an otherwise identical build. Silent boot after changing memory_type is
the classic symptom — but confirm it with a correct serial read first (see
the DTR/RTS trap above).

**GPIO 22-25 do not exist on the S3.** Including one in a pin sweep aborts
the I2C driver with \`i2c_set_pin(875): scl gpio number error\` and takes the
rest of the sweep with it. GPIO 26-32 are the flash bus; 33-37 are consumed
by octal PSRAM on an S3R8. Driving any of them hangs the chip.

**\`read-flash 0 ALL\` stalls over native USB-JTAG.** A full 16 MB read dies
around the 1 MB mark ("Packet content transfer stopped"), at the same point
regardless of --baud. Short reads on both sides of the stall succeed, so the
flash is fine — it is a sustained-transfer limit. Read in chunks well under
1 MB and concatenate.

**Check whether a backup is worth taking before taking it.** \`strings\` on
the first chunk tells you in seconds whether the flash still holds the
factory image or something you flashed an hour ago.

## USB-serial adapters

- WROOM devkits: on-board CP2102/CH340 -> /dev/ttyUSB0, works out of the box.
- ESP32-S2/S3/C3 with native USB: /dev/ttyACM0; the port disappears during
  reset and re-enumerates. If flashing fails with "wrong boot mode", hold
  BOOT, tap RST, release BOOT, retry.

## Common errors and fixes

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Failed to connect to ESP32: Timed out waiting for packet header" | not in download mode | hold BOOT while esptool connects, tap RST |
| Brownout detector was triggered | weak USB port/cable, WiFi TX spikes | short fat cable, powered hub, add 10 uF+ on 3V3 |
| rst:0x1 (POWERON_RESET) loop, boot banner repeats | strapping pin held wrong, or panic in early init | check GPIO0/2/12/15 attachments, read the panic line |
| Guru Meditation Error / StoreProhibited | null/bad pointer, stack overflow | decode backtrace: pio run -t monitor with monitor_filters = esp32_exception_decoder |
| Flash write err / wrong boot mode after OTA | corrupted partition or wrong offset | erase_flash, reflash at documented offsets |
| ADC reads frozen at 0/4095 when WiFi on | ADC2 pin | move to ADC1 pin |
`;

const BOARD_ARDUINO = `# Arduino boards (AVR + Renesas R4)

## Boards, cores, FQBNs

Install the core first: arduino-cli core update-index && arduino-cli core install <core>.

| Board | Core | FQBN | Notes |
| --- | --- | --- | --- |
| Uno R3 | arduino:avr | arduino:avr:uno | 5V logic, ATmega328P, 2 KB SRAM |
| Nano (ATmega328P, new bootloader) | arduino:avr | arduino:avr:nano | old clones need arduino:avr:nano:cpu=atmega328old |
| Mega 2560 | arduino:avr | arduino:avr:mega | 54 GPIO, 4 UARTs, 5V logic |
| Pro Mini 5V/16 MHz | arduino:avr | arduino:avr:pro:cpu=16MHzatmega328 | no USB; needs FTDI adapter, DTR to reset |
| Pro Mini 3.3V/8 MHz | arduino:avr | arduino:avr:pro:cpu=8MHzatmega328 | 3.3V logic |
| Uno R4 Minima | arduino:renesas_uno | arduino:renesas_uno:minima | 3.3V-tolerant-ish but officially 5V logic, native USB |
| Uno R4 WiFi | arduino:renesas_uno | arduino:renesas_uno:unor4wifi | ESP32-S3 co-processor for WiFi |
| Leonardo / Micro | arduino:avr | arduino:avr:leonardo | native USB, disappears on reset |

Discover everything installed cores support:

\`\`\`
arduino-cli board listall                 # all known boards
arduino-cli board listall uno             # filter
arduino-cli board list                    # what is actually plugged in
\`\`\`

## Compile / upload / monitor

\`\`\`
arduino-cli compile --fqbn arduino:avr:uno MySketch
arduino-cli upload -p /dev/ttyUSB0 --fqbn arduino:avr:uno MySketch
arduino-cli compile --upload -p /dev/ttyUSB0 --fqbn arduino:avr:uno MySketch   # one shot
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=9600                           # Ctrl-C to exit
\`\`\`

Monitor defaults to 9600 baud; always pass -c baudrate=... matching the
sketch's Serial.begin(...).

## Libraries

\`\`\`
arduino-cli lib search DHT
arduino-cli lib install "DHT sensor library"
arduino-cli lib install "Adafruit SSD1306"@2.5.9
\`\`\`

Sketches with missing headers fail with "No such file or directory" — the
fix is lib install, not editing include paths.

## AVR specifics that bite

- 5V logic on Uno/Nano/Mega. ESP32/RPi sensors at 3.3V into AVR inputs work
  (3.3V reads as HIGH) but AVR 5V outputs into 3.3V devices need a divider
  or shifter.
- 20 mA per GPIO recommended (40 mA absolute max), 200 mA total through VCC
  pins. Drive relays/motors via transistor.
- 2 KB SRAM (Uno): String class fragmentation and large Serial.print of
  string literals eat it — use the F() macro: Serial.println(F("..."));
  check free RAM with freeMemory() from the MemoryFree lib when a sketch
  resets mysteriously.
- Watchdog: avr/wdt.h wdt_enable(WDTO_2S) + wdt_reset() in loop for
  unattended installs.
- Pro Mini upload: if "not in sync" errors, press reset just before upload
  starts (no auto-reset on some FTDI adapters), and match the cpu= option
  to the board voltage.

## Uno R4 specifics

- RA4M1 (Renesas): the R4 runs the MCU at 5V, so header I/O is 5V logic
  exactly like the R3 — a 3.3V sensor still needs a shifter on the MCU->
  sensor direction. What changes is the silicon underneath: it is Cortex-M4,
  not AVR, so register-level sketches (PORTB manipulation, TCCR timer
  registers, avr/*.h includes) do NOT port. Use the Arduino API, and expect
  analogRead to default to 10-bit against a 5V reference (analogReadResolution
  raises it to 14-bit). A0 additionally has a real DAC.
- Native USB (Leonardo-style): the serial port re-enumerates on upload and
  Serial may not exist until opened — while (!Serial) ; where appropriate.
`;

const BOARD_RASPBERRY_PI = `# Raspberry Pi as a Linux SBC (not a microcontroller)

There is no firmware flash loop for application code: the Pi runs Linux.
Build on-device or cross-compile, deploy over SSH, access hardware through
kernel interfaces. GPIO is 3.3V ONLY and not 5V-tolerant — a 5V signal on a
GPIO pin can kill the SoC.

## GPIO with libgpiod (the current, correct way)

wiringPi is deprecated/unmaintained; the sysfs /sys/class/gpio interface was
removed from modern kernels. Use libgpiod — but CHECK THE VERSION FIRST,
because the CLI syntax changed between v1 and v2:

\`\`\`
gpioset --version                # v1.6.4 (Raspberry Pi OS Bookworm) vs v2.2.x (Trixie)
\`\`\`

libgpiod v2 (Trixie and newer) — chip via -c/--chip, lines as line=value:

\`\`\`
sudo apt install gpiod
gpiodetect                       # list gpiochips (Pi 4/5: gpiochip0 = SoC GPIOs)
gpioinfo                         # lines, names, current consumers
gpioget -c gpiochip0 4           # read BCM GPIO4
gpioset -c gpiochip0 4=1         # drive high; HOLDS the line — does NOT exit (Ctrl-C to release)
gpioset -z -c gpiochip0 4=1      # --daemonize: set and exit, line stays held until released
gpioset -t 0 -c gpiochip0 4=1      # pulse: toggle and exit immediately (-t <periods>)
gpiomon -c gpiochip0 4           # watch edges (Ctrl-C to stop)
\`\`\`

v2 behavior to know: gpioset keeps the process alive holding the requested
line values (a GPIO line returns to its default state when released). For a
script that must set-and-exit use -z/--daemonize or a toggle with -t; a
foreground gpioset in a shell script will block. In libgpiod v1 (Bookworm)
the syntax was positional instead — gpioget gpiochip0 4 and
gpioset gpiochip0 4=1 (v1 gpioset exits immediately, releasing the line;
v1 has no -c flag). Mixing the two grammars is the most common libgpiod
mistake on Pi tutorials.

Note: line numbers are BCM numbers. On Pi 5 the RP1 southbridge owns the
header GPIOs — gpiodetect shows gpiochip0 as the RP1; gpioinfo tells you.

Python bindings: python3-libgpiod / pip gpiod (v2 API: gpiod.request_lines).
pigpio remains popular for servo/PWM timing and remote GPIO:

\`\`\`
sudo apt install pigpio python3-pigpio
sudo systemctl enable --now pigpiod
\`\`\`

## Device tree: enable I2C / SPI / UART / overlays

Config file location depends on the OS release:
- Raspberry Pi OS Bookworm and later: /boot/firmware/config.txt
- Older (Buster/Bullseye): /boot/config.txt

\`\`\`
# /boot/firmware/config.txt
dtparam=i2c_arm=on
dtparam=spi=on
enable_uart=1
dtoverlay=pwm-2chan,pin=18,pin2=13      # example: 2-channel PWM
dtoverlay=gpio-shutdown,gpio_pin=3      # example overlay
\`\`\`

Non-interactive enabling (writes config for you), then reboot:

\`\`\`
sudo raspi-config nonint do_i2c 0
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_serial 2    # UART enabled, no serial console
\`\`\`

List overlays: ls /boot/firmware/overlays/ ; docs: dtoverlay -h <name>.

## Buses after enabling

\`\`\`
sudo apt install i2c-tools
i2cdetect -y 1                 # scan I2C bus 1 (GPIO2/SDA, GPIO3/SCL); 0x27/0x3C etc.
ls /dev/spidev0.*              # SPI enabled => spidev0.0 spidev0.1
ls -l /dev/serial0             # primary UART (mini-UART on BT models; see dtoverlay=miniuart-bt / disable-bt)
\`\`\`

I2C needs pull-ups; most breakout boards include them. Default I2C speed
100 kHz (dtparam=i2c_arm=on,i2c_arm_baudrate=400000 for fast mode).

## Serial console gotcha

With the console on UART, a connected MCU receives kernel boot logs. Disable
the console (do_serial 2) before using /dev/serial0 for a device.

## Cross-compile from a PC

\`\`\`
sudo apt install gcc-aarch64-linux-gnu      # 64-bit OS targets (Pi 3/4/5)
aarch64-linux-gnu-gcc -O2 main.c -o app
scp app pi@raspberrypi.local:~/
ssh pi@raspberrypi.local ./app
\`\`\`

For 32-bit Raspberry Pi OS use arm-linux-gnueabihf-gcc. CMake toolchain
file: set(CMAKE_C_COMPILER aarch64-linux-gnu-gcc). Rust: target
aarch64-unknown-linux-gnu with linker override.

## Pin limits

3.3V logic, ~16 mA per pin, ~50 mA total across all GPIO. The 3V3 rail feeds
little more than the SoC needs — power sensors from 5V with a regulator, or
from 3V3 only if the budget is small. Never feed 5V into a GPIO.
`;

const BOARD_RP2040 = `# Raspberry Pi Pico / Pico W (RP2040, RP2350 on Pico 2)

Dual-core Cortex-M0+ (RP2040, 133 MHz) or M33/RISC-V (RP2350), 264 KB/520 KB
SRAM, no internal flash-resident OS — code lives on external QSPI flash.
Logic is 3.3V, NOT 5V-tolerant. Pico W adds WiFi/BLE via CYW43439.

## The UF2 / BOOTSEL flow (no debugger needed)

1. Hold BOOTSEL, plug in USB (or tap RUN while holding BOOTSEL).
2. Board mounts as mass-storage RPI-RP2 (RP2350: RP2350).
3. Copy a .uf2 onto it; it reboots into the new firmware automatically.

picotool (from the pico-sdk tools, or apt/brew picotool):

\`\`\`
picotool info -a                 # inspect the attached board
picotool load firmware.uf2       # flash without the drag-drop
picotool reboot -f               # force BOOTSEL mode
\`\`\`

## Three software stacks

1. Pico SDK (C/C++, official):
   git clone https://github.com/raspberrypi/pico-sdk --recursive
   export PICO_SDK_PATH=...
   Requires: cmake, arm-none-eabi-gcc (apt: cmake gcc-arm-none-eabi).
   In CMakeLists.txt: include(pico_sdk_import.cmake); pico_sdk_init();
   target_link_libraries(app pico_stdlib); for Pico W add
   pico_cyw43_arch_none and build with -DPICO_BOARD=pico_w.
   cmake -B build -DPICO_BOARD=pico_w && cmake --build build  ->  build/app.uf2

2. arduino-pico (Earle Philhower core, Arduino API):
   arduino-cli core install rp2040:rp2040 --additional-urls \\
     https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
   FQBNs: rp2040:rp2040:rpipico (Pico), rp2040:rp2040:rpipicow (Pico W).
   Upload over plain USB serial works (core auto-resets into BOOTSEL);
   first-ever upload may need manual BOOTSEL.

3. MicroPython / CircuitPython:
   Download the .uf2 from micropython.org (Pico vs Pico W builds differ!),
   drag onto RPI-RP2, then use mpremote (see toolchains/micropython.md).
   Serial REPL at 115200 on the USB CDC port.

## PlatformIO

\`\`\`ini
[env:pico]
platform = raspberrypi
board = pico            ; board = pico_w for Pico W (Arduino framework)
framework = arduino
monitor_speed = 115200
upload_protocol = picotool   ; or mbed (drag-drop) / cmsis-dap / jlink
\`\`\`

pio run -t upload -e pico flashes via picotool; if no UF2 volume appears,
put the board in BOOTSEL first.

## Gotchas

- Pico W LED is on the CYW43 chip, not GPIO25: in Arduino use
  digitalWrite(LED_BUILTIN, ...) (the core maps it); in MicroPython
  Pin("LED", Pin.OUT); in SDK use cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, 1).
- GP26–GP28 are ADC-capable (ADC0–ADC2); GP29 = ADC3 (VSYS/3 on Pico).
- The on-board LED on plain Pico is GP25.
- USB serial output is lost on reset — add a small delay or wait-for-host
  in setup() when debugging boot messages over USB CDC.
- SWD debug: GP debug probe or a second Pico running picoprobe
  (openocd -f interface/cmsis-dap.cfg -f target/rp2040.cfg).
`;

const BOARD_ORANGE_PI = `# Orange Pi 5 (RK3588S) / Orange Pi Zero 2W (Allwinner H618)

Linux SBCs like the Raspberry Pi: no firmware flashing for app code. GPIO is
3.3V logic, not 5V-tolerant. OS choice: Armbian (recommended, mainline
kernel) or the official Orange Pi OS images (Ubuntu/Debian/Arch flavors)
from orangepi.org. Flash the SD/eMMC image with balenaEtcher or dd; first
boot user/password for official images is typically orangepi/orangepi
(root/root on some).

## GPIO: there is no single gpiochip

Unlike a Pi, Rockchip SoCs expose several gpiochips (RK3588S: GPIO0–GPIO4,
32 lines each: gpiochip0..gpiochip4, order may vary by kernel). The header
pin -> chip/line mapping is board-specific; the authoritative source is the
pinout table in the Orange Pi user manual for your exact model. Formula for
Rockchip: global line = bank*32 + (group*8 + bit), e.g. GPIO3_C5 =
3*32 + (2*8 + 5) = 117 -> gpiochip3 line 21 (C5 = group C(2)*8 + 5).

Modern approach is libgpiod, same as Raspberry Pi — check the CLI version
first (gpioset --version; v1 positional vs v2 -c syntax, and v2 gpioset
holds the line open instead of exiting — see boards/raspberry-pi.md for the
full version note and the -z/-t escape hatches). v2 examples:

\`\`\`
sudo apt install gpiod
gpiodetect                     # shows gpiochip0..N with labels
gpioinfo gpiochip3 | head      # inspect lines
gpioset -c gpiochip3 21=1      # drive the computed line; holds until Ctrl-C
gpioset -z -c gpiochip3 21=1   # set and exit (daemonize), line stays held
\`\`\`

wiringOP (WiringPi port) is available on official images and still common
in tutorials:

\`\`\`
gpio readall                   # header pin table with wPi/BCM-ish numbers
gpio mode 2 out && gpio write 2 1
\`\`\`

wiringOP works but is effectively in maintenance mode; prefer libgpiod for
new code, and never trust a Raspberry Pi wiringPi pin table — the Orange Pi
header numbering differs even when the 40-pin layout matches.

## Overlays and interfaces

- Armbian: edit /boot/armbianEnv.txt — add to the overlays= line (space
  separated, board-specific names; see /boot/dtb/rockchip/overlay/ for
  what's available), plus param modules. Then reboot. armbian-config ->
  System -> Hardware toggles common ones (i2c, spi, uart, pwm).
- Official Orange Pi OS: orangepi-config provides the same toggles; the
  config lives in /boot/orangepiEnv.txt on newer images.
- I2C verify: i2cdetect -y 0 (bus number differs per board — check
  i2cdetect -l). UARTs show as /dev/ttyS1..S9 once enabled.

## Cross-compile (aarch64)

\`\`\`
sudo apt install gcc-aarch64-linux-gnu
aarch64-linux-gnu-gcc -O2 main.c -o app
scp app orangepi@<board-ip>:~/
\`\`\`

Same toolchain as 64-bit Raspberry Pi targets. On-device builds are fast
enough on the 8-core RK3588S that cross-compiling is optional.

## Gotchas

- Confirm the exact model (cat /proc/device-tree/model) before using any
  pin table — Zero 2W (Allwinner H618) pin mapping has nothing in common
  with Orange Pi 5 (RK3588S).
- Allwinner H-series: GPIO math is (letter*32 + pin) on a single gpiochip
  for the main controller (PL pins live on a separate r_pio chip).
- Many RK3588 PWM/UART pins are multiplexed — an overlay that enables pwm14
  may steal the pins from i2c5. Re-check gpioinfo after enabling overlays.
- Power: RK3588S boards want a solid 5V/4-5A USB-C supply; brownouts show
  as random reboots under CPU load, not as clean warnings.
`;

const BOARD_RADXA = `# Radxa Rock 5 / Zero 3 (Rockchip, Raspberry-Pi-style SBCs)

Rock 5A/5B: RK3588S. Zero 3E/3W: RK3566. Linux SBCs — 3.3V GPIO, not
5V-tolerant, no app "flashing". OS: Radxa official Debian/Ubuntu images or
Armbian, from docs.radxa.com. Flash SD/eMMC with Etcher/dd; eMMC modules can
also be written over USB with rkdeveloptool in maskrom mode (see the Radxa
wiki for the exact button/pin per board).

## Authoritative references

Always check docs.radxa.com (the Radxa wiki) for YOUR board model:
- hardware pinout pages give the GPIO number and gpiochip/line for every
  header pin;
- the "rsetup" and "overlays" guides list the device-tree overlays that
  actually ship with the current image.

## GPIO quirks

- Like other RK3588(S) boards, the header GPIOs are spread across multiple
  gpiochips (gpiochip0..gpiochip4, 32 lines each). The gpiochip NUMBERING IS
  NOT STABLE across kernel versions — scripts that hardcode gpiochip4 break
  after an update. Robust pattern: resolve by label, e.g. in Python look up
  the chip whose label matches, or use the per-board tables in the wiki
  which give both the global Linux GPIO number and the chip/line pair.
- libgpiod is the supported interface (gpiodetect, gpioinfo, gpioset,
  gpiomon — see boards/raspberry-pi.md for the command shapes).
- Rock 5B GPIO formula (RK3588S): line on gpiochipN = bank remainder;
  global Linux GPIO = N*32 + group*8 + bit, matching the wiki tables.

## rsetup (Radxa's raspi-config equivalent)

\`\`\`
sudo rsetup
\`\`\`

System -> Overlays -> Manage Overlays toggles i2c/spi/uart/pwm overlays;
rsetup edits the overlay list in /boot/armbianEnv.txt (Armbian-flavored
images) or /boot/radxa/overlays config on Radxa OS images, then reboot.
Verify after reboot: i2cdetect -l, ls /dev/ttyS*, gpioinfo.

## Maskrom / recovery flashing (for OS recovery, not app dev)

\`\`\`
sudo rkdeveloptool db rk3588_spl_loader.bin     # loader for the SoC
sudo rkdeveloptool wl 0 <image>.img             # write image to eMMC
rkdeveloptool rd                                # reboot
\`\`\`

Enter maskrom by holding the maskrom button (or shorting the eMMC clock pin
per the wiki) while powering on; lsusb shows 2207:350b for RK3588.

## Gotchas

- Zero 3 (RK3566) and Rock 5 (RK3588S) pin tables are unrelated — always
  match the wiki page to cat /proc/device-tree/model output.
- UART2 is the default debug console on Rock 5 (1.5 Mbaud, not 115200!);
  disable console before reusing it, and use 1500000 baud to read boot logs.
- USB-C PD: Rock 5B negotiates 9-12V with proper PD supplies; undervoltage
  with dumb 5V bricks causes NVMe dropouts under load.
- NVMe on Rock 5B needs the pci-e overlay enabled on some images (rsetup).
`;

const BOARD_STM32 = `# STM32 (Blue Pill, Nucleo, Black Pill, custom boards)

ARM Cortex-M MCUs programmed over SWD with an ST-Link probe (a $3 clone
works), or via the ROM bootloader (USB DFU on many F4/F7/H7, UART on all).
No OS, no serial console by default — printf goes over a UART you configure.

## Toolchains

1. PlatformIO (recommended default):

\`\`\`ini
[env:bluepill]
platform = ststm32
board = bluepill_f103c8        ; nucleo_f401re, blackpill_f411ce, genericSTM32F103C8 ...
framework = stm32cube          ; or arduino / libopencm3 / mbed / zephyr
upload_protocol = stlink       ; or dfu / jlink / cmsis-dap / serial
debug_tool = stlink
monitor_speed = 115200
\`\`\`

pio run && pio run -t upload   # flashes over the first ST-Link found

2. STM32CubeIDE / STM32CubeMX: generates HAL init code (pinout GUI),
   builds with arm-none-eabi-gcc. CLI programmer:

\`\`\`
STM32_Programmer_CLI -c port=SWD -w firmware.hex -v -rst
STM32_Programmer_CLI -c port=SWD -w build/firmware.bin 0x08000000 -rst
STM32_Programmer_CLI -c port=usb1 -w firmware.bin 0x08000000   # USB DFU (-w takes bin/hex/srec/elf/axf)
\`\`\`

## Flashing tools (open source)

stlink tools:

\`\`\`
st-info --probe                        # detect probe + target
st-flash write firmware.bin 0x8000000  # flash base address is 0x08000000
st-flash erase
\`\`\`

OpenOCD:

\`\`\`
openocd -f interface/stlink.cfg -f target/stm32f1x.cfg \\
  -c "program firmware.elf verify reset exit"
\`\`\`

(target file: stm32f1x.cfg, stm32f4x.cfg, stm32h7x.cfg, ... per family)

DFU (BOOT0 high at reset enters the ROM bootloader):

\`\`\`
dfu-util -l                            # find the DFU device
dfu-util -a 0 -s 0x08000000:leave -D firmware.bin
\`\`\`

UART bootloader (works on every STM32; BOOT0=1, reset, TX/RX on USART1
pins PA9/PA10 for F1):

\`\`\`
stm32flash -w firmware.bin -v /dev/ttyUSB0
\`\`\`

## Arduino on STM32 (STM32duino core)

arduino-cli core install STM32:stm32 --additional-urls \\
  https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stm_index.json
FQBNs like STM32:stm32:GenF1:pnum=BLUEPILL_F103C8 or
STM32:stm32:Nucleo_64:pnum=NUCLEO_F401RE. Upload method is part of the FQBN
options (upload_method=swdMethod / dfuMethod / serialMethod).

## Debugging

- SWD gives real debugging: pio debug starts a GDB session; set breakpoints
  in HAL code. Nucleo boards have an on-board ST-Link — no external probe.
- Semihosting or ITM/SWO trace via openocd; simplest remains UART printf:
  retarget _write to HAL_UART_Transmit.
- HardFault: inspect SCB->CFSR; in PlatformIO set
  debug_build_flags = -O0 -g3 and read the stacked PC in GDB.

## Gotchas

- Flash base is ALWAYS 0x08000000 (aliased to 0x0 at boot). st-flash needs
  the address explicitly.
- "Error: init mode failed" / target not halted: connect NRST to the probe
  and use upload_flags = -c "reset_config srst_only srst_nogate" or
  connect-under-reset; also caused by SWD pins reconfigured as GPIO by
  previous firmware (then hold reset / BOOT0 high while flashing).
- Blue Pill clones often ship the wrong R10 pull-up (10k vs 1.5k on D+)
  breaking USB; and many "128 KB" C8T6 actually have 64 KB guaranteed.
- F103 has no native USB DFU in ROM — use ST-Link, UART, or a USB
  bootloader (e.g. the Maple/hid bootloader).
- Logic is 3.3V; many GPIOs are 5V-tolerant (check the datasheet "FT"
  pins) but ADC pins are not.
`;

const TOOLCHAIN_PLATFORMIO = `# PlatformIO

Install: pip install platformio  (or pipx install platformio). The CLI is
pio (alias platformio). Core dir: ~/.platformio.

## The one command set you need

\`\`\`
pio project init --board esp32dev            # scaffold (or write platformio.ini by hand)
pio run                                      # build all default envs
pio run -e esp32dev                          # build one env
pio run -t upload --upload-port /dev/ttyUSB0
pio device list                              # serial ports
pio device monitor -b 115200                 # serial monitor (Ctrl-C to exit)
pio run -t clean                             # clean build dir
pio pkg update                               # update libs/platforms
pio test                                     # unit tests (native or on-target)
\`\`\`

## platformio.ini by board (real, working examples)

\`\`\`ini
[env:esp32dev]                     ; ESP32 DevKit V1 (WROOM-32)
platform = espressif32
board = esp32dev
framework = arduino
monitor_speed = 115200
upload_speed = 921600

[env:esp32-s3]
platform = espressif32
board = esp32-s3-devkitc-1
framework = arduino
monitor_speed = 115200
build_flags =
  -D ARDUINO_USB_CDC_ON_BOOT=1   ; native-USB serial in sketches

[env:esp32c3]
platform = espressif32
board = esp32-c3-devkitm-1
framework = arduino
monitor_speed = 115200

[env:esp32-idf]
platform = espressif32
board = esp32dev
framework = espidf               ; pure ESP-IDF project under PlatformIO
monitor_speed = 115200

[env:uno]
platform = atmelavr
board = uno
framework = arduino
monitor_speed = 9600

[env:mega]
platform = atmelavr
board = megaatmega2560
framework = arduino

[env:pico]                        ; Raspberry Pi Pico
platform = raspberrypi
board = pico                      ; pico_w for Pico W (Arduino)
framework = arduino
upload_protocol = picotool
monitor_speed = 115200

[env:bluepill]                    ; STM32F103 Blue Pill
platform = ststm32
board = bluepill_f103c8
framework = stm32cube             ; or arduino
upload_protocol = stlink

[env:nodemcu]                     ; ESP8266 NodeMCU v2
platform = espressif8266
board = nodemcuv2
framework = arduino
monitor_speed = 115200
\`\`\`

Find the exact board id: pio boards | grep -i <name>  (e.g. pio boards espressif32 | grep -i s3).

## Libraries

\`\`\`ini
lib_deps =
  adafruit/DHT sensor library @ ^1.4.6
  bblanchon/ArduinoJson @ ^7.1.0
\`\`\`

or CLI: pio pkg install --library "adafruit/DHT sensor library". Project
deps live in .pio/libdeps — never edit them; declare in lib_deps.

## Multiple environments and OTA

\`\`\`ini
[env:esp32-ota]
platform = espressif32
board = esp32dev
framework = arduino
upload_protocol = espota
upload_port = 192.168.1.50        ; mDNS name works too
\`\`\`

pio run -e esp32-ota -t upload pushes over WiFi (sketch must include
ArduinoOTA handling). Default env selection: default_envs = esp32dev in
[platformio] section.

## Useful build flags

\`\`\`ini
build_flags =
  -D CORE_DEBUG_LEVEL=3           ; ESP32 Arduino core debug logging
  -D CONFIG_LWIP_IPV6=1
monitor_filters = esp32_exception_decoder   ; decode ESP32 backtraces
\`\`\`

## CI (GitHub Actions sketch)

\`\`\`yaml
- uses: actions/setup-python@v5
- run: pip install platformio
- run: pio run                  # builds every env in platformio.ini
\`\`\`

Cache ~/.platformio between runs. Firmware artifacts land in
.pio/build/<env>/firmware.bin (and .elf).

## Troubleshooting

- "Unknown board ID": pio pkg update -g -p <platform> or fix the id via
  pio boards.
- Upload port flapping on native-USB boards: set upload_port explicitly or
  use upload_protocol = esptool with the board in download mode.
- Platform downloads are large on first run per platform; keep CI cache.
`;

const TOOLCHAIN_ARDUINO_CLI = `# Arduino CLI

The scriptable core of the Arduino IDE. Same cores, same FQBNs, no GUI.

## Install

\`\`\`
curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
# binary lands in ./bin — move to PATH. macOS: brew install arduino-cli
arduino-cli config init          # writes arduino-cli.yaml
\`\`\`

## Everyday flow

\`\`\`
arduino-cli core update-index
arduino-cli core search esp32
arduino-cli core install arduino:avr            # Uno/Nano/Mega
arduino-cli core install arduino:renesas_uno    # Uno R4
arduino-cli core install esp32:esp32            # needs the Espressif index URL, see below
arduino-cli board list                          # what's plugged in
arduino-cli board listall | grep -i nano        # FQBNs known to installed cores
arduino-cli sketch new Blink
arduino-cli compile --fqbn arduino:avr:uno Blink
arduino-cli upload -p /dev/ttyUSB0 --fqbn arduino:avr:uno Blink
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=9600
\`\`\`

## Third-party cores (ESP32, ESP8266, RP2040, STM32)

Add index URLs once:

\`\`\`
arduino-cli config add board_manager.additional_urls \\
  https://espressif.github.io/arduino-esp32/package_esp32_index.json \\
  https://arduino.esp8266.com/stable/package_esp8266com_index.json \\
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json \\
  https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stm_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32 rp2040:rp2040
\`\`\`

Resulting FQBNs: esp32:esp32:esp32 (DevKit), esp32:esp32:esp32s3,
esp32:esp32:esp32c3, esp8266:esp8266:nodemcuv2, rp2040:rp2040:rpipico,
STM32:stm32:GenF1:pnum=BLUEPILL_F103C8. Board-specific options append as
:option=value pairs, e.g. esp32:esp32:esp32:FlashFreq=80,PartitionScheme=huge_app.

## Libraries

\`\`\`
arduino-cli lib search "DHT sensor"
arduino-cli lib install "DHT sensor library"
arduino-cli lib install "PubSubClient"@2.8
arduino-cli lib list
\`\`\`

Compile pulls installed libs by #include name; a "No such file" for a known
header = library not installed (or name mismatch — lib search it).

## Useful flags

\`\`\`
arduino-cli compile --fqbn esp32:esp32:esp32 --build-property build.flash_freq=80m MySketch
arduino-cli compile --export-binaries --fqbn arduino:avr:uno MySketch   # .hex/.bin into build/
arduino-cli upload --verify ...
arduino-cli board details -b esp32:esp32:esp32    # every config option for a board
arduino-cli debug -p /dev/ttyUSB0 --fqbn ...      # GDB where the core supports it
\`\`\`

## Gotchas

- ESP32 core needs python3 + pyserial on PATH for esptool during upload.
- "Error opening serial port": board busy in another monitor, or missing
  dialout group on Linux.
- Uno R4/native-USB boards: the port vanishes on reset; upload retries
  after re-enumeration — if it fails, double-tap reset for the bootloader.
- Default monitor baud 9600; ESP32 cores print boot logs at 115200 — pass
  -c baudrate=115200 or you see garbage.
`;

const TOOLCHAIN_ESP_IDF = `# ESP-IDF (native Espressif framework for ESP32)

Use when the Arduino core is the limiting factor: custom partition tables,
menuconfig-tuned builds, ESP-NOW, BLE at the Bluedroid/NimBLE level, USB
device stacks, production OTA, power tuning. Supports ESP32, S2, S3, C3,
C6, H2, C2, P4 — but each project builds for ONE target chip.

## Install (Linux/macOS)

\`\`\`
git clone --recursive https://github.com/espressif/esp-idf.git ~/esp/esp-idf
cd ~/esp/esp-idf && git checkout v5.3.1 && git submodule update --init --recursive
./install.sh esp32,esp32s3          # installs toolchains for those targets
. ~/esp/esp-idf/export.sh           # EVERY new shell: puts idf.py on PATH
\`\`\`

Check with: idf.py --version. Windows: use the ESP-IDF PowerShell/CMD from
the installer. Major versions (4.x vs 5.x) are NOT source-compatible —
match the version a project's README pins.

## The loop

\`\`\`
idf.py create-project blink && cd blink
idf.py set-target esp32s3          # writes sdkconfig + build dir for the chip
idf.py menuconfig                  # component config: flash size, log levels, BT/WiFi opts
idf.py build                       # ninja build -> build/*.bin
idf.py -p /dev/ttyUSB0 flash       # esptool under the hood
idf.py -p /dev/ttyUSB0 monitor     # serial monitor w/ exception decoder (Ctrl-] exits)
idf.py -p /dev/ttyUSB0 flash monitor
idf.py fullclean                   # wipe build dir (needed after target change issues)
idf.py size                        # memory report; idf.py size-components
\`\`\`

## Project layout

- CMakeLists.txt (top: cmake_minimum_required + include($ENV{IDF_PATH}/tools/cmake/project.cmake) + project(name))
- main/CMakeLists.txt: idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")
- main/main.c: void app_main(void) — the entry point.
- sdkconfig: generated by menuconfig; commit it (or sdkconfig.defaults).

## Partitions

Default single-app table is fine until OTA. Custom CSV (partitions.csv),
sized for the common 4 MB flash:

\`\`\`
# Name,   Type, SubType,  Offset,   Size
nvs,      data, nvs,      0x9000,   0x4000
otadata,  data, ota,      0xd000,   0x2000
phy_init, data, phy,      0xf000,   0x1000
ota_0,    app,  ota_0,    0x10000,  1600K
ota_1,    app,  ota_1,    ,         1600K
storage,  data, spiffs,   ,         0x80000
\`\`\`

Two offsets that are NOT free choices: nvs is 0x4000 here, not the 0x6000
of the single-app default table — otadata sits at 0xd000, so a 0x6000 nvs
runs into it and gen_esp32part.py aborts with an overlap error. Every app
partition must also start on a 0x10000 boundary.

Enable in menuconfig: Partition Table -> Custom partition table CSV ->
partitions.csv. OTA needs two ota_X app slots + the otadata partition (the
bootloader reads otadata to pick the boot slot — without it an OTA build
fails to link/boot correctly). A \`factory\` partition is optional and
independent of OTA: ESP-IDF's own partitions_two_ota.csv has one, but on
4 MB flash factory + two 1M OTA slots leaves almost nothing for storage —
drop factory unless you specifically want a fallback image.

Check the arithmetic before flashing — the table must fit the real flash
size, and this is the single most common ESP-IDF build failure:

\`\`\`
idf.py partition-table          # prints the parsed table, errors on overlap/overflow
esptool.py --port /dev/ttyUSB0 flash_id    # confirms the ACTUAL flash size
\`\`\`

## Gotchas

- "idf.py: command not found" = export.sh not sourced in this shell.
- set-target changes require a fresh build dir; when in doubt fullclean.
- Flash size mismatch (menuconfig Serial flasher config -> Flash size must
  match the real chip; flash_id tells you) causes boot loops.
- Monitor shows "rst:0x..." loops: read the decoded backtrace line —
  idf.py monitor auto-decodes addresses to file:line when the elf exists.
- Component deps: add REQUIRES esp_wifi nvs_flash to the component register,
  or use the component manager: idf.py add-dependency "espressif/led_strip^2".
`;

const TOOLCHAIN_MICROPYTHON = `# MicroPython

Python 3 on the microcontroller: instant REPL over serial, no compile loop.
Best for prototyping sensors, teaching, and throwaway tooling. Not for hard
real-time or big WiFi stacks (use C/C++ there).

## Flash the firmware

Get the .bin (ESP32) or .uf2 (RP2040) from https://micropython.org/download
— pick the build for the EXACT chip (ESP32 vs ESP32-S3 vs Pico vs Pico W;
a wrong build boots to nothing).

ESP32 classic:

\`\`\`
esptool.py --chip esp32 --port /dev/ttyUSB0 erase_flash
esptool.py --chip esp32 --port /dev/ttyUSB0 write_flash -z 0x1000 ESP32_GENERIC-20250415-v1.25.0.bin
\`\`\`

ESP32-S2/S3/C3: offset 0x0 instead of 0x1000:

\`\`\`
esptool.py --chip esp32s3 --port /dev/ttyACM0 write_flash -z 0x0 ESP32_GENERIC_S3-*.bin
\`\`\`

ESP8266: offset 0x0 as well (esptool.py --chip esp8266 ... write_flash 0x0 ...).
RP2040: hold BOOTSEL, copy the .uf2 onto RPI-RP2.

## mpremote — the one tool to rule the workflow

\`\`\`
pip install mpremote
mpremote                          # auto-detect port, open REPL (Ctrl-] exits)
mpremote connect /dev/ttyUSB0 repl
mpremote fs ls                    # list files on the board
mpremote fs cp main.py :main.py   # copy TO the board (note the colon)
mpremote fs cp :boot.py boot.py   # copy FROM the board
mpremote fs rm :old.py
mpremote run sensor_demo.py       # execute local file WITHOUT copying
mpremote exec "import machine; print(machine.freq())"
mpremote reset
\`\`\`

## Project structure on the board

- boot.py — runs first; keep it minimal (connect WiFi here if needed).
- main.py — runs after boot.py; your app.
- lib/ — put pure-Python driver modules here and import them normally.
- To run code forever across reboots, it MUST be in main.py on the device;
  mpremote run is for the dev loop only.

Minimal main.py pattern:

\`\`\`python
from machine import Pin, I2C
import time

i2c = I2C(0, scl=Pin(22), sda=Pin(21))   # ESP32 default I2C0 pins
print("devices:", [hex(a) for a in i2c.scan()])
led = Pin(2, Pin.OUT)
while True:
    led.toggle()
    time.sleep(0.5)
\`\`\`

## WiFi from the REPL (ESP32/ESP8266/Pico W)

\`\`\`python
import network
sta = network.WLAN(network.STA_IF)
sta.active(True)
sta.connect("SSID", "password")
sta.ifconfig()        # ('192.168.1.x', ...)
\`\`\`

## WebREPL / mip

- WebREPL (wireless file transfer + REPL over WiFi): run once at REPL
  import webrepl_setup, enable + set password, reboot; then use the
  webrepl_cli.py client or the web UI. Disabled by default for a reason —
  treat it as lab tooling, never on untrusted networks.
- Install packages on-device (needs WiFi):
  import mip ; mip.install("umqtt.simple")
  or from the host: mpremote mip install umqtt.simple

## Gotchas

- REPL baud is 115200 on ESP32/RP2040 USB-serial.
- A main.py with while True and no sleep starves the WiFi/GC — include
  time.sleep_ms(10) or use asyncio (import asyncio; MicroPython ships
  asyncio as uasyncio-compatible).
- Ctrl-C in REPL breaks into the running main.py — that is how you regain
  control of a looping board.
- "OSError: [Errno 5] EIO" on I2C usually means wiring/pull-ups, not code;
  scan() first to prove the bus.
- MemoryError: MicroPython RAM is tight (ESP32 ~100 KB usable heap). Use
  const(), frozen modules, or the SPIRAM builds (ESP32_GENERIC-SPIRAM).
`;

const WORKFLOW_WHEN_STUCK = `# When it fails: symptom, cause, next command

A clean build and a verified flash prove NOTHING about behaviour. Firmware
that compiles and writes with "Hash of data verified" routinely does nothing
visible on the device. Treat toolchain success as the start of the test, not
the end of it.

## Verify on the hardware, never on the exit code

Before reporting anything as working, get a positive signal FROM the device:

1. A serial heartbeat the firmware prints itself — not a boot banner:
   \`Serial.printf("alive %lu fill=0x%04X\\n", millis(), color);\` every second.
2. A read-back where possible: \`esptool -p PORT read-flash 0x10000 0x100 v.bin\`
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
\`id -nG\` with \`id -nG $USER\`. If they differ, the group was added after
this login and only a re-login fixes it. Never chmod/chown the node.

**"side-effecting and interactive dispatch remain blocked".** A tool call
died with an unknown outcome. Recoverable in place with
\`/resolve <call-id> <disposition> <evidence-ref> <evidence-sha256>\`. Do not
tell the user to restart the session.

**Tool blocked "while this workspace has protected Editor authority".** A
stale editor lease, often from a dead session. Work in a different directory
or release the editor buffer; it is not a permissions problem.

**Build succeeds, board boot-loops or is silent.** Read the reset reason
over serial before changing code. Brownout means power, not firmware. Wrong
flash mode (qio vs dio) and wrong PSRAM mode (quad vs octal) both produce a
board that flashes fine and never boots — \`espefuse summary\` is the
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
`;

const WORKFLOW_END_TO_END = `# End-to-end recipe: I2C sensor + WiFi + OTA (ESP32 example)

The canonical IoT project loop, concrete enough to execute. Adapt board and
pins per the boards/*.md files. Assumed hardware: ESP32 DevKit + BME280
(I2C, address 0x76 or 0x77).

## 0. Pre-flash checklist (always)

- Board identified (esptool.py flash_id) and port known (pio device list).
- Wiring verified against safety.md BEFORE powering: BME280 VCC -> 3V3
  (not 5V — many modules regulate, but the bare sensor is 3.3V max), GND
  common, SDA -> GPIO21, SCL -> GPIO22 (ESP32 default I2C0), 4.7k pull-ups
  present (most breakout boards include them).
- Nothing attached to GPIO0/2/12/15 that could fight the strapping levels.
- Serial plan known: 115200 baud, /dev/ttyUSB0.

## 1. Scaffold

\`\`\`ini
; platformio.ini
[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
monitor_speed = 115200
upload_speed = 921600
lib_deps =
  adafruit/Adafruit BME280 Library @ ^2.2.4
  bblanchon/ArduinoJson @ ^7.1.0
  ayushsharma82/ElegantOTA @ ^3.1.0   ; v3 (AsyncElegantOTA v2 is archived)
build_flags =
  -D CORE_DEBUG_LEVEL=3
monitor_filters = esp32_exception_decoder
\`\`\`

## 2. Prove the bus before writing the app

Flash a scanner first — 90% of "sensor not working" is wiring:

\`\`\`cpp
#include <Wire.h>
void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.printf("found 0x%02X\\n", a); }
  }
}
void loop() {}
\`\`\`

pio run -t upload && pio device monitor -b 115200 — expect "found 0x76".

## 3. App: sensor -> WiFi -> HTTP, with OTA hooks

Structure: setup() = Serial, Wire, bme.begin(0x76), WiFi.begin(ssid, pass)
with a connect timeout + retry, ArduinoOTA.begin(); loop() =
ArduinoOTA.handle(), read sensor every N seconds (millis(), not delay()),
publish JSON. Secrets via build_flags (-D WIFI_SSID=...) or a gitignored
credentials.h — never commit real credentials.

## 4. Build, flash, monitor, iterate

\`\`\`
pio run
pio run -t upload --upload-port /dev/ttyUSB0
pio device monitor -b 115200
\`\`\`

Debug loop rules:
- One hypothesis per iteration. Change one thing, reflash, observe.
- Log early and loudly: Serial.println(F("boot ok")) first line of setup().
- Crash with "Guru Meditation Error": the monitor filter decodes the
  backtrace to source lines — fix the top frame in YOUR code first.
- WiFi connect stalls: wrong credentials, 5 GHz network (ESP32 is 2.4 GHz
  only), or country code — check WiFi.status() codes, not vibes.
- Sensor reads -127/NaN: bus dropped (loose wire) or wrong address — rerun
  the scanner.

## 5. OTA

After the first wired flash with OTA support:

\`\`\`ini
[env:esp32-ota]
extends = env:esp32dev
upload_protocol = espota
upload_port = 192.168.1.50
\`\`\`

pio run -e esp32-ota -t upload. Rules: never OTA from a battery-powered or
flaky-link device you can't recover by wire; keep a "safe mode" (hold a
button at boot -> skip WiFi, just breathe an LED) in every OTA-capable
firmware so a bad push is recoverable; verify the new image reports its
version over serial/MQTT before calling the deploy done.

## 6. Wrap-up

Report: what was flashed, serial evidence it works (quote the log lines),
OTA endpoint, and the wiring recap. Leave the project in a state where
pio run reproduces the firmware bit-for-bit.
`;

const SAFETY_GUIDE = `# Electrical safety — read before ANY wiring instruction

You are instructing a human to connect real electricity. A wrong sentence
destroys hardware or hurts someone. Run this checklist mentally and state
the relevant items to the user every time you give wiring steps. Mains
voltage (110/230 V) is OUT OF SCOPE: if the project touches it, instruct
the user to use a certified enclosed module (e.g. a UL-listed relay or PSU)
and stop there.

## 1. Logic levels: 3.3V vs 5V

- 3.3V-only, NOT 5V-tolerant: ESP32/ESP8266, RP2040, Raspberry Pi GPIO,
  Orange Pi, Radxa, nRF52, most modern sensors. 5V on these pins =
  permanent damage, sometimes delayed.
- 5V logic: classic AVR Arduinos (Uno R3, Nano, Mega). Their inputs read
  3.3V as HIGH (threshold ~0.6*VCC = 3.0V — marginal but works), but their
  OUTPUTS push 5V into whatever they drive.
- Many STM32 GPIOs are 5V-tolerant ("FT" in the datasheet) but ADC-capable
  pins are not. Check the specific pin.
- Rule: state the logic level of BOTH sides for every connection you
  instruct.

## 2. Level shifting (when 5V meets 3.3V)

- I2C (open-drain, bidirectional): bidirectional shifter module based on
  BSS138 MOSFETs, or a dedicated IC (PCA9306). NOT a resistor divider —
  I2C is bidirectional.
- SPI/UART/one-directional 5V->3.3V: resistor divider (e.g. 1k + 2k) is
  acceptable at low speed; 74AHCT125 / 74HCT245 buffers for anything fast
  or multiple lines.
- 3.3V->5V outputs: often accepted directly (5V logic reads 3.3V as HIGH),
  but for guaranteed margins use a 74HCT125 powered at 5V (HCT thresholds).
- WS2812/NeoPixel data at 5V supply: works at 3.3V data most of the time,
  but spec-safe is a 74AHCT125/74HCT245 shifter or a ~470 ohm series
  resistor + first-pixel sacrifice trick. State the uncertainty.

## 3. Current limits per pin (never exceed)

| Platform | Per-pin source/sink | Notes |
| --- | --- | --- |
| AVR (Uno/Nano/Mega) | 20 mA recommended, 40 mA absolute max | 200 mA total through VCC/GND pins |
| ESP32 | ~20 mA per GPIO at the default drive strength, 40 mA absolute max | drive strength is selectable (~5/10/20/40 mA) via gpio_set_drive_capability |
| RP2040 | 2/4/8/12 mA selectable drive, 12 mA max | 50 mA total IOH recommended |
| Raspberry Pi | ~16 mA per pin, ~50 mA TOTAL across all GPIO | the 3V3 rail itself feeds little extra |
| STM32 | 8-20 mA per pin (FT pins 20 mA), 25 mA injected max | check datasheet |

- An LED needs a series resistor: R = (V - Vf) / I. For 3.3V and a red LED
  (Vf ~1.8V, 5 mA): ~300 ohm -> use 330 ohm. State the resistor EVERY time
  you say "connect an LED".
- Never drive a relay coil, motor, solenoid, or buzzer directly from a GPIO.
  Use a transistor: logic-level N-MOSFET low-side (AO3400, IRLZ44N for
  bigger loads) or NPN (2N2222 with base resistor).

## 4. Inductive loads: flyback diodes are mandatory

Every relay coil, DC motor, solenoid, or electromagnet switched by a
transistor gets a flyback diode across the coil (1N4007 for slow/relay,
1N4148/SS34 for small/fast), cathode to +V. Skipping it kills the
transistor and glitches the MCU (random resets). Motors additionally want
100 nF across the terminals and proper decoupling on the driver supply.

## 5. Power rails

- NEVER power motors, LED strips, solenoids, heaters, or servos from the
  board's 5V or 3V3 pin. Separate supply, COMMON GROUND between supplies
  (no common ground = floating signals = chaos/damage).
- Servos: even a SG90 spikes past 500 mA; power from a dedicated 5V
  regulator, signal from GPIO.
- USB ports give 500 mA (USB2) nominally; an ESP32 WiFi burst plus a
  display plus sensors can brown out — symptoms: reboots when radio starts.
- 3V3 regulator on dev boards is often ~500-800 mA LDO; the MCU itself
  takes up to ~350 mA peak (ESP32 WiFi TX). Budget what's left.
- Vin/RAW pins: check the regulator's input range (e.g. Uno 7-12V on the
  barrel jack; feeding 5V into Vin under-powers the board; feeding 12V into
  a 5V pin destroys it).
- LiPo batteries: never connect directly to 5V pins or unregulated inputs;
  use a proper charger/protection module (TP4056 with protection, or the
  board's JST if present). Never charge unattended.

## 6. I2C/SPI/UART wiring rules

- I2C needs pull-ups (typically 4.7k to the bus voltage); most breakouts
  include them — but chaining 5 modules with pull-ups parallels them into
  a too-strong pull-up; mention it when stacking many modules.
- I2C: SDA/SCL must both go through the shifter when levels differ.
- SPI is 5V-intolerant on 3.3V MCUs: shift MOSI/SCK/CS down; MISO from a
  3.3V slave is fine into 5V master usually, but a 5V slave's MISO into a
  3.3V MCU needs shifting.
- UART crossing boards: TX->RX crossed, common ground, same baud — and
  same voltage.
- Keep I2C wires short (<30 cm unshielded at 100 kHz); long runs need lower
  speed or differential transceivers.

## 7. Process rules (state these to the user)

- Power OFF (unplug USB AND external supply) before changing any wiring.
- Double-check VCC and GND polarity and pin numbers against the board's
  silkscreen/pinout diagram before powering — reversed power is the most
  common board killer.
- Connect GND first when joining two powered systems.
- Add decoupling: 100 nF ceramic per IC near VCC pins + 10 uF bulk on
  rails feeding modules.
- ESD: touch grounded metal before handling bare boards; avoid carpet.
- Never hot-plug GPIO wires on a live board — inrush and ESD through IO
  pins latches up or kills peripherals.
- If anything smells hot or a chip is too hot to touch: power off
  immediately and re-check the circuit before retrying.
`;

export const IOT_BUILDER_SKILL: BundledSkillDefinition = {
  name: "iot-builder",
  description:
    "Build, flash, and debug IoT/embedded projects: Arduino, ESP32/ESP8266, Raspberry Pi (SBC + Pico/RP2040), Orange Pi, Radxa, STM32 — PlatformIO, Arduino CLI, ESP-IDF, MicroPython, GPIO/I2C/SPI/UART, serial debugging, and electrical safety.",
  whenToUse:
    "When the user works with microcontrollers, single-board computers, or embedded hardware: Arduino (Uno R3/R4, Nano, Mega, Pro Mini), ESP32/ESP8266, Raspberry Pi (SBC GPIO or Pico/RP2040/RP2350), Orange Pi, Radxa Rock, STM32; sensors, actuators, GPIO, I2C, SPI, UART, 1-Wire, PWM; writing or porting firmware; flashing (esptool, UF2/BOOTSEL, ST-Link, dfu-util); serial monitoring and boot-loop debugging; PlatformIO, Arduino CLI/IDE, ESP-IDF, MicroPython/CircuitPython, Pico SDK; SBC device-tree overlays, libgpiod, cross-compiling for aarch64; or any wiring question where logic levels, current limits, or electrical safety matter.",
  argumentHint: "[board or project goal]",
  files: {
    "boards/identify.md": BOARD_IDENTIFY,
    "boards/esp32.md": BOARD_ESP32,
    "boards/arduino.md": BOARD_ARDUINO,
    "boards/raspberry-pi.md": BOARD_RASPBERRY_PI,
    "boards/rp2040.md": BOARD_RP2040,
    "boards/orange-pi.md": BOARD_ORANGE_PI,
    "boards/radxa.md": BOARD_RADXA,
    "boards/stm32.md": BOARD_STM32,
    "toolchains/platformio.md": TOOLCHAIN_PLATFORMIO,
    "toolchains/arduino-cli.md": TOOLCHAIN_ARDUINO_CLI,
    "toolchains/esp-idf.md": TOOLCHAIN_ESP_IDF,
    "toolchains/micropython.md": TOOLCHAIN_MICROPYTHON,
    "workflows/when-stuck.md": WORKFLOW_WHEN_STUCK,
    "workflows/end-to-end.md": WORKFLOW_END_TO_END,
    "safety.md": SAFETY_GUIDE,
  },
  getPromptForCommand: (): Promise<ContentBlockParam[]> =>
    Promise.resolve([{ type: "text", text: IOT_BUILDER_GUIDE }]),
};
