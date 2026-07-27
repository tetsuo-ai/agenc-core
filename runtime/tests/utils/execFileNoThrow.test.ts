import { expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from '../../src/utils/execFileNoThrow.ts'

test('execFileNoThrowWithCwd rejects shell-like executable names', async () => {
  const result = await execFileNoThrowWithCwd('agenc && whoami', [])

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe executable')
})

test('execFileNoThrowWithCwd rejects cwd values with control characters', async () => {
  const result = await execFileNoThrowWithCwd(process.execPath, ['--version'], {
    cwd: 'C:\\repo\nmalicious',
  })

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe working directory')
})

test('execFileNoThrowWithCwd rejects arguments with control characters', async () => {
  const result = await execFileNoThrowWithCwd(process.execPath, [
    '--version\nmalicious',
  ])

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe argument')
})

test('execFileNoThrowWithCwd rejects environment entries with control characters', async () => {
  const result = await execFileNoThrowWithCwd(process.execPath, ['--version'], {
    env: {
      ...process.env,
      BAD_ENV: 'line1\nline2',
    },
  })

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe environment')
})
