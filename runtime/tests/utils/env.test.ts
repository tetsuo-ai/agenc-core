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

// AGENC_HOME unification: the secrets-bearing global config must resolve from
// the same home AGENC_HOME selects for config.toml/auth.json, instead of being
// stranded at $HOME. (os.homedir() ignores $HOME under Bun, so these write the
// file at the AGENC_HOME location to stay deterministic regardless of the real
// home — which also exercises the resolved-path-exists branch.)
test('getGlobalAgenCFile: AGENC_HOME is honored instead of being ignored', async () => {
  const savedConfigDir = process.env.AGENC_CONFIG_DIR
  const savedHome = process.env.AGENC_HOME
  const agencHome = mkdtempSync(join(tmpdir(), 'agenc-home-'))
  try {
    delete process.env.AGENC_CONFIG_DIR
    process.env.AGENC_HOME = agencHome
    writeFileSync(join(agencHome, '.agenc.json'), '{}')
    const { getGlobalAgenCFile } = await importFreshEnvModule()
    // Before the fix this returned $HOME/.agenc.json (AGENC_HOME ignored),
    // splitting provider keys away from config.toml.
    expect(getGlobalAgenCFile()).toBe(join(agencHome, '.agenc.json'))
  } finally {
    rmSync(agencHome, { recursive: true, force: true })
    if (savedConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR
    else process.env.AGENC_CONFIG_DIR = savedConfigDir
    if (savedHome === undefined) delete process.env.AGENC_HOME
    else process.env.AGENC_HOME = savedHome
  }
})

test('getGlobalAgenCFile: AGENC_CONFIG_DIR takes precedence over AGENC_HOME', async () => {
  const savedConfigDir = process.env.AGENC_CONFIG_DIR
  const savedHome = process.env.AGENC_HOME
  const configDir = mkdtempSync(join(tmpdir(), 'agenc-cfg-'))
  const agencHome = mkdtempSync(join(tmpdir(), 'agenc-home-'))
  try {
    process.env.AGENC_CONFIG_DIR = configDir
    process.env.AGENC_HOME = agencHome
    const { getGlobalAgenCFile } = await importFreshEnvModule()
    expect(getGlobalAgenCFile()).toBe(join(configDir, '.agenc.json'))
  } finally {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(agencHome, { recursive: true, force: true })
    if (savedConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR
    else process.env.AGENC_CONFIG_DIR = savedConfigDir
    if (savedHome === undefined) delete process.env.AGENC_HOME
    else process.env.AGENC_HOME = savedHome
  }
})
