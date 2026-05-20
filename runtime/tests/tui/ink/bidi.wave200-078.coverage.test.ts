import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const originalEnv = { ...process.env }
const originalPlatform = process.platform

type TestClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

function char(value: string, styleId: number): TestClusteredChar {
  return {
    value,
    width: 1,
    styleId,
    hyperlink: styleId % 2 === 0 ? `https://agenc.test/${styleId}` : undefined,
  }
}

async function importFreshBidiModule() {
  vi.resetModules()
  return import('./bidi.ts')
}

describe('bidi wave200-078 coverage', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env['WT_SESSION']
    process.env['TERM_PROGRAM'] = 'vscode'
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    })
    vi.resetModules()
  })

  test('reorders RTL clusters only when software bidi is needed', async () => {
    const { reorderBidi } = await importFreshBidiModule()

    const empty: TestClusteredChar[] = []
    expect(reorderBidi(empty)).toBe(empty)

    const ltr = [char('a', 1), char('b', 2), char('c', 3)]
    expect(reorderBidi(ltr)).toBe(ltr)

    const mixed = [
      char('a', 1),
      char(' ', 2),
      char('א', 3),
      char('ב', 4),
      char('ג', 5),
      char(' ', 6),
      char('b', 7),
    ]

    const reordered = reorderBidi(mixed)

    expect(reordered).not.toBe(mixed)
    expect(reordered.map(c => c.value).join('')).toBe('a גבא b')
    expect(reordered.map(c => c.styleId)).toEqual([1, 2, 5, 4, 3, 6, 7])
    expect(reordered.map(c => c.hyperlink)).toEqual([
      undefined,
      'https://agenc.test/2',
      undefined,
      'https://agenc.test/4',
      undefined,
      'https://agenc.test/6',
      undefined,
    ])

    expect(
      reorderBidi([char('x', 8), char('ش', 9), char('س', 10)]).map(
        c => c.value,
      ),
    ).toEqual(['x', 'س', 'ش'])
  })
})
