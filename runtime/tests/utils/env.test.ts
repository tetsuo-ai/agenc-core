import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalEnv = {
  AGENC_CONFIG_DIR: process.env.AGENC_CONFIG_DIR,
  AGENC_CUSTOM_OAUTH_URL: process.env.AGENC_CUSTOM_OAUTH_URL,
  USER_TYPE: process.env.USER_TYPE,
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agenc-env-test-'))
  process.env.AGENC_CONFIG_DIR = tempDir
  delete process.env.AGENC_CUSTOM_OAUTH_URL
  delete process.env.USER_TYPE
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (originalEnv.AGENC_CONFIG_DIR === undefined) {
    delete process.env.AGENC_CONFIG_DIR
  } else {
    process.env.AGENC_CONFIG_DIR = originalEnv.AGENC_CONFIG_DIR
  }
  if (originalEnv.AGENC_CUSTOM_OAUTH_URL === undefined) {
    delete process.env.AGENC_CUSTOM_OAUTH_URL
  } else {
    process.env.AGENC_CUSTOM_OAUTH_URL = originalEnv.AGENC_CUSTOM_OAUTH_URL
  }
  if (originalEnv.USER_TYPE === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalEnv.USER_TYPE
  }
})

async function importFreshEnvModule() {
  return import(`../../src/utils/env.ts?ts=${Date.now()}-${Math.random()}`)
}

// getGlobalAgenCFile — three migration branches

test('getGlobalAgenCFile: new install returns .agenc.json when neither file exists', async () => {
  const { getGlobalAgenCFile } = await importFreshEnvModule()
  expect(getGlobalAgenCFile()).toBe(join(tempDir, '.agenc.json'))
})

test('getGlobalAgenCFile: existing user keeps .agenc.json when only legacy file exists', async () => {
  writeFileSync(join(tempDir, '.agenc.json'), '{}')
  const { getGlobalAgenCFile } = await importFreshEnvModule()
  expect(getGlobalAgenCFile()).toBe(join(tempDir, '.agenc.json'))
})

test('getGlobalAgenCFile: migrated user uses .agenc.json when both files exist', async () => {
  writeFileSync(join(tempDir, '.agenc.json'), '{}')
  writeFileSync(join(tempDir, '.agenc.json'), '{}')
  const { getGlobalAgenCFile } = await importFreshEnvModule()
  expect(getGlobalAgenCFile()).toBe(join(tempDir, '.agenc.json'))
})
