import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createCanonicalStateDocument,
  getGlobalRuntimeState,
  readCanonicalState,
  StateRepositoryError,
  validateCanonicalStateDocument,
  withGlobalRuntimeState,
  writeCanonicalStateAtomicSync,
} from '../../src/config/state.js'

const tempDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agenc-state-'))
  tempDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('canonical runtime state', () => {
  test('requires the exact versioned state envelope', () => {
    expect(() => validateCanonicalStateDocument({ global: {} })).toThrow(
      StateRepositoryError,
    )
    expect(() =>
      validateCanonicalStateDocument({
        state_version: 2,
        state: {},
      }),
    ).toThrow(/state_version = 1/u)
    expect(() =>
      validateCanonicalStateDocument({
        state_version: 1,
        state: {},
        config: {},
      }),
    ).toThrow(/unknown top-level state key: config/u)
  })

  test.each([
    ['primary key', { primaryApiKey: 'secret' }],
    ['API-key helper', { apiKeyHelper: '/bin/print-secret' }],
    ['OAuth account metadata', { oauthAccount: { accountUuid: 'account-1' } }],
    ['Chrome pairing identity', { chromeExtension: { pairedDeviceId: 'device-1' } }],
    [
      'raw API-key acknowledgement',
      { customApiKeyResponses: { approved: ['last-20-key-characters'] } },
    ],
    [
      'provider API key',
      {
        providerProfiles: [
          {
            id: 'profile-1',
            name: 'Example',
            provider: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            model: 'model',
            apiKey: 'secret',
          },
        ],
      },
    ],
    [
      'provider auth header value',
      {
        providerProfiles: [
          {
            id: 'profile-1',
            name: 'Example',
            provider: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            model: 'model',
            authHeaderValue: 'secret',
          },
        ],
      },
    ],
  ])('rejects %s credential authority', (_label, global) => {
    expect(() =>
      validateCanonicalStateDocument({
        state_version: 1,
        state: { global },
      }),
    ).toThrow(/credentials must be migrated to native secure storage/u)
  })

  test.each([
    ['auto-update preference', { autoUpdates: false }],
    ['remote-control preference', { remoteControlAtStartup: true }],
    ['editor preference', { editorMode: 'vim' }],
    ['TUI preference', { tui: { vimMode: true } }],
    ['environment injection', { env: { PATH: '/tmp/bin' } }],
    ['retired provider profiles', { providerProfiles: [] }],
    ['retired active provider profile', { activeProviderProfileId: 'profile-1' }],
    ['misplaced bypass acceptance', { bypassPermissionsModeAcceptedIn: ['/repo'] }],
    ['theme preference', { theme: 'dark' }],
    ['turn-duration preference', { showTurnDuration: false }],
    ['IDE auto-install preference', { autoInstallIdeExtension: false }],
    ['checkpoint preference', { fileCheckpointingEnabled: false }],
    ['terminal progress preference', { terminalProgressBarEnabled: false }],
    ['copy-on-select preference', { copyOnSelect: false }],
    ['flicker preference', { flickerFreeMode: false }],
    ['terminal backend preference', { preferTmuxOverIterm2: true }],
    ['teammate mode preference', { teammateMode: 'in-process' }],
    ['teammate model preference', { teammateDefaultModel: 'grok-4.5' }],
    ['PR footer preference', { prStatusFooterEnabled: false }],
    ['speculation preference', { speculationEnabled: false }],
  ])('rejects %s operator configuration in state', (_label, global) => {
    expect(() =>
      validateCanonicalStateDocument({
        state_version: 1,
        state: { global },
      }),
    ).toThrow(/agenc config migrate/u)
  })

  test.each([
    ['path trust', { hasTrustDialogAccepted: true }, /trusted-projects\.json/u],
    [
      'MCP digest trust',
      { approvedMcpjsonServerDigests: { docs: 'a'.repeat(64) } },
      /trusted-projects\.json/u,
    ],
    ['tool allowlist', { allowedTools: ['Bash'] }, /config\.toml/u],
    [
      'local MCP command',
      { mcpServers: { docs: { command: 'node', args: ['server.js'] } } },
      /config\.toml/u,
    ],
    ['MCP disable list', { disabledMcpServers: ['docs'] }, /config\.toml/u],
    [
      'duplicate onboarding marker',
      { projectOnboardingSeenCount: 2 },
      /onboarding\.json/u,
    ],
    [
      'dead remote spawn preference',
      { remoteControlSpawnMode: 'worktree' },
      /unused markers must be removed/u,
    ],
  ])('rejects project %s outside runtime state', (_label, project, error) => {
    expect(() =>
      validateCanonicalStateDocument({
        state_version: 1,
        state: {
          global: {
            projects: {
              '/repo': project,
            },
          },
        },
      }),
    ).toThrow(error)
  })

  test('retains project metrics and worktree facts as runtime state', () => {
    const document = validateCanonicalStateDocument({
      state_version: 1,
      state: {
        global: {
          projects: {
            '/repo': {
              lastAPIDuration: 123,
              lastSessionId: 'session-1',
              activeWorktreeSession: {
                originalCwd: '/repo',
                worktreePath: '/tmp/repo-worktree',
                worktreeName: 'feature',
                sessionId: 'session-1',
              },
            },
          },
        },
      },
    })

    expect(document.state.global).toEqual(
      expect.objectContaining({
        projects: expect.objectContaining({
          '/repo': expect.objectContaining({
            lastAPIDuration: 123,
            lastSessionId: 'session-1',
          }),
        }),
      }),
    )
  })

  test('rejects unknown project fields instead of creating a new policy authority', () => {
    expect(() =>
      validateCanonicalStateDocument({
        state_version: 1,
        state: {
          global: {
            projects: {
              '/repo': { futureExecutablePolicy: ['Bash'] },
            },
          },
        },
      }),
    ).toThrow(
      /unsupported project runtime state.*only metrics, caches, and active worktree facts/u,
    )
  })

  test('preserves unrelated namespaces while replacing global state', () => {
    const initial = createCanonicalStateDocument({
      daemon: { socketGeneration: 4 },
      global: { hasSeenTasksHint: false },
    })
    const updated = withGlobalRuntimeState(initial, {
      hasSeenTasksHint: true,
    })

    expect(updated).toEqual({
      state_version: 1,
      state: {
        daemon: { socketGeneration: 4 },
        global: {
          hasSeenTasksHint: true,
        },
      },
    })
    expect(getGlobalRuntimeState(updated)).toEqual(updated.state.global)
  })

  test('writes an atomic mode-0600 state document with no temp residue', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'nested', 'state.json')
    const document = createCanonicalStateDocument({
      global: { hasSeenTasksHint: true },
    })

    writeCanonicalStateAtomicSync(path, document)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(document)
    if (process.platform !== 'win32') {
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
    }
    expect(readdirSync(join(directory, 'nested'))).toEqual(['state.json'])
  })

  test('rejects duplicate keys before JSON parsing can discard state', async () => {
    const path = join(temporaryDirectory(), 'state.json')
    writeFileSync(
      path,
      '{"state_version":1,"state":{"global":{"hasSeenTasksHint":false,"hasSeenTasksHint":true}}}',
      { mode: 0o600 },
    )

    await expect(readCanonicalState(path)).rejects.toThrow(
      /state JSON contains 1 duplicate object key/u,
    )
  })
})
