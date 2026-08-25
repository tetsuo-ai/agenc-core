# Arduino boards (AVR + Renesas R4)

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

```
arduino-cli board listall                 # all known boards
arduino-cli board listall uno             # filter
arduino-cli board list                    # what is actually plugged in
```

## Compile / upload / monitor

```
arduino-cli compile --fqbn arduino:avr:uno MySketch
arduino-cli upload -p /dev/ttyUSB0 --fqbn arduino:avr:uno MySketch
arduino-cli compile --upload -p /dev/ttyUSB0 --fqbn arduino:avr:uno MySketch   # one shot
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=9600                           # Ctrl-C to exit
```

Monitor defaults to 9600 baud; always pass -c baudrate=... matching the
sketch's Serial.begin(...).

## Libraries

```
arduino-cli lib search DHT
arduino-cli lib install "DHT sensor library"
arduino-cli lib install "Adafruit SSD1306"@2.5.9
```

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
