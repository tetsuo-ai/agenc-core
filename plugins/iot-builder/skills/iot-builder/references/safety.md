# Electrical safety — read before ANY wiring instruction

You are instructing a human to connect real electricity. A wrong sentence
destroys hardware or hurts someone. Run this checklist mentally and state
the relevant items to the user every time you give wiring steps. Mains
voltage (110/230 V) is OUT OF SCOPE: if the project touches it, instruct
the user to use a certified enclosed module (e.g. a UL-listed relay or PSU)
and stop there.

## 1. Logic levels: 3.3V vs 5V

- 3.3V-only, NOT 5V-tolerant: ESP32/ESP8266, RP2040, Raspberry Pi GPIO,
  Orange Pi, Radxa, nRF52, most modern sensors. 5V on these pins =
  permanent damage, sometimes delayed.
- 5V logic: classic AVR Arduinos (Uno R3, Nano, Mega). Their inputs read
  3.3V as HIGH (threshold ~0.6*VCC = 3.0V — marginal but works), but their
  OUTPUTS push 5V into whatever they drive.
- Many STM32 GPIOs are 5V-tolerant ("FT" in the datasheet) but ADC-capable
  pins are not. Check the specific pin.
- Rule: state the logic level of BOTH sides for every connection you
  instruct.

## 2. Level shifting (when 5V meets 3.3V)

- I2C (open-drain, bidirectional): bidirectional shifter module based on
  BSS138 MOSFETs, or a dedicated IC (PCA9306). NOT a resistor divider —
  I2C is bidirectional.
- SPI/UART/one-directional 5V->3.3V: resistor divider (e.g. 1k + 2k) is
  acceptable at low speed; 74AHCT125 / 74HCT245 buffers for anything fast
  or multiple lines.
- 3.3V->5V outputs: often accepted directly (5V logic reads 3.3V as HIGH),
  but for guaranteed margins use a 74HCT125 powered at 5V (HCT thresholds).
- WS2812/NeoPixel data at 5V supply: works at 3.3V data most of the time,
  but spec-safe is a 74AHCT125/74HCT245 shifter or a ~470 ohm series
  resistor + first-pixel sacrifice trick. State the uncertainty.

## 3. Current limits per pin (never exceed)

| Platform | Per-pin source/sink | Notes |
| --- | --- | --- |
| AVR (Uno/Nano/Mega) | 20 mA recommended, 40 mA absolute max | 200 mA total through VCC/GND pins |
| ESP32 | ~20 mA per GPIO at the default drive strength, 40 mA absolute max | drive strength is selectable (~5/10/20/40 mA) via gpio_set_drive_capability |
| RP2040 | 2/4/8/12 mA selectable drive, 12 mA max | 50 mA total IOH recommended |
| Raspberry Pi | ~16 mA per pin, ~50 mA TOTAL across all GPIO | the 3V3 rail itself feeds little extra |
| STM32 | 8-20 mA per pin (FT pins 20 mA), 25 mA injected max | check datasheet |

- An LED needs a series resistor: R = (V - Vf) / I. For 3.3V and a red LED
  (Vf ~1.8V, 5 mA): ~300 ohm -> use 330 ohm. State the resistor EVERY time
  you say "connect an LED".
- Never drive a relay coil, motor, solenoid, or buzzer directly from a GPIO.
  Use a transistor: logic-level N-MOSFET low-side (AO3400, IRLZ44N for
  bigger loads) or NPN (2N2222 with base resistor).

## 4. Inductive loads: flyback diodes are mandatory

Every relay coil, DC motor, solenoid, or electromagnet switched by a
transistor gets a flyback diode across the coil (1N4007 for slow/relay,
1N4148/SS34 for small/fast), cathode to +V. Skipping it kills the
transistor and glitches the MCU (random resets). Motors additionally want
100 nF across the terminals and proper decoupling on the driver supply.

## 5. Power rails

- NEVER power motors, LED strips, solenoids, heaters, or servos from the
  board's 5V or 3V3 pin. Separate supply, COMMON GROUND between supplies
  (no common ground = floating signals = chaos/damage).
- Servos: even a SG90 spikes past 500 mA; power from a dedicated 5V
  regulator, signal from GPIO.
- USB ports give 500 mA (USB2) nominally; an ESP32 WiFi burst plus a
  display plus sensors can brown out — symptoms: reboots when radio starts.
- 3V3 regulator on dev boards is often ~500-800 mA LDO; the MCU itself
  takes up to ~350 mA peak (ESP32 WiFi TX). Budget what's left.
- Vin/RAW pins: check the regulator's input range (e.g. Uno 7-12V on the
  barrel jack; feeding 5V into Vin under-powers the board; feeding 12V into
  a 5V pin destroys it).
- LiPo batteries: never connect directly to 5V pins or unregulated inputs;
  use a proper charger/protection module (TP4056 with protection, or the
  board's JST if present). Never charge unattended.

## 6. I2C/SPI/UART wiring rules

- I2C needs pull-ups (typically 4.7k to the bus voltage); most breakouts
  include them — but chaining 5 modules with pull-ups parallels them into
  a too-strong pull-up; mention it when stacking many modules.
- I2C: SDA/SCL must both go through the shifter when levels differ.
- SPI is 5V-intolerant on 3.3V MCUs: shift MOSI/SCK/CS down; MISO from a
  3.3V slave is fine into 5V master usually, but a 5V slave's MISO into a
  3.3V MCU needs shifting.
- UART crossing boards: TX->RX crossed, common ground, same baud — and
  same voltage.
- Keep I2C wires short (<30 cm unshielded at 100 kHz); long runs need lower
  speed or differential transceivers.

## 7. Process rules (state these to the user)

- Power OFF (unplug USB AND external supply) before changing any wiring.
- Double-check VCC and GND polarity and pin numbers against the board's
  silkscreen/pinout diagram before powering — reversed power is the most
  common board killer.
- Connect GND first when joining two powered systems.
- Add decoupling: 100 nF ceramic per IC near VCC pins + 10 uF bulk on
  rails feeding modules.
- ESD: touch grounded metal before handling bare boards; avoid carpet.
- Never hot-plug GPIO wires on a live board — inrush and ESD through IO
  pins latches up or kills peripherals.
- If anything smells hot or a chip is too hot to touch: power off
  immediately and re-check the circuit before retrying.
