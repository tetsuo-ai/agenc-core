# Raspberry Pi as a Linux SBC (not a microcontroller)

There is no firmware flash loop for application code: the Pi runs Linux.
Build on-device or cross-compile, deploy over SSH, access hardware through
kernel interfaces. GPIO is 3.3V ONLY and not 5V-tolerant — a 5V signal on a
GPIO pin can kill the SoC.

## GPIO with libgpiod (the current, correct way)

wiringPi is deprecated/unmaintained; the sysfs /sys/class/gpio interface was
removed from modern kernels. Use libgpiod — but CHECK THE VERSION FIRST,
because the CLI syntax changed between v1 and v2:

```
gpioset --version                # v1.6.4 (Raspberry Pi OS Bookworm) vs v2.2.x (Trixie)
```

libgpiod v2 (Trixie and newer) — chip via -c/--chip, lines as line=value:

```
sudo apt install gpiod
gpiodetect                       # list gpiochips (Pi 4/5: gpiochip0 = SoC GPIOs)
gpioinfo                         # lines, names, current consumers
gpioget -c gpiochip0 4           # read BCM GPIO4
gpioset -c gpiochip0 4=1         # drive high; HOLDS the line — does NOT exit (Ctrl-C to release)
gpioset -z -c gpiochip0 4=1      # --daemonize: set and exit, line stays held until released
gpioset -t 0 -c gpiochip0 4=1      # pulse: toggle and exit immediately (-t <periods>)
gpiomon -c gpiochip0 4           # watch edges (Ctrl-C to stop)
```

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

```
sudo apt install pigpio python3-pigpio
sudo systemctl enable --now pigpiod
```

## Device tree: enable I2C / SPI / UART / overlays

Config file location depends on the OS release:
- Raspberry Pi OS Bookworm and later: /boot/firmware/config.txt
- Older (Buster/Bullseye): /boot/config.txt

```
# /boot/firmware/config.txt
dtparam=i2c_arm=on
dtparam=spi=on
enable_uart=1
dtoverlay=pwm-2chan,pin=18,pin2=13      # example: 2-channel PWM
dtoverlay=gpio-shutdown,gpio_pin=3      # example overlay
```

Non-interactive enabling (writes config for you), then reboot:

```
sudo raspi-config nonint do_i2c 0
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_serial 2    # UART enabled, no serial console
```

List overlays: ls /boot/firmware/overlays/ ; docs: dtoverlay -h <name>.

## Buses after enabling

```
sudo apt install i2c-tools
i2cdetect -y 1                 # scan I2C bus 1 (GPIO2/SDA, GPIO3/SCL); 0x27/0x3C etc.
ls /dev/spidev0.*              # SPI enabled => spidev0.0 spidev0.1
ls -l /dev/serial0             # primary UART (mini-UART on BT models; see dtoverlay=miniuart-bt / disable-bt)
```

I2C needs pull-ups; most breakout boards include them. Default I2C speed
100 kHz (dtparam=i2c_arm=on,i2c_arm_baudrate=400000 for fast mode).

## Serial console gotcha

With the console on UART, a connected MCU receives kernel boot logs. Disable
the console (do_serial 2) before using /dev/serial0 for a device.

## Cross-compile from a PC

```
sudo apt install gcc-aarch64-linux-gnu      # 64-bit OS targets (Pi 3/4/5)
aarch64-linux-gnu-gcc -O2 main.c -o app
scp app pi@raspberrypi.local:~/
ssh pi@raspberrypi.local ./app
```

For 32-bit Raspberry Pi OS use arm-linux-gnueabihf-gcc. CMake toolchain
file: set(CMAKE_C_COMPILER aarch64-linux-gnu-gcc). Rust: target
aarch64-unknown-linux-gnu with linker override.

## Pin limits

3.3V logic, ~16 mA per pin, ~50 mA total across all GPIO. The 3V3 rail feeds
little more than the SoC needs — power sensors from 5V with a regulator, or
from 3V3 only if the budget is small. Never feed 5V into a GPIO.
