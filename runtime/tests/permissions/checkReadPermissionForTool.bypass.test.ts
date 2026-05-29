import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import type { Tool, ToolPermissionContext } from '../tools/Tool.js'
import { checkReadPermissionForTool } from '../utils/permissions/filesystem.js'

// Minimal Tool stub exposing getPath, matching the shape checkReadPermissionForTool
// requires. Only the fields the read permission check reads are populated.
function readTool(): Tool {
  return {
    name: 'FileRead',
    getPath(input: { [key: string]: unknown }): string {
      return String(input.file_path ?? '')
    },
  } as unknown as Tool
}

function context(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  } as ToolPermissionContext
}

describe('checkReadPermissionForTool under bypassPermissions', () => {
  let root = ''
  // MACRO is an esbuild/tsup build-time define, undefined under vitest. The
  // auto-allow case reaches getBundledSkillsRoot() which dereferences
  // MACRO.VERSION, so define a stand-in to keep that path from throwing
  // `ReferenceError: MACRO is not defined`.
  const hadMacro = 'MACRO' in globalThis
  const priorMacro = (globalThis as { MACRO?: unknown }).MACRO

  beforeAll(() => {
    ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
  })

  afterAll(() => {
    if (hadMacro) {
      ;(globalThis as { MACRO?: unknown }).MACRO = priorMacro
    } else {
      delete (globalThis as { MACRO?: unknown }).MACRO
    }
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agenc-filesystem-read-'))
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
  })

  // Regression: audit #3 — bypassPermissions / --yolo must not short-circuit
  // to allow before the read-specific Deny(Read(...)) rule loop runs.
  //
  // A bare-name deny pattern (no leading slash) is matched anywhere via
  // gitignore semantics, keeping the assertion independent of the settings
  // root / cwd that an absolute-path pattern would resolve against.
  test('explicit Deny(Read) rule still denies under bypassPermissions', () => {
    const tool = readTool()

    const result = checkReadPermissionForTool(
      tool,
      { file_path: 'agenc-deny-marker.secret' },
      context({
        mode: 'bypassPermissions',
        alwaysDenyRules: { session: ['FileRead(agenc-deny-marker.secret)'] },
      }),
    )

    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('rule')
  })

  // Baseline: with no deny rule, bypass still auto-allows a path that would
  // otherwise prompt (outside the working directory).
  test('reads with no deny rule are auto-allowed under bypassPermissions', () => {
    const target = join(root, 'anywhere.txt')
    const tool = readTool()

    const result = checkReadPermissionForTool(
      tool,
      { file_path: target },
      context({ mode: 'bypassPermissions' }),
    )

    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toEqual({
      type: 'mode',
      mode: 'bypassPermissions',
    })
  })

  // Prior valid behavior is preserved: a read deny rule still denies in the
  // default (non-bypass) mode.
  test('explicit Deny(Read) rule still denies in default mode', () => {
    const tool = readTool()

    const result = checkReadPermissionForTool(
      tool,
      { file_path: 'agenc-deny-marker.secret' },
      context({
        mode: 'default',
        alwaysDenyRules: { session: ['FileRead(agenc-deny-marker.secret)'] },
      }),
    )

    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('rule')
  })
})
