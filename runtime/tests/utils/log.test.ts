import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { _loadLogListForTesting } from '../../src/utils/log.ts'

const tempDirs: string[] = []

async function makeLogDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agenc-log-list-'))
  tempDirs.push(dir)
  return dir
}

function validLog(prompt: string): string {
  return JSON.stringify([
    {
      type: 'user',
      timestamp: '2026-04-02T00:00:00.000Z',
      message: { role: 'user', content: prompt },
    },
  ])
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  )
})

test('loadLogList skips a corrupt log file and still returns the valid ones', async () => {
  const dir = await makeLogDir()
  await writeFile(join(dir, 'good-a.json'), validLog('first valid prompt'))
  // A partial/corrupt write — e.g. from a crashed fire-and-forget persist.
  await writeFile(join(dir, 'corrupt.json'), '{ this is not valid json')
  await writeFile(join(dir, 'good-b.json'), validLog('second valid prompt'))

  const logs = await _loadLogListForTesting(dir)

  // Must not throw, and the two valid logs must still load even though one
  // file in the same directory is unparseable.
  expect(logs).toHaveLength(2)
  const prompts = logs.map(l => l.firstPrompt).sort()
  expect(prompts).toEqual(['first valid prompt', 'second valid prompt'])
})

test('loadLogList returns [] for a missing directory without throwing', async () => {
  const dir = await makeLogDir()
  const missing = join(dir, 'does-not-exist')

  await expect(_loadLogListForTesting(missing)).resolves.toEqual([])
})
