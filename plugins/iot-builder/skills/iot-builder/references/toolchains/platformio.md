# PlatformIO

Install: pip install platformio  (or pipx install platformio). The CLI is
pio (alias platformio). Core dir: ~/.platformio.

## The one command set you need

```
pio project init --board esp32dev            # scaffold (or write platformio.ini by hand)
pio run                                      # build all default envs
pio run -e esp32dev                          # build one env
pio run -t upload --upload-port /dev/ttyUSB0
pio device list                              # serial ports
pio device monitor -b 115200                 # serial monitor (Ctrl-C to exit)
pio run -t clean                             # clean build dir
pio pkg update                               # update libs/platforms
pio test                                     # unit tests (native or on-target)
```

## platformio.ini by board (real, working examples)

```ini
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
```

Find the exact board id: pio boards | grep -i <name>  (e.g. pio boards espressif32 | grep -i s3).

## Libraries

```ini
lib_deps =
  adafruit/DHT sensor library @ ^1.4.6
  bblanchon/ArduinoJson @ ^7.1.0
```

or CLI: pio pkg install --library "adafruit/DHT sensor library". Project
deps live in .pio/libdeps — never edit them; declare in lib_deps.

## Multiple environments and OTA

```ini
[env:esp32-ota]
platform = espressif32
board = esp32dev
framework = arduino
upload_protocol = espota
upload_port = 192.168.1.50        ; mDNS name works too
```

pio run -e esp32-ota -t upload pushes over WiFi (sketch must include
ArduinoOTA handling). Default env selection: default_envs = esp32dev in
[platformio] section.

## Useful build flags

```ini
build_flags =
  -D CORE_DEBUG_LEVEL=3           ; ESP32 Arduino core debug logging
  -D CONFIG_LWIP_IPV6=1
monitor_filters = esp32_exception_decoder   ; decode ESP32 backtraces
```

## CI (GitHub Actions sketch)

```yaml
- uses: actions/setup-python@v5
- run: pip install platformio
- run: pio run                  # builds every env in platformio.ini
```

Cache ~/.platformio between runs. Firmware artifacts land in
.pio/build/<env>/firmware.bin (and .elf).

## Troubleshooting

- "Unknown board ID": pio pkg update -g -p <platform> or fix the id via
  pio boards.
- Upload port flapping on native-USB boards: set upload_port explicitly or
  use upload_protocol = esptool with the board in download mode.
- Platform downloads are large on first run per platform; keep CI cache.
