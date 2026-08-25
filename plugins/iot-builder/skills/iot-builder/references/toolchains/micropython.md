# MicroPython

Python 3 on the microcontroller: instant REPL over serial, no compile loop.
Best for prototyping sensors, teaching, and throwaway tooling. Not for hard
real-time or big WiFi stacks (use C/C++ there).

## Flash the firmware

Get the .bin (ESP32) or .uf2 (RP2040) from https://micropython.org/download
— pick the build for the EXACT chip (ESP32 vs ESP32-S3 vs Pico vs Pico W;
a wrong build boots to nothing).

ESP32 classic:

```
esptool.py --chip esp32 --port /dev/ttyUSB0 erase_flash
esptool.py --chip esp32 --port /dev/ttyUSB0 write_flash -z 0x1000 ESP32_GENERIC-20250415-v1.25.0.bin
```

ESP32-S2/S3/C3: offset 0x0 instead of 0x1000:

```
esptool.py --chip esp32s3 --port /dev/ttyACM0 write_flash -z 0x0 ESP32_GENERIC_S3-*.bin
```

ESP8266: offset 0x0 as well (esptool.py --chip esp8266 ... write_flash 0x0 ...).
RP2040: hold BOOTSEL, copy the .uf2 onto RPI-RP2.

## mpremote — the one tool to rule the workflow

```
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
```

## Project structure on the board

- boot.py — runs first; keep it minimal (connect WiFi here if needed).
- main.py — runs after boot.py; your app.
- lib/ — put pure-Python driver modules here and import them normally.
- To run code forever across reboots, it MUST be in main.py on the device;
  mpremote run is for the dev loop only.

Minimal main.py pattern:

```python
from machine import Pin, I2C
import time

i2c = I2C(0, scl=Pin(22), sda=Pin(21))   # ESP32 default I2C0 pins
print("devices:", [hex(a) for a in i2c.scan()])
led = Pin(2, Pin.OUT)
while True:
    led.toggle()
    time.sleep(0.5)
```

## WiFi from the REPL (ESP32/ESP8266/Pico W)

```python
import network
sta = network.WLAN(network.STA_IF)
sta.active(True)
sta.connect("SSID", "password")
sta.ifconfig()        # ('192.168.1.x', ...)
```

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
