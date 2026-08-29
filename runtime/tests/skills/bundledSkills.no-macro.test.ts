import assert from 'node:assert/strict'
import { test } from 'vitest'

// This file deliberately does NOT stub the build-time MACRO define.
//
// Registration happens at module load, and a bundled skill that ships `files`
// used to resolve its extraction directory (MACRO.VERSION) right there — so
// merely importing this module threw wherever MACRO was absent and took every
// bundled skill down with it: the `/skills` listing and the command palette
// both silently lost browser-automation, iot-builder, and the kit installer.
// `skillRoot` is a lazy getter now; nothing reads MACRO until a skill is
// actually invoked and its files are extracted.
test('bundled skills load and list without the build-time MACRO define', async () => {
  assert.equal(
    'MACRO' in globalThis,
    false,
    'precondition: this file must run without the MACRO stub',
  )

  const { getBundledSkills } = await import('./bundledSkills.js')
  const names = getBundledSkills().map((command) => command.name)

  assert.ok(names.includes('iot-builder'), 'skill with files is registered')
  assert.ok(names.includes('browser-automation'))
  assert.ok(names.includes('agenc-marketplace-kit-installer'))
})
