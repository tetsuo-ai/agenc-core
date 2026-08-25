# STM32 (Blue Pill, Nucleo, Black Pill, custom boards)

ARM Cortex-M MCUs programmed over SWD with an ST-Link probe (a $3 clone
works), or via the ROM bootloader (USB DFU on many F4/F7/H7, UART on all).
No OS, no serial console by default — printf goes over a UART you configure.

## Toolchains

1. PlatformIO (recommended default):

```ini
[env:bluepill]
platform = ststm32
board = bluepill_f103c8        ; nucleo_f401re, blackpill_f411ce, genericSTM32F103C8 ...
framework = stm32cube          ; or arduino / libopencm3 / mbed / zephyr
upload_protocol = stlink       ; or dfu / jlink / cmsis-dap / serial
debug_tool = stlink
monitor_speed = 115200
```

pio run && pio run -t upload   # flashes over the first ST-Link found

2. STM32CubeIDE / STM32CubeMX: generates HAL init code (pinout GUI),
   builds with arm-none-eabi-gcc. CLI programmer:

```
STM32_Programmer_CLI -c port=SWD -w firmware.hex -v -rst
STM32_Programmer_CLI -c port=SWD -w build/firmware.bin 0x08000000 -rst
STM32_Programmer_CLI -c port=usb1 -w firmware.bin 0x08000000   # USB DFU (-w takes bin/hex/srec/elf/axf)
```

## Flashing tools (open source)

stlink tools:

```
st-info --probe                        # detect probe + target
st-flash write firmware.bin 0x8000000  # flash base address is 0x08000000
st-flash erase
```

OpenOCD:

```
openocd -f interface/stlink.cfg -f target/stm32f1x.cfg \
  -c "program firmware.elf verify reset exit"
```

(target file: stm32f1x.cfg, stm32f4x.cfg, stm32h7x.cfg, ... per family)

DFU (BOOT0 high at reset enters the ROM bootloader):

```
dfu-util -l                            # find the DFU device
dfu-util -a 0 -s 0x08000000:leave -D firmware.bin
```

UART bootloader (works on every STM32; BOOT0=1, reset, TX/RX on USART1
pins PA9/PA10 for F1):

```
stm32flash -w firmware.bin -v /dev/ttyUSB0
```

## Arduino on STM32 (STM32duino core)

arduino-cli core install STM32:stm32 --additional-urls \
  https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stm_index.json
FQBNs like STM32:stm32:GenF1:pnum=BLUEPILL_F103C8 or
STM32:stm32:Nucleo_64:pnum=NUCLEO_F401RE. Upload method is part of the FQBN
options (upload_method=swdMethod / dfuMethod / serialMethod).

## Debugging

- SWD gives real debugging: pio debug starts a GDB session; set breakpoints
  in HAL code. Nucleo boards have an on-board ST-Link — no external probe.
- Semihosting or ITM/SWO trace via openocd; simplest remains UART printf:
  retarget _write to HAL_UART_Transmit.
- HardFault: inspect SCB->CFSR; in PlatformIO set
  debug_build_flags = -O0 -g3 and read the stacked PC in GDB.

## Gotchas

- Flash base is ALWAYS 0x08000000 (aliased to 0x0 at boot). st-flash needs
  the address explicitly.
- "Error: init mode failed" / target not halted: connect NRST to the probe
  and use upload_flags = -c "reset_config srst_only srst_nogate" or
  connect-under-reset; also caused by SWD pins reconfigured as GPIO by
  previous firmware (then hold reset / BOOT0 high while flashing).
- Blue Pill clones often ship the wrong R10 pull-up (10k vs 1.5k on D+)
  breaking USB; and many "128 KB" C8T6 actually have 64 KB guaranteed.
- F103 has no native USB DFU in ROM — use ST-Link, UART, or a USB
  bootloader (e.g. the Maple/hid bootloader).
- Logic is 3.3V; many GPIOs are 5V-tolerant (check the datasheet "FT"
  pins) but ADC pins are not.
