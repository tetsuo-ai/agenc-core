import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from '../session/runtime-options.js'
import { createPrivateTempFile } from './tempfile.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('createPrivateTempFile', () => {
  it('creates private session-isolated artifacts and removes only their directories', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'agenc-private-temp-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'agenc-private-temp-b-'))
    roots.push(rootA, rootB)
    const sibling = join(rootA, 'keep')
    mkdirSync(sibling)

    const create = async (root: string, content: string) =>
      runWithAgentRuntimeOptions(
        resolveAgentRuntimeOptions({}, { sessionTempRoot: root }),
        async () => {
          await Promise.resolve()
          return createPrivateTempFile({
            prefix: 'agenc-confidential',
            extension: '.txt',
            content,
          })
        },
      )

    const [artifactA, artifactB] = await Promise.all([
      create(rootA, 'private-a'),
      create(rootB, 'private-b'),
    ])

    expect(artifactA.path.startsWith(`${rootA}${sep}`)).toBe(true)
    expect(artifactB.path.startsWith(`${rootB}${sep}`)).toBe(true)
    expect(readFileSync(artifactA.path, 'utf8')).toBe('private-a')
    expect(readFileSync(artifactB.path, 'utf8')).toBe('private-b')
    if (process.platform !== 'win32') {
      expect(statSync(artifactA.directory).mode & 0o777).toBe(0o700)
      expect(statSync(artifactA.path).mode & 0o777).toBe(0o600)
    }

    artifactA.dispose()
    expect(existsSync(artifactA.directory)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
    expect(existsSync(artifactB.path)).toBe(true)

    artifactB.dispose()
    expect(existsSync(artifactB.directory)).toBe(false)
  })

  it('rejects path separators in artifact names', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-private-temp-name-'))
    roots.push(root)
    const runtimeOptions = resolveAgentRuntimeOptions(
      {},
      { sessionTempRoot: root },
    )

    expect(() =>
      runWithAgentRuntimeOptions(runtimeOptions, () =>
        createPrivateTempFile({ content: 'secret', prefix: '../escape' }),
      ),
    ).toThrow(/prefix contains unsupported characters/u)
  })
})
