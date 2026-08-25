import assert from 'node:assert/strict'
import { test } from 'vitest'

// This file deliberately does NOT stub the build-time MACRO define.
//
// Importing the bundled registry must remain safe without the build-time
// define. Optional filesystem plugins such as iot-builder are not registered
// by this module.
test('bundled skills load and list without the build-time MACRO define', async () => {
  assert.equal(
    'MACRO' in globalThis,
    false,
    'precondition: this file must run without the MACRO stub',
  )

  const { getBundledSkills } = await import('./bundledSkills.js')
  const names = getBundledSkills().map((command) => command.name)

  assert.ok(!names.includes('iot-builder'), 'optional plugin is not bundled')
  assert.ok(names.includes('browser-automation'))
  assert.ok(names.includes('agenc-marketplace-kit-installer'))
})
