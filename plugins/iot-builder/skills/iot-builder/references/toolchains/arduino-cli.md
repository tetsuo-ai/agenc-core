# Arduino CLI

The scriptable core of the Arduino IDE. Same cores, same FQBNs, no GUI.

## Install

```
curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
# binary lands in ./bin — move to PATH. macOS: brew install arduino-cli
arduino-cli config init          # writes arduino-cli.yaml
```

## Everyday flow

```
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
```

## Third-party cores (ESP32, ESP8266, RP2040, STM32)

Add index URLs once:

```
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json \
  https://arduino.esp8266.com/stable/package_esp8266com_index.json \
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json \
  https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stm_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32 rp2040:rp2040
```

Resulting FQBNs: esp32:esp32:esp32 (DevKit), esp32:esp32:esp32s3,
esp32:esp32:esp32c3, esp8266:esp8266:nodemcuv2, rp2040:rp2040:rpipico,
STM32:stm32:GenF1:pnum=BLUEPILL_F103C8. Board-specific options append as
:option=value pairs, e.g. esp32:esp32:esp32:FlashFreq=80,PartitionScheme=huge_app.

## Libraries

```
arduino-cli lib search "DHT sensor"
arduino-cli lib install "DHT sensor library"
arduino-cli lib install "PubSubClient"@2.8
arduino-cli lib list
```

Compile pulls installed libs by #include name; a "No such file" for a known
header = library not installed (or name mismatch — lib search it).

## Useful flags

```
arduino-cli compile --fqbn esp32:esp32:esp32 --build-property build.flash_freq=80m MySketch
arduino-cli compile --export-binaries --fqbn arduino:avr:uno MySketch   # .hex/.bin into build/
arduino-cli upload --verify ...
arduino-cli board details -b esp32:esp32:esp32    # every config option for a board
arduino-cli debug -p /dev/ttyUSB0 --fqbn ...      # GDB where the core supports it
```

## Gotchas

- ESP32 core needs python3 + pyserial on PATH for esptool during upload.
- "Error opening serial port": board busy in another monitor, or missing
  dialout group on Linux.
- Uno R4/native-USB boards: the port vanishes on reset; upload retries
  after re-enumeration — if it fails, double-tap reset for the bootloader.
- Default monitor baud 9600; ESP32 cores print boot logs at 115200 — pass
  -c baudrate=115200 or you see garbage.
