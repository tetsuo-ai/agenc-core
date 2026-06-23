import { execFileSync } from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SUBPROCESS_SECRET_ENV, subprocessEnv } from 'src/utils/subprocessEnv.js'
import { SECRET_ENV_KEYS } from 'src/utils/providerSecrets.js'

// Security regression: the env handed to every Bash / MCP-stdio / hook /
// shell-snapshot / LSP child goes through subprocessEnv(). By DEFAULT (with
// AGENC_SUBPROCESS_ENV_SCRUB unset) the agent's provider keys and CI/cloud
// credentials must NOT reach those children — provider calls happen in-process,
// so a model-run or prompt-injected `printenv` must not be able to exfiltrate
// them. Benign vars (PATH) must still pass through so subprocesses can run.

const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  OPENAI_API_KEY: 'sk-openai-secret',
  XAI_API_KEY: 'xai-secret',
  GROK_API_KEY: 'grok-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  AWS_SESSION_TOKEN: 'aws-session-secret',
  GITHUB_TOKEN: 'gh-secret',
  GH_TOKEN: 'gh-cli-secret',
  AGENC_OAUTH_TOKEN: 'oauth-secret',
}

const TOUCHED_KEYS = [
  ...Object.keys(SECRETS),
  'AGENC_SUBPROCESS_ENV_SCRUB',
  'AGENC_SUBPROCESS_ENV_NO_SCRUB',
  'INPUT_ANTHROPIC_API_KEY',
]

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of TOUCHED_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  // DEFAULT config: scrub flag explicitly unset (this is the production default).
  for (const [key, value] of Object.entries(SECRETS)) {
    process.env[key] = value
  }
  // The action also duplicates secrets as INPUT_<NAME>.
  process.env.INPUT_ANTHROPIC_API_KEY = 'sk-ant-input-secret'
})

afterEach(() => {
  for (const key of TOUCHED_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
})

describe('subprocessEnv default-scrub (no AGENC_SUBPROCESS_ENV_SCRUB)', () => {
  it('strips provider keys + cloud/CI tokens from the child env by default', () => {
    expect(process.env.AGENC_SUBPROCESS_ENV_SCRUB).toBeUndefined()

    const childEnv = subprocessEnv()

    for (const key of Object.keys(SECRETS)) {
      expect(childEnv[key], `${key} must be scrubbed from child env`).toBeUndefined()
    }
    expect(childEnv.INPUT_ANTHROPIC_API_KEY).toBeUndefined()

    // Benign vars must survive so subprocesses can actually run.
    expect(childEnv.PATH).toBe(process.env.PATH)
  })

  it('does not mutate the parent process.env (in-process API calls keep keys)', () => {
    subprocessEnv()
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret')
    expect(process.env.XAI_API_KEY).toBe('xai-secret')
  })

  it('a real child spawned with subprocessEnv() cannot read the secrets', () => {
    // Mirrors the spawn sites (Shell/hooks/ShellSnapshot/MCP-stdio/LSP) which
    // do `env: { ...subprocessEnv(), ... }`. A prompt-injected `printenv` here
    // must come back empty for every secret.
    const probe =
      'process.stdout.write(' +
      JSON.stringify(Object.keys(SECRETS)) +
      '.map((k) => k + "=" + (process.env[k] ?? "")).join("\\n"))'

    const out = execFileSync(process.execPath, ['-e', probe], {
      env: subprocessEnv() as NodeJS.ProcessEnv,
      encoding: 'utf8',
    })

    for (const key of Object.keys(SECRETS)) {
      expect(out, `${key} must not leak to a spawned child`).toContain(`${key}=`)
      expect(out).not.toContain(`${key}=${SECRETS[key]}`)
    }
  })

  it('honors the deliberate opt-out (AGENC_SUBPROCESS_ENV_NO_SCRUB)', () => {
    process.env.AGENC_SUBPROCESS_ENV_NO_SCRUB = '1'
    const childEnv = subprocessEnv()
    // Opt-out restores inheritance for trusted setups that need it.
    expect(childEnv.ANTHROPIC_API_KEY).toBe('sk-ant-secret')
  })

  // NOT name-enumerated: iterate the ACTUAL denylist so a new entry is
  // automatically covered and a future omission in the loop is caught.
  it('scrubs EVERY entry in SUBPROCESS_SECRET_ENV (and its INPUT_ twin)', () => {
    const savedDenylistVals: Record<string, string | undefined> = {}
    try {
      for (const key of SUBPROCESS_SECRET_ENV) {
        savedDenylistVals[key] = process.env[key]
        savedDenylistVals[`INPUT_${key}`] = process.env[`INPUT_${key}`]
        process.env[key] = `secret-value-for-${key}`
        process.env[`INPUT_${key}`] = `input-secret-for-${key}`
      }

      const childEnv = subprocessEnv()

      for (const key of SUBPROCESS_SECRET_ENV) {
        expect(
          childEnv[key],
          `${key} (a SUBPROCESS_SECRET_ENV entry) must be scrubbed`,
        ).toBeUndefined()
        expect(
          childEnv[`INPUT_${key}`],
          `INPUT_${key} must be scrubbed`,
        ).toBeUndefined()
      }
    } finally {
      for (const [key, value] of Object.entries(savedDenylistVals)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  // STRUCTURAL guard (the one that catches the original gap): every provider
  // secret env name the codebase assigns to process.env — the single source
  // SECRET_ENV_KEYS — MUST be in the subprocess denylist. If a new provider key
  // is added to SECRET_ENV_KEYS but not scrubbed, this fails.
  it('SUBPROCESS_SECRET_ENV is a superset of providerSecrets.SECRET_ENV_KEYS', () => {
    const denylist = new Set<string>(SUBPROCESS_SECRET_ENV)
    const missing = SECRET_ENV_KEYS.filter((key) => !denylist.has(key))
    expect(
      missing,
      `provider secret env names missing from SUBPROCESS_SECRET_ENV: ${missing.join(', ')}`,
    ).toEqual([])
  })

  // Explicit lock on the provider/OAuth secrets that previously leaked, so a
  // regression that drops any one of them goes red even if SECRET_ENV_KEYS
  // changes shape.
  it('scrubs the provider/OAuth secrets that previously leaked to children', () => {
    const previouslyLeaked = [
      'MISTRAL_API_KEY',
      'BNKR_API_KEY',
      'MINIMAX_API_KEY',
      'NVIDIA_API_KEY',
      'MCP_CLIENT_SECRET',
    ]
    const denylist = new Set<string>(SUBPROCESS_SECRET_ENV)
    for (const key of previouslyLeaked) {
      expect(
        denylist.has(key),
        `${key} must be in SUBPROCESS_SECRET_ENV`,
      ).toBe(true)
    }
  })
})
