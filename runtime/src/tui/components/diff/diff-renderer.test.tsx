import figures from 'figures'
import React from 'react'
import type { StructuredPatchHunk } from 'diff'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { DiffData, DiffFile } from '../../hooks/useDiffData.js'
import { StructuredDiff } from './StructuredDiff.js'
import { StructuredDiffList } from './StructuredDiffList.js'
import { DiffDetailView } from './DiffDetailView.js'
import { DiffDialog } from './DiffDialog.js'
import { DiffFileList } from './DiffFileList.js'
import { FileEditToolDiff } from './FileEditToolDiff.js'

const hookState = vi.hoisted(
  (): {
    diffData: DiffData
    turnDiffs: unknown[]
  } => ({
    diffData: {
      stats: null,
      files: [],
      hunks: new Map(),
      loading: false,
    },
    turnDiffs: [],
  }),
)

const reactHookState = vi.hoisted(() => ({
  useValue: undefined as unknown,
}))

const fileEditMockState = vi.hoisted(() => ({
  openForScanCalls: [] as string[],
  patchInputs: [] as Array<{
    filePath: string
    fileContents: string
    edits: Array<{
      old_string: string
      new_string: string
      replace_all?: boolean
    }>
  }>,
  patchFromContentsInputs: [] as Array<{
    filePath: string
    oldContent: string
    newContent: string
  }>,
  openForScanCanOpen: false,
  readCappedContent: null as string | null,
  scanContext: null as {
    content: string
    lineOffset: number
    truncated: boolean
  } | null,
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const fake = {
    ...actual,
    memo: (component: unknown) => component,
    useContext: () => null,
    useEffect: vi.fn(),
    useLayoutEffect: vi.fn(),
    useMemo: (factory: () => unknown) => factory(),
    useRef: (initial: unknown) => ({ current: initial }),
    use: () => reactHookState.useValue,
    useState: <T,>(initial: T | (() => T)) =>
      [
        typeof initial === 'function' ? (initial as () => T)() : initial,
        vi.fn(),
      ] as const,
  }
  return {
    ...fake,
    default: fake,
  }
})

vi.mock('react-compiler-runtime', () => ({
  c: (size: number) =>
    Array.from({ length: size }, () =>
      Symbol.for('react.memo_cache_sentinel'),
    ),
}))

vi.mock('../../../services/analytics/growthbook.js', () => ({
  checkGate_CACHED_OR_BLOCKING: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getDynamicConfig_CACHED_MAY_BE_STALE: (
    _key: string,
    fallback: unknown,
  ) => fallback,
  getFeatureValue_CACHED_MAY_BE_STALE: (
    _key: string,
    fallback: unknown,
  ) => fallback,
}))

vi.mock('../../hooks/useDiffData', () => ({
  useDiffData: () => hookState.diffData,
}))

vi.mock('../../hooks/useTurnDiffs', () => ({
  useTurnDiffs: () => hookState.turnDiffs,
}))

vi.mock('../../context/overlayContext', () => ({
  useRegisterOverlay: vi.fn(),
}))

vi.mock('../../ink.js', async () => {
  const ReactModule = await import('react')
  const Passthrough = ({
    children,
  }: {
    children?: React.ReactNode
  }) => ReactModule.createElement(ReactModule.Fragment, null, children)
  return {
    Box: Passthrough,
    NoSelect: Passthrough,
    RawAnsi: ({ lines }: { lines: string[] }) =>
      ReactModule.createElement(ReactModule.Fragment, null, lines.join('\n')),
    Text: Passthrough,
    useInput: vi.fn(),
    useTheme: () => ['default'],
    wrapText: (input: string) => input,
  }
})

vi.mock('../ink.js', async () => {
  const ReactModule = await import('react')
  const Passthrough = ({
    children,
  }: {
    children?: React.ReactNode
  }) => ReactModule.createElement(ReactModule.Fragment, null, children)
  return {
    Box: Passthrough,
    NoSelect: Passthrough,
    RawAnsi: ({ lines }: { lines: string[] }) =>
      ReactModule.createElement(ReactModule.Fragment, null, lines.join('\n')),
    Text: Passthrough,
    useInput: vi.fn(),
    useTheme: () => ['default'],
    wrapText: (input: string) => input,
  }
})

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 120, rows: 40 }),
}))

vi.mock('../../hooks/useTerminalSize', () => ({
  useTerminalSize: () => ({ columns: 120, rows: 40 }),
}))

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ syntaxHighlightingDisabled: false }),
}))

vi.mock('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: vi.fn(),
  useKeybindings: vi.fn(),
}))

vi.mock('../../keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: (_action: string, _context: string, fallback: string) =>
    fallback,
}))

vi.mock('../../../utils/cwd.js', () => ({
  getCwd: () => '/tmp',
}))

vi.mock('../../../utils/file.js', () => ({
  addLineNumbers: ({ content }: { content: string }) => content,
  convertLeadingTabsToSpaces: (input: string) => input,
  readFileSyncCached: () => '',
  readFileSafe: () => undefined,
}))

vi.mock('../../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

vi.mock('../../../utils/sliceAnsi.js', () => ({
  default: (input: string, start: number, end?: number) =>
    input.slice(start, end),
}))

vi.mock('../../../utils/diff', () => ({
  CONTEXT_LINES: 3,
  adjustHunkLineNumbers: (hunks: StructuredPatchHunk[]) => hunks,
  getPatchForDisplay: (input: {
    filePath: string
    fileContents: string
    edits: Array<{
      old_string: string
      new_string: string
      replace_all?: boolean
    }>
  }) => {
    fileEditMockState.patchInputs.push(input)
    const edit = input.edits[0] ?? { old_string: '', new_string: '' }
    return [
      makeHunk(1, [`-${edit.old_string}`, `+${edit.new_string}`]),
    ]
  },
  getPatchFromContents: (input: {
    filePath: string
    oldContent: string
    newContent: string
  }) => {
    fileEditMockState.patchFromContentsInputs.push(input)
    return [
      makeHunk(1, [`-${input.oldContent}`, `+${input.newContent}`]),
    ]
  },
}))

vi.mock('../../../utils/readEditContext', () => ({
  CHUNK_SIZE: 4,
  openForScan: async (filePath: string) => {
    fileEditMockState.openForScanCalls.push(filePath)
    return fileEditMockState.openForScanCanOpen
      ? { close: vi.fn() }
      : null
  },
  readCapped: async () => fileEditMockState.readCappedContent,
  scanForContext: async () =>
    fileEditMockState.scanContext ?? {
      content: '',
      lineOffset: 1,
      truncated: true,
    },
}))

vi.mock('../../../utils/log', () => ({
  logError: vi.fn(),
}))

vi.mock('../design-system/Dialog', async () => {
  const { Box, Text } = await import('../../ink.js')
  return {
    Dialog: ({
      title,
      children,
      inputGuide,
    }: {
      title: React.ReactNode
      children: React.ReactNode
      inputGuide?: (exitState: {
        pending: boolean
        keyName: string
      }) => React.ReactNode
    }) => (
      <Box flexDirection="column">
        <Text>{title}</Text>
        {children}
        {inputGuide?.({ pending: false, keyName: 'esc' })}
      </Box>
    ),
  }
})

vi.mock('./StructuredDiff/colorDiff', () => ({
  expectColorDiff: () => null,
}))

function makeHunk(newStart: number, lines: string[]): StructuredPatchHunk {
  return {
    oldStart: newStart,
    oldLines: lines.filter(line => !line.startsWith('+')).length,
    newStart,
    newLines: lines.filter(line => !line.startsWith('-')).length,
    lines,
  }
}

function makeFile(path: string, index: number): DiffFile {
  return {
    path,
    linesAdded: index + 1,
    linesRemoved: index,
    isBinary: false,
    isLargeFile: false,
    isTruncated: false,
  }
}

// Execute these compiled TUI leaves against the hook mocks without booting Ink.
function renderPlain(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(renderPlain).join('')
  }
  if (React.isValidElement(node)) {
    if (typeof node.type === 'function') {
      const Component = node.type as (
        props: typeof node.props,
      ) => React.ReactNode
      return renderPlain(Component(node.props))
    }
    const element = node as React.ReactElement<{
      children?: React.ReactNode
    }>
    return renderPlain(element.props.children)
  }
  return ''
}

describe('diff renderer components', () => {
  beforeEach(() => {
    hookState.diffData = {
      stats: null,
      files: [],
      hunks: new Map(),
      loading: false,
    }
    hookState.turnDiffs = []
    reactHookState.useValue = undefined
    fileEditMockState.openForScanCalls = []
    fileEditMockState.patchInputs = []
    fileEditMockState.patchFromContentsInputs = []
    fileEditMockState.openForScanCanOpen = false
    fileEditMockState.readCappedContent = null
    fileEditMockState.scanContext = null
  })

  test('renders actual structured hunks with ellipsis separators', () => {
    const output = renderPlain(
      <StructuredDiffList
        hunks={[
          makeHunk(1, ['-old value', '+new value']),
          makeHunk(20, [' context', '-before', '+after']),
        ]}
        dim={false}
        width={72}
        filePath="src/app.ts"
        firstLine={null}
      />,
    )

    expect(output).toContain('old value')
    expect(output).toContain('new value')
    expect(output).toContain('...')
    expect(output).toContain('before')
    expect(output).toContain('after')
  })

  test('renders a structured diff hunk through the fallback renderer', () => {
    const output = renderPlain(
      <StructuredDiff
        patch={makeHunk(4, [' unchanged', '-before call()', '+after call()'])}
        dim={false}
        filePath="src/app.ts"
        firstLine={null}
        width={80}
        skipHighlighting
      />,
    )

    expect(output).toContain('before call()')
    expect(output).toContain('after call()')
  })

  test('paginates the file list around the selected file', () => {
    const files = Array.from({ length: 7 }, (_, index) =>
      makeFile(`src/file-${index}.ts`, index),
    )

    const output = renderPlain(
      <DiffFileList files={files} selectedIndex={3} />,
    )

    expect(output).toContain('1 more file')
    expect(output).toContain(`${figures.pointer} src/file-3.ts`)
    expect(output).toContain('+4 -3')
    expect(output).toContain('src/file-5.ts')
    expect(output).not.toContain('src/file-0.ts')
    expect(output).not.toContain('src/file-6.ts')
  })

  test('renders detail states for empty, binary, and untracked files', () => {
    const empty = renderPlain(
      <DiffDetailView filePath="src/empty.ts" hunks={[]} />,
    )
    const binary = renderPlain(
      <DiffDetailView filePath="assets/logo.png" hunks={[]} isBinary />,
    )
    const untracked = renderPlain(
      <DiffDetailView filePath="docs/new.md" hunks={[]} isUntracked />,
    )

    expect(empty).toContain('src/empty.ts')
    expect(empty).toContain('No diff content')
    expect(binary).toContain('Binary file - cannot display diff')
    expect(untracked).toContain('New file not yet staged.')
    expect(untracked).toContain('Run `git add docs/new.md`')
  })

  test('renders the current diff dialog list from diff data', () => {
    hookState.diffData = {
      stats: {
        filesCount: 2,
        linesAdded: 5,
        linesRemoved: 3,
      },
      files: [makeFile('src/a.ts', 2), makeFile('src/b.ts', 1)],
      hunks: new Map(),
      loading: false,
    }

    const output = renderPlain(
      <DiffDialog messages={[]} onDone={() => {}} />,
    )

    expect(output).toContain('Uncommitted changes')
    expect(output).toContain('(git diff HEAD)')
    expect(output).toContain('2 files changed')
    expect(output).toContain('+5')
    expect(output).toContain('-3')
    expect(output).toContain('src/a.ts')
    expect(output).toContain('Enter view')
    expect(output).toContain('esc close')
  })

  test('FileEditToolDiff filters invalid edits and skips file reads for large edit input', async () => {
    const node = FileEditToolDiff({
      file_path: 'src/edit.ts',
      edits: [
        { old_string: null, new_string: 'skip' },
        { old_string: 'abcd', new_string: 'wxyz' },
      ] as never,
    }) as React.ReactElement<{
      children: React.ReactElement<{ promise: Promise<unknown> }>
    }>
    const body = node.props.children
    const diffData = await body.props.promise

    expect(fileEditMockState.openForScanCalls).toEqual([])
    expect(fileEditMockState.patchFromContentsInputs).toMatchObject([
      { oldContent: 'abcd', newContent: 'wxyz' },
    ])

    reactHookState.useValue = diffData
    const output = renderPlain(body)

    expect(output).toContain('abcd')
    expect(output).toContain('wxyz')
  })

  test('FileEditToolDiff falls back to tool input diff when the file cannot be opened', async () => {
    const node = FileEditToolDiff({
      file_path: 'src/missing.ts',
      edits: [{ old_string: 'xy', new_string: 'zz' }],
    }) as React.ReactElement<{
      children: React.ReactElement<{ promise: Promise<unknown> }>
    }>
    const body = node.props.children
    const diffData = await body.props.promise

    expect(fileEditMockState.openForScanCalls).toEqual(['src/missing.ts'])
    expect(fileEditMockState.patchFromContentsInputs[0]?.oldContent).toBe('xy')
    expect(fileEditMockState.patchFromContentsInputs[0]?.newContent).toBe('zz')

    reactHookState.useValue = diffData
    const output = renderPlain(body)

    expect(output).toContain('xy')
    expect(output).toContain('zz')
  })

  test('FileEditToolDiff normalizes permission preview edits before display patching', async () => {
    async function loadPatchInput(
      edit: { old_string: string; new_string: string; replace_all?: boolean },
      content: string,
    ) {
      fileEditMockState.openForScanCanOpen = true
      fileEditMockState.scanContext = {
        content,
        lineOffset: 1,
        truncated: false,
      }
      fileEditMockState.readCappedContent = content
      fileEditMockState.patchFromContentsInputs = []
      const node = FileEditToolDiff({
        file_path: 'src/preview.md',
        edits: [edit],
      }) as React.ReactElement<{
        children: React.ReactElement<{ promise: Promise<unknown> }>
      }>
      await node.props.children.props.promise
      return fileEditMockState.patchFromContentsInputs[0]
    }

    await expect(
      loadPatchInput(
        { old_string: 'a-b', new_string: 'c-d' },
        'a—b\n',
      ),
    ).resolves.toMatchObject({
      oldContent: 'a—b\n',
      newContent: 'c-d\n',
    })

    await expect(
      loadPatchInput(
        { old_string: 'x y', new_string: 'z y' },
        'x y\n',
      ),
    ).resolves.toMatchObject({
      oldContent: 'x y\n',
      newContent: 'z y\n',
    })

    await expect(
      loadPatchInput(
        { old_string: '"x"', new_string: '"y"' },
        '“x”\n',
      ),
    ).resolves.toMatchObject({
      oldContent: '“x”\n',
      newContent: '“y”\n',
    })

    await expect(
      loadPatchInput(
        { old_string: 'be', new_string: '' },
        'alpha be\ngamma\n',
      ),
    ).resolves.toMatchObject({
      oldContent: 'alpha be\ngamma\n',
      newContent: 'alpha gamma\n',
    })

    await expect(
      loadPatchInput(
        { old_string: 'fo', new_string: 'ba', replace_all: true },
        'fo fo\n',
      ),
    ).resolves.toMatchObject({
      oldContent: 'fo fo\n',
      newContent: 'ba ba\n',
    })
  })

  test('FileEditToolDiff falls back to full-file normalized matching when raw scan misses', async () => {
    fileEditMockState.openForScanCanOpen = true
    fileEditMockState.scanContext = {
      content: '',
      lineOffset: 1,
      truncated: false,
    }
    fileEditMockState.readCappedContent = 'a—b\n'

    const node = FileEditToolDiff({
      file_path: 'src/preview.md',
      edits: [{ old_string: 'a-b', new_string: 'c-d' }],
    }) as React.ReactElement<{
      children: React.ReactElement<{ promise: Promise<unknown> }>
    }>
    await node.props.children.props.promise

    expect(fileEditMockState.patchFromContentsInputs[0]).toMatchObject({
      oldContent: 'a—b\n',
      newContent: 'c-d\n',
    })
  })

  test('FileEditToolDiff previews all replace_all matches outside the scanned context window', async () => {
    fileEditMockState.openForScanCanOpen = true
    fileEditMockState.readCappedContent =
      'a—b\n' + 'middle\n'.repeat(40) + 'a–b\n'
    fileEditMockState.scanContext = {
      content: 'a—b\nmiddle\nmiddle\n',
      lineOffset: 1,
      truncated: false,
    }

    const node = FileEditToolDiff({
      file_path: 'src/preview.md',
      edits: [{ old_string: 'a-b', new_string: 'c-d', replace_all: true }],
    }) as React.ReactElement<{
      children: React.ReactElement<{ promise: Promise<unknown> }>
    }>
    await node.props.children.props.promise

    expect(fileEditMockState.patchFromContentsInputs[0]).toMatchObject({
      oldContent: 'a—b\n' + 'middle\n'.repeat(40) + 'a–b\n',
      newContent: 'c-d\n' + 'middle\n'.repeat(40) + 'c-d\n',
    })
  })
})
