import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveHomeContext } from '../../src/config/home.ts'

const originalHome = process.env.AGENC_HOME
const originalConfigDir = process.env.AGENC_CONFIG_DIR
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agenc-env-test-'))
  process.env.AGENC_HOME = tempDir
  delete process.env.AGENC_CONFIG_DIR
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.AGENC_HOME
  else process.env.AGENC_HOME = originalHome
  if (originalConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR
  else process.env.AGENC_CONFIG_DIR = originalConfigDir
})

test('HomeContext resolves state.json under explicit AGENC_HOME', () => {
  expect(resolveHomeContext({ AGENC_HOME: tempDir }).statePath).toBe(
    join(tempDir, 'state.json'),
  )
})

test('legacy global JSON files never change the canonical state path', () => {
  writeFileSync(join(tempDir, '.config.json'), '{}')
  writeFileSync(join(tempDir, '.agenc.json'), '{}')
  expect(resolveHomeContext({ AGENC_HOME: tempDir }).statePath).toBe(
    join(tempDir, 'state.json'),
  )
})

test('AGENC_CONFIG_DIR is rejected instead of taking precedence', () => {
  process.env.AGENC_CONFIG_DIR = join(tempDir, 'legacy')
  expect(() => resolveHomeContext(process.env)).toThrow(
    'AGENC_CONFIG_DIR is no longer a runtime configuration authority',
  )
})
