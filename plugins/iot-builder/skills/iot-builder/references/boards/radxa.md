# Radxa Rock 5 / Zero 3 (Rockchip, Raspberry-Pi-style SBCs)

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

```
sudo rsetup
```

System -> Overlays -> Manage Overlays toggles i2c/spi/uart/pwm overlays;
rsetup edits the overlay list in /boot/armbianEnv.txt (Armbian-flavored
images) or /boot/radxa/overlays config on Radxa OS images, then reboot.
Verify after reboot: i2cdetect -l, ls /dev/ttyS*, gpioinfo.

## Maskrom / recovery flashing (for OS recovery, not app dev)

```
sudo rkdeveloptool db rk3588_spl_loader.bin     # loader for the SoC
sudo rkdeveloptool wl 0 <image>.img             # write image to eMMC
rkdeveloptool rd                                # reboot
```

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
