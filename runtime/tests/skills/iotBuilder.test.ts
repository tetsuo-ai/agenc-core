import assert from 'node:assert/strict'
import { test } from 'vitest'

// MACRO is replaced at build time but not in test mode. Registration of a
// bundled skill with `files` resolves the extraction directory (and thus
// MACRO.VERSION) at module load, so the stub must exist before the dynamic
// imports below pull in bundledSkills.ts.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/tetsuo-ai/agenc-core/issues',
  PACKAGE_URL: '@tetsuo-ai/agenc',
  NATIVE_PACKAGE_URL: undefined,
}

import type { ToolUseContext } from '../tools/Tool.js'

const EXPECTED_FILES = [
  'boards/identify.md',
  'boards/esp32.md',
  'boards/arduino.md',
  'boards/raspberry-pi.md',
  'boards/rp2040.md',
  'boards/orange-pi.md',
  'boards/radxa.md',
  'boards/stm32.md',
  'toolchains/platformio.md',
  'toolchains/arduino-cli.md',
  'toolchains/esp-idf.md',
  'toolchains/micropython.md',
  'workflows/when-stuck.md',
  'workflows/end-to-end.md',
  'safety.md',
]

test('bundled iot-builder skill registers with board detection and safety workflow', async () => {
  const { getBundledSkills } = await import('./bundledSkills.js')
  const skill = getBundledSkills().find(
    (command) => command.name === 'iot-builder',
  )
  assert.ok(skill, 'iot-builder skill is registered as a bundled skill')
  assert.equal(skill.source, 'bundled')
  assert.equal(skill.userInvocable, true)
  assert.equal(skill.isHidden, false)
  assert.equal(skill.type, 'prompt')
  assert.equal(skill.argumentHint, '[board or project goal]')

  assert.ok(skill.description && skill.description.length > 0)
  assert.ok(skill.whenToUse && skill.whenToUse.length > 0)
  assert.match(skill.whenToUse!, /ESP32/)
  assert.match(skill.whenToUse!, /Arduino/)
  assert.match(skill.whenToUse!, /STM32/)

  const blocks = await skill.getPromptForCommand('', {} as ToolUseContext)
  const text = blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')

  assert.match(
    text,
    /Identify the hardware — by measuring, not by recalling/,
    'teaches board detection',
  )
  assert.match(
    text,
    /identifies the \*\*chip\*\*, not the \*\*board\*\*/,
    'states what USB and esptool probes actually prove',
  )
  assert.match(
    text,
    /Never write a pin number, FQBN, flash offset or display driver from\nmemory/,
    'forbids recalled hardware values in the always-read prompt',
  )
  assert.match(
    text,
    /read-flash 0 ALL backup\.bin/,
    'mandates a backup before the first overwrite',
  )
  assert.match(
    text,
    /A clean build and a verified flash prove nothing/,
    'the always-read prompt carries the hardware-verification rule',
  )
  assert.match(
    text,
    /Never re-run a failed command unchanged/,
    'the always-read prompt carries bounded retry',
  )
  assert.match(
    text,
    /Never end a turn announcing what you are about to do/,
    'the always-read prompt forbids announce-and-stop',
  )
  assert.match(
    text,
    /Keep HARDWARE\.md current — it is your memory/,
    'the always-read prompt makes the inventory the cross-session memory',
  )
  assert.match(
    text,
    /A project is a SET of things/,
    'the always-read prompt treats a project as multiple components',
  )
  assert.match(
    text,
    /arduino-cli board list/,
    'includes real detection commands',
  )
  assert.match(text, /PlatformIO/, 'covers toolchain selection')
  assert.match(text, /pio device monitor/, 'covers the serial monitor step')
  assert.match(
    text,
    /Electrical safety/,
    'carries the mandatory safety checklist',
  )
  assert.match(text, /dialout/, 'covers Linux serial permissions')
  assert.match(
    text,
    /Base directory for this skill/,
    'instructs the agent to use the extracted reference files',
  )
})

test('iot-builder definition ships the board, toolchain, workflow, and safety references', async () => {
  const { IOT_BUILDER_SKILL } = await import('./bundled/iotBuilder.js')
  assert.equal(IOT_BUILDER_SKILL.name, 'iot-builder')
  assert.ok(IOT_BUILDER_SKILL.description.length > 0)
  assert.ok(IOT_BUILDER_SKILL.whenToUse!.length > 0)

  const files = IOT_BUILDER_SKILL.files
  assert.ok(files, 'skill ships extractable reference files')
  for (const path of EXPECTED_FILES) {
    assert.ok(
      files[path] && files[path].length > 500,
      `files['${path}'] exists and is non-trivial`,
    )
  }

  // Identification must stay measurement-first: the ladder, the local board
  // databases, the on-device probe, and provenance tagging. A real session
  // burned its whole context because the agent recalled a board model from
  // training data and presented it as a conclusion.
  const identify = files['boards/identify.md']!
  // Rung 0 is asking for the purchase listing. Measured: a full day of
  // probing never named the board; the listing title did, in ten minutes.
  assert.match(identify, /Rung 0 — ask for the purchase listing FIRST/, 'listing first')
  assert.match(identify, /write-flash 0x0/, 'vendor factory image restores a bricked board')
  assert.match(identify, /sh8601\|co5300/, 'fingerprint vendor images to pick the revision')

  assert.match(identify, /read-flash 0 ALL/, 'backup before first overwrite')
  assert.match(identify, /espefuse/, 'eFuse is the authority on PSRAM config')
  assert.match(identify, /pins_arduino\.h/, 'real pin map source')
  assert.match(identify, /platformio\/platforms/, 'local board manifests')
  assert.match(identify, /esp_chip_info/, 'on-device probe sketch')
  assert.match(identify, /RDDID/, 'display controller identification')
  assert.match(identify, /HARDWARE\.md/, 'provenance convention')
  assert.match(identify, /ASSUMED/, 'assumptions stay tagged as assumptions')
  // A project is a set of parts, often several boards — and the inventory on
  // disk is what makes a lost session survivable.
  assert.match(identify, /INVENTORY, not a single spec/, 'multi-component')
  assert.match(identify, /board-main/, 'named targets when there are several')
  assert.match(identify, /External components/, 'parts beyond the board itself')
  assert.match(
    identify,
    /losing a session|chats get restarted/,
    'the inventory is the cross-session memory',
  )

  // Traps measured on a real ESP32-S3R8, each after a wrong conclusion.
  const esp32 = files['boards/esp32.md']!
  assert.match(esp32, /GPIO0/, 'ESP32 strapping pins')
  assert.match(
    esp32,
    /Toggling DTR\/RTS on native USB-JTAG does NOT reset the board/,
    'the reset trap that fakes a boot crash',
  )
  assert.match(
    esp32,
    /eFuse FLASH_TYPE describes the FLASH, not the PSRAM/,
    'the eFuse field that gets misread as PSRAM mode',
  )
  assert.match(esp32, /8386295/, 'measured octal PSRAM size, not a guess')
  assert.match(
    esp32,
    /GPIO 22-25 do not exist on the S3/,
    'pins that abort an I2C sweep',
  )
  assert.match(
    esp32,
    /Packet content transfer stopped/,
    'the literal error from a stalled full-flash read',
  )
  assert.match(files['boards/arduino.md']!, /arduino:avr:uno/, 'Uno FQBN')
  assert.match(
    files['boards/raspberry-pi.md']!,
    /gpiodetect/,
    'libgpiod on Raspberry Pi',
  )
  assert.match(files['boards/rp2040.md']!, /BOOTSEL/, 'RP2040 UF2 flow')
  assert.match(files['boards/orange-pi.md']!, /RK3588S/, 'Orange Pi 5 SoC')
  assert.match(files['boards/radxa.md']!, /rsetup/, 'Radxa overlay tooling')
  assert.match(
    files['boards/stm32.md']!,
    /st-flash write firmware\.bin 0x8000000/,
    'ST-Link flash command',
  )
  assert.match(
    files['toolchains/platformio.md']!,
    /board = esp32dev/,
    'PlatformIO ESP32 board id',
  )
  assert.match(
    files['toolchains/arduino-cli.md']!,
    /arduino-cli compile --fqbn/,
    'Arduino CLI compile flow',
  )
  assert.match(files['toolchains/esp-idf.md']!, /idf\.py set-target/)
  assert.match(files['toolchains/micropython.md']!, /mpremote/)
  // Failure recovery is what separates a skill that works on hardware from
  // process advice. Measured against real sessions: the agent retried a denied
  // command four ways for twenty minutes, told the user to restart over a
  // recoverable lock, and called a black display "flashed successfully".
  const stuck = files['workflows/when-stuck.md']!
  assert.match(stuck, /prove NOTHING about behaviour/, 'flash success is not proof')
  assert.match(stuck, /NEVER re-run a failed command unchanged/, 'retry discipline')
  assert.match(stuck, /Two attempts per hypothesis/, 'bounded retry')
  assert.match(stuck, /\/resolve/, 'the unblock path, not a restart')
  assert.match(
    stuck,
    /what do you see/,
    'human as the ground truth for visuals',
  )
  assert.match(stuck, /espefuse summary/, 'authority on flash/PSRAM mode')

  assert.match(files['workflows/end-to-end.md']!, /espota/, 'OTA upload')
  assert.match(
    files['safety.md']!,
    /flyback/,
    'inductive-load safety guidance',
  )
})
