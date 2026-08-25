# Identifying an unknown board

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
  back: `esptool -p PORT write-flash 0x0 <factory>.bin` for a full-flash
  dump. Verified on a Waveshare AMOLED board — 16 MB written, hash
  verified, display alive again after a replug.
- **Disambiguate revisions without opening anything.** Vendors ship one
  image per hardware revision. Fingerprint them:

```
strings -n 5 vendor-v1.bin | grep -oiE 'sh8601|co5300|ft3168|cst820'
strings -n 5 vendor-v2.bin | grep -oiE 'sh8601|co5300|ft3168|cst820'
```

That printed SH8601 for V1 and CO5300 for V2 of the same product. Flashing
one and asking the user whether the screen lit is then a two-option test
with an immediate, unambiguous answer — far cheaper than deducing the panel
from the outside.

## Rung 0b — what the host already knows (free, no connection)

```
ls -l /dev/serial/by-id/                   # symlinks carry vendor strings
lsusb -v -d <vid>:<pid> 2>/dev/null | head -40
cat /sys/bus/usb/devices/*/{idVendor,idProduct,manufacturer,product,serial}
journalctl -k --since "-10 min" | grep -i usb   # enumeration, re-plug events
```

Read the strings, but know their worth. A board behind a UART bridge
(CP210x/CH340/FTDI) sometimes carries a real vendor string — occasionally
decisive. A board using the ESP32's native USB does not: Manufacturer
"Espressif", Product "USB JTAG/serial debug unit" and Serial = MAC come from
chip ROM and are identical across every board built on that chip. Do not
over-read them.

## Rung 1 — chip truth (read-only, always works)

```
esptool -p /dev/ttyACM0 flash-id     # chip model + revision, flash mfr/part/size
esptool -p /dev/ttyACM0 read-mac
espefuse -p /dev/ttyACM0 summary     # factory MAC, package, burned flash/PSRAM config
```

espefuse is the authority on whether PSRAM is quad or octal, which is the
setting that most often produces a board that builds fine and never boots.
This rung is deterministic: whatever it says is true.

## Rung 2 — enumerate candidates from local board databases

Nobody queries these, and they are already on disk — hundreds of
machine-readable board definitions, offline:

```
ls ~/.platformio/platforms/*/boards/*.json | wc -l
grep -l '"0x303A"' ~/.platformio/platforms/*/boards/*.json      # by USB hwid
grep -l 'ESP32_S3R8N16' ~/.platformio/platforms/*/boards/*.json # by memory config
arduino-cli board listall
arduino-cli board details --fqbn <fqbn>
```

Each manifest carries hwids, mcu, f_cpu, flash_mode, memory_type and the
partition scheme. Filtering by hwid plus the memory configuration from rung 1
turns "some ESP32-S3" into a reviewable list.

Two honest limits. Filtering 303a:1001 leaves ~47 candidates, so this narrows
but does not resolve. And the manifests describe the **chip configuration,
not the peripherals** — the LilyGO T-Display-S3 manifest contains its name,
mcu and partition table and says nothing whatsoever about the ST7789 panel
that is the entire reason to buy that board.

The real pin map lives in the installed core, not the manifest:

```
find ~/.platformio/packages ~/.arduino15 -path '*variants*' -name pins_arduino.h | head
```

That file is the truth that gets compiled. Quote pin numbers from it, with
the path.

## Rung 3 — interrogate the existing firmware (before you overwrite it)

A board that arrived with a factory demo is carrying a description of
itself. Back it up first — this is also your only restore point:

```
esptool -p /dev/ttyACM0 read-flash 0 ALL backup.bin   # ALL autodetects size
```

Then mine it. Driver and framework strings survive in the binary:

```
strings -n 5 backup.bin | grep -iE 'st77|ili9|ssd13|gc9a|lvgl|tft_espi|lilygo|t-display|m5|waveshare|heltec'
strings -n 5 backup.bin | grep -iE 'esp-idf|loopTask|app_main'   # IDF vs Arduino core
```

Recovered from a real unknown board this way: chip, flash part number,
that it ran the Arduino core, and its partition layout. Framework and
display driver are exactly the facts the manifests lack.

## Rung 4 — measure with a probe sketch

Flash a disposable diagnostic and read the answers over serial. This is the
rung that works when the board is in no database at all.

```cpp
#include <Wire.h>
#include "esp_chip_info.h"
void setup() {
  Serial.begin(115200);
  while (!Serial) {}
  delay(2000);                       // native USB re-enumerates after reset
  esp_chip_info_t info; esp_chip_info(&info);
  Serial.printf("model=%d rev=%d cores=%d features=0x%x\n",
                info.model, info.revision, info.cores, info.features);
  Serial.printf("flash=%u psram=%u mac=%llx\n",
                ESP.getFlashChipSize(), ESP.getPsramSize(), ESP.getEfuseMac());
  // Sweep plausible I2C pin pairs; print every address that answers.
  const int pairs[][2] = {{21,22},{8,9},{6,7},{17,18},{43,44}};
  for (auto &p : pairs) {
    Wire.begin(p[0], p[1]);
    for (uint8_t a = 1; a < 127; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0)
        Serial.printf("i2c sda=%d scl=%d addr=0x%02x\n", p[0], p[1], a);
    }
  }
}
void loop() {}
```

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
`[measured: <command>]`, `[vendor: <source>]`, `[user-reported]`,
`[ASSUMED]`. Anything ASSUMED or unverified must be restated as an
assumption every time you report on it. Never silently promote it.

```markdown
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
```

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
