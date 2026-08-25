# End-to-end recipe: I2C sensor + WiFi + OTA (ESP32 example)

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

```ini
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
```

## 2. Prove the bus before writing the app

Flash a scanner first — 90% of "sensor not working" is wiring:

```cpp
#include <Wire.h>
void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.printf("found 0x%02X\n", a); }
  }
}
void loop() {}
```

pio run -t upload && pio device monitor -b 115200 — expect "found 0x76".

## 3. App: sensor -> WiFi -> HTTP, with OTA hooks

Structure: setup() = Serial, Wire, bme.begin(0x76), WiFi.begin(ssid, pass)
with a connect timeout + retry, ArduinoOTA.begin(); loop() =
ArduinoOTA.handle(), read sensor every N seconds (millis(), not delay()),
publish JSON. Secrets via build_flags (-D WIFI_SSID=...) or a gitignored
credentials.h — never commit real credentials.

## 4. Build, flash, monitor, iterate

```
pio run
pio run -t upload --upload-port /dev/ttyUSB0
pio device monitor -b 115200
```

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

```ini
[env:esp32-ota]
extends = env:esp32dev
upload_protocol = espota
upload_port = 192.168.1.50
```

pio run -e esp32-ota -t upload. Rules: never OTA from a battery-powered or
flaky-link device you can't recover by wire; keep a "safe mode" (hold a
button at boot -> skip WiFi, just breathe an LED) in every OTA-capable
firmware so a bad push is recoverable; verify the new image reports its
version over serial/MQTT before calling the deploy done.

## 6. Wrap-up

Report: what was flashed, serial evidence it works (quote the log lines),
OTA endpoint, and the wiring recap. Leave the project in a state where
pio run reproduces the firmware bit-for-bit.
