# Orange Pi 5 (RK3588S) / Orange Pi Zero 2W (Allwinner H618)

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

```
sudo apt install gpiod
gpiodetect                     # shows gpiochip0..N with labels
gpioinfo gpiochip3 | head      # inspect lines
gpioset -c gpiochip3 21=1      # drive the computed line; holds until Ctrl-C
gpioset -z -c gpiochip3 21=1   # set and exit (daemonize), line stays held
```

wiringOP (WiringPi port) is available on official images and still common
in tutorials:

```
gpio readall                   # header pin table with wPi/BCM-ish numbers
gpio mode 2 out && gpio write 2 1
```

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

```
sudo apt install gcc-aarch64-linux-gnu
aarch64-linux-gnu-gcc -O2 main.c -o app
scp app orangepi@<board-ip>:~/
```

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
