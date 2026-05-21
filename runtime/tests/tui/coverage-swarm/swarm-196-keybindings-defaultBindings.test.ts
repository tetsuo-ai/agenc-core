import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type { KeybindingBlock } from '../../../src/tui/keybindings/types.js'

const harness = vi.hoisted(() => ({
  features: new Set<string>(),
  platform: 'linux',
  runningWithBun: false,
  satisfiesCalls: [] as Array<{ range: string; version: string }>,
  satisfiesResult: false,
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../src/utils/platform.js', () => ({
  getPlatform: () => harness.platform,
}))

vi.mock('../../../src/utils/bundledMode.js', () => ({
  isRunningWithBun: () => harness.runningWithBun,
}))

vi.mock('../../../src/utils/semver.js', () => ({
  satisfies: (version: string, range: string) => {
    harness.satisfiesCalls.push({ range, version })
    return harness.satisfiesResult
  },
}))

const originalBunDescriptor = Object.getOwnPropertyDescriptor(
  process.versions,
  'bun',
)

function setBunVersion(version: string | undefined): void {
  Object.defineProperty(process.versions, 'bun', {
    configurable: true,
    value: version,
  })
}

function restoreBunVersion(): void {
  if (originalBunDescriptor) {
    Object.defineProperty(process.versions, 'bun', originalBunDescriptor)
    return
  }

  delete (process.versions as Record<string, string | undefined>).bun
}

async function loadDefaultBindings(): Promise<KeybindingBlock[]> {
  vi.resetModules()
  const module = await import(
    '../../../src/tui/keybindings/defaultBindings.js'
  )
  return module.DEFAULT_BINDINGS
}

function bindingsFor(
  blocks: KeybindingBlock[],
  context: KeybindingBlock['context'],
): Record<string, string | null> {
  const block = blocks.find(entry => entry.context === context)
  if (!block) throw new Error(`Missing ${context} default bindings`)
  return block.bindings
}

function hasContext(
  blocks: KeybindingBlock[],
  context: KeybindingBlock['context'],
): boolean {
  return blocks.some(entry => entry.context === context)
}

describe('default keybindings coverage swarm row 196', () => {
  beforeEach(() => {
    harness.features = new Set()
    harness.platform = 'linux'
    harness.runningWithBun = false
    harness.satisfiesCalls = []
    harness.satisfiesResult = false
    setBunVersion(undefined)
  })

  afterAll(() => {
    restoreBunVersion()
  })

  test('uses portable defaults without feature-gated bindings off Windows', async () => {
    const blocks = await loadDefaultBindings()
    const global = bindingsFor(blocks, 'Global')
    const chat = bindingsFor(blocks, 'Chat')

    expect(chat).toMatchObject({
      'ctrl+v': 'chat:imagePaste',
      'shift+tab': 'chat:cycleMode',
    })
    expect(chat).not.toHaveProperty('alt+v')
    expect(chat).not.toHaveProperty('meta+m')
    expect(chat).not.toHaveProperty('shift+up')
    expect(global).not.toHaveProperty('ctrl+shift+b')
    expect(global).not.toHaveProperty('ctrl+shift+f')
    expect(global).not.toHaveProperty('meta+j')
    expect(hasContext(blocks, 'MessageActions')).toBe(false)
    expect(harness.satisfiesCalls).toEqual([])
  })

  test('uses Windows fallbacks when Node terminal VT mode is unavailable', async () => {
    harness.platform = 'windows'
    harness.satisfiesResult = false

    const blocks = await loadDefaultBindings()
    const chat = bindingsFor(blocks, 'Chat')

    expect(chat).toMatchObject({
      'alt+v': 'chat:imagePaste',
      'meta+m': 'chat:cycleMode',
    })
    expect(chat).not.toHaveProperty('ctrl+v')
    expect(chat).not.toHaveProperty('shift+tab')
    expect(harness.satisfiesCalls).toEqual([
      {
        range: '>=22.17.0 <23.0.0 || >=24.2.0',
        version: process.versions.node,
      },
    ])
  })

  test('keeps shift tab on Windows when Node terminal VT mode is available', async () => {
    harness.platform = 'windows'
    harness.satisfiesResult = true

    const blocks = await loadDefaultBindings()
    const chat = bindingsFor(blocks, 'Chat')

    expect(chat).toMatchObject({
      'alt+v': 'chat:imagePaste',
      'shift+tab': 'chat:cycleMode',
    })
    expect(chat).not.toHaveProperty('meta+m')
  })

  test('checks Bun terminal VT support using fallback and explicit versions', async () => {
    harness.platform = 'windows'
    harness.runningWithBun = true
    harness.satisfiesResult = false

    const fallbackBlocks = await loadDefaultBindings()
    expect(bindingsFor(fallbackBlocks, 'Chat')).toMatchObject({
      'meta+m': 'chat:cycleMode',
    })
    expect(harness.satisfiesCalls).toEqual([
      { range: '>=1.2.23', version: '0.0.0' },
    ])

    harness.satisfiesCalls = []
    harness.satisfiesResult = true
    setBunVersion('1.2.23')

    const supportedBlocks = await loadDefaultBindings()
    expect(bindingsFor(supportedBlocks, 'Chat')).toMatchObject({
      'shift+tab': 'chat:cycleMode',
    })
    expect(harness.satisfiesCalls).toEqual([
      { range: '>=1.2.23', version: '1.2.23' },
    ])
  })

  test('adds global, chat, and modal bindings when feature flags are enabled', async () => {
    harness.features = new Set([
      'KAIROS',
      'QUICK_SEARCH',
      'TERMINAL_PANEL',
      'MESSAGE_ACTIONS',
    ])

    const allFlagBlocks = await loadDefaultBindings()
    expect(bindingsFor(allFlagBlocks, 'Global')).toMatchObject({
      'ctrl+shift+b': 'app:toggleBrief',
      'ctrl+shift+f': 'app:globalSearch',
      'cmd+shift+f': 'app:globalSearch',
      'ctrl+shift+p': 'app:quickOpen',
      'cmd+shift+p': 'app:quickOpen',
      'meta+j': 'app:toggleTerminal',
    })
    expect(bindingsFor(allFlagBlocks, 'Chat')).toMatchObject({
      'shift+up': 'chat:messageActions',
    })
    expect(bindingsFor(allFlagBlocks, 'MessageActions')).toMatchObject({
      up: 'messageActions:prev',
      down: 'messageActions:next',
      'meta+up': 'messageActions:top',
      'super+down': 'messageActions:bottom',
      enter: 'messageActions:enter',
      c: 'messageActions:c',
      p: 'messageActions:p',
    })

    harness.features = new Set(['KAIROS_BRIEF'])
    const briefFlagBlocks = await loadDefaultBindings()
    expect(bindingsFor(briefFlagBlocks, 'Global')).toMatchObject({
      'ctrl+shift+b': 'app:toggleBrief',
    })
    expect(hasContext(briefFlagBlocks, 'MessageActions')).toBe(false)
  })
})
