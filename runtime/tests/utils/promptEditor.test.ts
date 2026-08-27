import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execSyncMock = vi.hoisted(() => vi.fn())
const inkInstanceMock = vi.hoisted(() => ({
  pause: vi.fn(),
  suspendStdin: vi.fn(),
  resumeStdin: vi.fn(),
  resume: vi.fn(),
  enterAlternateScreen: vi.fn(),
  exitAlternateScreen: vi.fn(),
}))
const instancesMock = vi.hoisted(() => ({
  get: vi.fn(() => inkInstanceMock),
}))

vi.mock('../../src/utils/execSyncWrapper.js', () => ({
  execSync_DEPRECATED: execSyncMock,
}))

vi.mock('../../src/tui/ink/instances.js', () => ({
  default: instancesMock,
}))

vi.mock('../../src/utils/editor.js', () => ({
  classifyGuiEditor: () => 'code',
  getExternalEditor: () => 'code',
}))

import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from '../../src/session/runtime-options.js'
import { editPromptInEditor } from '../../src/utils/promptEditor.js'

let sessionTempRoot = ''

beforeEach(() => {
  sessionTempRoot = mkdtempSync(join(tmpdir(), 'agenc-prompt-editor-temp-'))
  execSyncMock.mockReset()
  instancesMock.get.mockClear()
})

afterEach(() => {
  rmSync(sessionTempRoot, { recursive: true, force: true })
})

describe('editPromptInEditor', () => {
  it('uses a private exclusive artifact and removes its exact directory', () => {
    const sibling = join(sessionTempRoot, 'keep')
    mkdirSync(sibling)
    let editorPath = ''
    execSyncMock.mockImplementation((command: string) => {
      const match = /"([^"]+)"$/u.exec(command)
      if (match?.[1] === undefined) throw new Error('missing editor path')
      editorPath = match[1]
      expect(readFileSync(editorPath, 'utf8')).toBe('confidential prompt')
      if (process.platform !== 'win32') {
        expect(statSync(dirname(editorPath)).mode & 0o777).toBe(0o700)
        expect(statSync(editorPath).mode & 0o777).toBe(0o600)
      }
      writeFileSync(editorPath, 'edited prompt\n', 'utf8')
      return Buffer.alloc(0)
    })
    const runtimeOptions = resolveAgentRuntimeOptions(
      {},
      { sessionTempRoot },
    )

    const result = runWithAgentRuntimeOptions(runtimeOptions, () =>
      editPromptInEditor('confidential prompt'),
    )

    expect(result).toEqual({ content: 'edited prompt' })
    expect(editorPath.startsWith(sessionTempRoot)).toBe(true)
    expect(existsSync(dirname(editorPath))).toBe(false)
    expect(existsSync(sibling)).toBe(true)
  })
})
