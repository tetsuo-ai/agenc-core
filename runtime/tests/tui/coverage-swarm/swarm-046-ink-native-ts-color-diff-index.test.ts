import Module from 'node:module'
import stripAnsi from 'strip-ansi'
import { afterEach, describe, expect, test, vi } from 'vitest'

type ColorDiffModule = typeof import('../ink/native-ts/color-diff/index.js')

const originalColorTerm = process.env.COLORTERM
const moduleWithLoad = Module as typeof Module & {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
}
const originalModuleLoad = moduleWithLoad._load

function restoreColorTerm(): void {
  if (originalColorTerm === undefined) {
    delete process.env.COLORTERM
  } else {
    process.env.COLORTERM = originalColorTerm
  }
}

async function loadColorDiff(): Promise<ColorDiffModule> {
  return await import('../ink/native-ts/color-diff/index.js')
}

function mockHighlightJs(api: {
  getLanguage: ReturnType<typeof vi.fn>
  highlight: ReturnType<typeof vi.fn>
}): void {
  moduleWithLoad._load = (request, parent, isMain) => {
    if (request === 'highlight.js') {
      return { default: api }
    }
    return originalModuleLoad(request, parent, isMain)
  }
}

describe('color-diff row 046 coverage', () => {
  afterEach(() => {
    restoreColorTerm()
    moduleWithLoad._load = originalModuleLoad
    vi.doUnmock('../../utils/log.js')
    vi.resetModules()
    vi.clearAllMocks()
  })

  test('renders plain files and unrecognized diff markers with the light theme fallback', async () => {
    delete process.env.COLORTERM

    const { ColorDiff, ColorFile, getSyntaxTheme } = await loadColorDiff()

    expect(getSyntaxTheme('plain')).toEqual({ theme: 'GitHub', source: null })

    const fileLines = new ColorFile(
      'plain text\nsecond line',
      'notes.unknown',
    ).render('light', 18, false)

    expect(fileLines).not.toBeNull()
    expect(fileLines!.map(line => stripAnsi(line))).toEqual([
      ' 1 plain text',
      ' 2 second line',
    ])

    const diffLines = new ColorDiff(
      {
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        lines: ['?untagged value'],
      },
      null,
      'notes.unknown',
    ).render('light', 18, false)

    expect(diffLines).not.toBeNull()
    expect(stripAnsi(diffLines![0]!)).toBe(' 2  untagged value')
  })

  test('falls back to plain output when a detected highlighter throws', async () => {
    vi.resetModules()

    const getLanguage = vi.fn(() => ({}))
    const highlight = vi.fn(() => {
      throw new Error('highlight failed')
    })
    mockHighlightJs({ getLanguage, highlight })

    const { ColorFile } = await loadColorDiff()

    const lines = new ColorFile('throwing line', 'sample.fake').render(
      'light',
      40,
      false,
    )

    expect(lines).not.toBeNull()
    expect(getLanguage).toHaveBeenCalledWith('fake')
    expect(highlight).toHaveBeenCalledWith('throwing line\n', {
      language: 'fake',
      ignoreIllegals: true,
    })
    expect(stripAnsi(lines![0]!)).toBe(' 1 throwing line')
  })

  test('logs malformed highlighter emitters only once before using plain output', async () => {
    vi.resetModules()

    const logError = vi.fn()
    vi.doMock('../../utils/log.js', () => ({ logError }))

    const getLanguage = vi.fn(() => ({}))
    const highlight = vi.fn(() => ({ emitter: { children: [] } }))
    mockHighlightJs({ getLanguage, highlight })

    const { ColorFile } = await loadColorDiff()

    const lines = new ColorFile('bad emitter\nagain', 'sample.fake').render(
      'dark',
      80,
      false,
    )

    expect(lines).not.toBeNull()
    expect(lines!.map(line => stripAnsi(line))).toEqual([
      ' 1 bad emitter',
      ' 2 again',
    ])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]![0]).toEqual(expect.any(Error))
    expect((logError.mock.calls[0]![0] as Error).message).toContain(
      'children',
    )
  })

  test('flattens mocked highlighter scope and kind nodes in rendered output', async () => {
    vi.resetModules()

    const getLanguage = vi.fn(() => ({}))
    const highlight = vi.fn(() => ({
      emitter: {
        rootNode: {
          children: [
            { kind: 'keyword', children: ['const'] },
            ' value = ',
            { scope: 'title.function', children: ['run'] },
          ],
        },
      },
    }))
    mockHighlightJs({ getLanguage, highlight })

    const { ColorFile } = await loadColorDiff()

    const lines = new ColorFile('ignored', 'sample.fake').render(
      'dark',
      80,
      false,
    )

    expect(lines).not.toBeNull()
    expect(stripAnsi(lines![0]!)).toBe(' 1 const value = run')
  })
})
