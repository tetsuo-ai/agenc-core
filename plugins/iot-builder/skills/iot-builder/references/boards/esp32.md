# ESP32 family

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

```
esptool.py --port /dev/ttyUSB0 flash_id     # or: esptool.py flash_id --port ...
```

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

```
esptool.py --port /dev/ttyUSB0 --baud 460800 write_flash \
  0x1000 bootloader.bin 0x8000 partitions.bin 0x10000 firmware.bin
```

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

```
esptool.py --port /dev/ttyUSB0 erase_flash
```

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
after upload. To force a run: `esptool -p PORT run`.

**eFuse FLASH_TYPE describes the FLASH, not the PSRAM.** `espefuse summary`
on an S3R8 reports `FLASH_TYPE = 4 data lines (quad)` while the in-package
PSRAM is octal. PSRAM_CAP/PSRAM_VENDOR give capacity and vendor, neither
says quad vs octal. Reading FLASH_TYPE as the PSRAM mode leads straight to
a build that will not boot.

**The only reliable PSRAM test is to build both ways and look:**

```ini
board_build.arduino.memory_type = qio_opi   ; octal
board_build.psram = opi
```

then print `ESP.getPsramSize()` and `psramFound()`. Measured on an S3R8:
opi gives 8386295 bytes / YES; quad (qio_qspi + psram=enabled) gives 0 / NO
with an otherwise identical build. Silent boot after changing memory_type is
the classic symptom — but confirm it with a correct serial read first (see
the DTR/RTS trap above).

**GPIO 22-25 do not exist on the S3.** Including one in a pin sweep aborts
the I2C driver with `i2c_set_pin(875): scl gpio number error` and takes the
rest of the sweep with it. GPIO 26-32 are the flash bus; 33-37 are consumed
by octal PSRAM on an S3R8. Driving any of them hangs the chip.

**`read-flash 0 ALL` stalls over native USB-JTAG.** A full 16 MB read dies
around the 1 MB mark ("Packet content transfer stopped"), at the same point
regardless of --baud. Short reads on both sides of the stall succeed, so the
flash is fine — it is a sustained-transfer limit. Read in chunks well under
1 MB and concatenate.

**Check whether a backup is worth taking before taking it.** `strings` on
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
