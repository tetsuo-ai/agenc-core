import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { createEmptyToolPermissionContext } from '../../../../permissions/types.js'
import { SESSION_ALLOWED_ROOTS_ARG } from '../../../../tools/system/filesystem.js'
import { __useFilePermissionDialogTest } from './useFilePermissionDialog.js'

describe('useFilePermissionDialog allow input handling', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
    )
  })

  async function makeFile(): Promise<{ root: string; file: string }> {
    const root = await mkdtemp(join(tmpdir(), 'agenc-file-permission-'))
    roots.push(root)
    const file = join(root, 'secret.txt')
    await writeFile(file, 'secret\n', 'utf8')
    return { root, file }
  }

  test('accept-once for an outside file carries a transient allowed root', async () => {
    const { root, file } = await makeFile()
    const context = createEmptyToolPermissionContext()

    const result = __useFilePermissionDialogTest.mergeAllowInput(
      { file_path: file },
      { file_path: file },
      file,
      context,
    )

    const allowedRoots = result[SESSION_ALLOWED_ROOTS_ARG]
    expect(Array.isArray(allowedRoots)).toBe(true)
    expect(allowedRoots).toContain(await realpath(root))
  })

  test('transient roots preserve parsed dialog edits over raw updated input', async () => {
    const { file } = await makeFile()
    const context = createEmptyToolPermissionContext()

    const result = __useFilePermissionDialogTest.mergeAllowInput(
      { file_path: file, content: 'edited content' },
      { file_path: file, content: 'raw content' },
      file,
      context,
    )

    expect(result.content).toBe('edited content')
    expect(result[SESSION_ALLOWED_ROOTS_ARG]).toEqual(
      expect.arrayContaining([expect.any(String)]),
    )
  })

  test('files already inside an allowed working directory are left unchanged', async () => {
    const { root, file } = await makeFile()
    const context = createEmptyToolPermissionContext({
      additionalWorkingDirectories: new Map([
        [root, { path: root, source: 'session' }],
      ]),
    })

    const result = __useFilePermissionDialogTest.mergeAllowInput(
      { file_path: file },
      { file_path: file },
      file,
      context,
    )

    expect(result[SESSION_ALLOWED_ROOTS_ARG]).toBeUndefined()
  })

  test('allow input wrapper does not mutate the shared confirmation callback', async () => {
    const { file } = await makeFile()
    const context = createEmptyToolPermissionContext()
    const originalOnAllow = vi.fn()
    const toolUseConfirm = {
      input: { file_path: file, content: 'raw content' },
      onAllow: originalOnAllow,
    } as any

    const wrapped = __useFilePermissionDialogTest.withMergedAllowInput(
      toolUseConfirm,
      { file_path: file, content: 'parsed content' },
      file,
      context,
    )

    expect(toolUseConfirm.onAllow).toBe(originalOnAllow)

    const contentBlocks = [{ type: 'text', text: 'extra' }]
    wrapped.onAllow(
      { file_path: file, content: 'raw content' },
      [],
      'feedback',
      contentBlocks as any,
    )

    expect(originalOnAllow).toHaveBeenCalledWith(
      expect.objectContaining({
        file_path: file,
        content: 'parsed content',
        [SESSION_ALLOWED_ROOTS_ARG]: expect.arrayContaining([expect.any(String)]),
      }),
      [],
      'feedback',
      contentBlocks,
    )
  })
})
