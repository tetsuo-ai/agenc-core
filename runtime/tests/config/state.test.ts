import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createCanonicalStateDocument,
  getGlobalRuntimeState,
  parseCanonicalStateDocument,
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

function withInjectedDirectoryFsyncFailure<T>(
  failure: NodeJS.ErrnoException,
  operation: () => T,
): T {
  const nodeFs = createRequire(import.meta.url)('node:fs') as {
    openSync(path: string, flags: string | number): number
    fsyncSync(descriptor: number): void
    closeSync(descriptor: number): void
  }
  const originalOpenSync = nodeFs.openSync
  const originalFsyncSync = nodeFs.fsyncSync
  const originalCloseSync = nodeFs.closeSync
  let directoryDescriptor: number | undefined
  nodeFs.openSync = (path, flags) => {
    const descriptor = originalOpenSync(path, flags)
    if (flags === 'r') directoryDescriptor = descriptor
    return descriptor
  }
  nodeFs.fsyncSync = (descriptor) => {
    if (descriptor === directoryDescriptor) throw failure
    originalFsyncSync(descriptor)
  }
  nodeFs.closeSync = (descriptor) => originalCloseSync(descriptor)
  syncBuiltinESMExports()

  try {
    return operation()
  } finally {
    nodeFs.openSync = originalOpenSync
    nodeFs.fsyncSync = originalFsyncSync
    nodeFs.closeSync = originalCloseSync
    syncBuiltinESMExports()
  }
}

function withInjectedRenameFailure<T>(
  failure: NodeJS.ErrnoException,
  operation: () => T,
): T {
  const nodeFs = createRequire(import.meta.url)('node:fs') as {
    renameSync(oldPath: string, newPath: string): void
  }
  const originalRenameSync = nodeFs.renameSync
  nodeFs.renameSync = () => {
    throw failure
  }
  syncBuiltinESMExports()

  try {
    return operation()
  } finally {
    nodeFs.renameSync = originalRenameSync
    syncBuiltinESMExports()
  }
}

function withInjectedLinkFailure<T>(
  failure: NodeJS.ErrnoException,
  operation: () => T,
): T {
  const nodeFs = createRequire(import.meta.url)('node:fs') as {
    linkSync(existingPath: string, newPath: string): void
  }
  const originalLinkSync = nodeFs.linkSync
  let injected = false
  nodeFs.linkSync = (existingPath, newPath) => {
    if (!injected && newPath.endsWith('state.json')) {
      injected = true
      throw failure
    }
    originalLinkSync(existingPath, newPath)
  }
  syncBuiltinESMExports()

  try {
    return operation()
  } finally {
    nodeFs.linkSync = originalLinkSync
    syncBuiltinESMExports()
  }
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
    ['fast-mode session preference', { fastModePerSessionOptIn: true }],
    ['bypass acceptance', { bypassPermissionsModeAcceptedIn: ['/repo'] }],
  ])('rejects the retired settings namespace containing %s', (_label, settings) => {
    expect(() =>
      validateCanonicalStateDocument({
        state_version: 1,
        state: { global: { settings } },
      }),
    ).toThrow(/unsupported or retired state.*settings/u)
  })

  test('rejects retired consent when the canonical permission namespace also exists', () => {
    expect(() =>
      parseCanonicalStateDocument(JSON.stringify({
        state_version: 1,
        state: {
          global: {
            permissions: {
              bypassPermissionsAcceptedByCwd: {
                '/workspace/canonical': {
                  version: 1,
                  canonicalCwd: '/workspace/canonical',
                  dev: '1',
                  ino: '2',
                },
              },
            },
            settings: {
              bypassPermissionsModeAcceptedIn: ['/workspace/retired'],
            },
          },
        },
      })),
    ).toThrow(/unsupported or retired state.*settings/u)
  })

  test.each([
    ['permissions namespace', 'corrupt'],
    [
      'acceptance map',
      { bypassPermissionsAcceptedByCwd: ['/workspace/accepted'] },
    ],
  ])('rejects a corrupt %s', (_label, permissions) => {
    expect(() =>
      parseCanonicalStateDocument(JSON.stringify({
        state_version: 1,
        state: {
          global: {
            permissions,
          },
        },
      })),
    ).toThrow(/permissions/u)
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

    const outcome = writeCanonicalStateAtomicSync(path, document)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(document)
    expect(outcome).toMatchObject({
      committed: true,
      directoryDurability: expect.stringMatching(
        /^(?:confirmed|unsupported|indeterminate)$/u,
      ),
    })
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

  test('refuses to read state.json through a symbolic link', async () => {
    const directory = temporaryDirectory()
    const target = join(directory, 'outside-state.json')
    const path = join(directory, 'state.json')
    writeCanonicalStateAtomicSync(
      target,
      createCanonicalStateDocument({
        global: { hasSeenTasksHint: true },
      }),
    )
    symlinkSync(target, path)

    await expect(readCanonicalState(path)).rejects.toThrow(/symbolic link/u)
  })

  test('refuses hard-linked state authority', async () => {
    const directory = temporaryDirectory()
    const target = join(directory, 'outside-state.json')
    const path = join(directory, 'state.json')
    writeCanonicalStateAtomicSync(
      target,
      createCanonicalStateDocument({ global: { hasSeenTasksHint: true } }),
    )
    linkSync(target, path)

    await expect(readCanonicalState(path)).rejects.toThrow(
      /exactly one hard link/u,
    )
  })

  test('refuses group/world-readable state authority', async () => {
    if (process.platform === 'win32') return
    const path = join(temporaryDirectory(), 'state.json')
    writeCanonicalStateAtomicSync(
      path,
      createCanonicalStateDocument({ global: { hasSeenTasksHint: true } }),
    )
    chmodSync(path, 0o666)

    await expect(readCanonicalState(path)).rejects.toThrow(/exact mode 0600/u)
  })

  test.each([
    ['Map', new Map([['value', 1]])],
    ['Date', new Date(0)],
    ['function', () => true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['nested undefined', undefined],
  ])('rejects non-lossless nested JSON state: %s', (_label, badValue) => {
    expect(() => validateCanonicalStateDocument({
      state_version: 1,
      state: {
        global: {
          projects: {
            '/repo': {
              lastSessionMetrics: { badValue },
            },
          },
        },
      },
    })).toThrow(/non-(?:lossless JSON number|JSON value|plain JSON object)/u)
  })

  test('rejects cyclic nested state', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => validateCanonicalStateDocument({
      state_version: 1,
      state: {
        global: {
          projects: {
            '/repo': { lastSessionMetrics: cyclic },
          },
        },
      },
    })).toThrow(/cyclic JSON value/u)
  })

  test('ignores an unsupported directory fsync after a successful open', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'state.json')
    const unsupported = Object.assign(
      new Error('injected unsupported directory fsync'),
      { code: 'EINVAL' },
    )

    const outcome = withInjectedDirectoryFsyncFailure(unsupported, () =>
      writeCanonicalStateAtomicSync(
        path,
        createCanonicalStateDocument({
          global: { hasSeenTasksHint: true },
        }),
      ),
    )
    expect(outcome).toEqual({
      committed: true,
      directoryDurability: 'unsupported',
      postCommitErrors: [unsupported],
    })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
      createCanonicalStateDocument({
        global: { hasSeenTasksHint: true },
      }),
    )
  })

  test('reports an indeterminate directory fsync after committing visible state', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'state.json')
    const failure = Object.assign(new Error('injected directory fsync failure'), {
      code: 'EIO',
    })
    const document = createCanonicalStateDocument({
      global: { hasSeenTasksHint: true },
    })
    const outcome = withInjectedDirectoryFsyncFailure(failure, () =>
      writeCanonicalStateAtomicSync(
        path,
        document,
      ),
    )

    expect(outcome).toEqual({
      committed: true,
      directoryDurability: 'indeterminate',
      postCommitErrors: [failure],
    })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(document)
  })

  test('throws a pre-rename failure without publishing or retaining its stage', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'state.json')
    const original = createCanonicalStateDocument({
      global: { hasSeenTasksHint: false },
    })
    writeCanonicalStateAtomicSync(path, original)
    const replacement = createCanonicalStateDocument({
      global: { hasSeenTasksHint: true },
    })
    const failure = Object.assign(new Error('injected rename failure'), {
      code: 'EIO',
    })

    expect(() =>
      withInjectedRenameFailure(failure, () =>
        writeCanonicalStateAtomicSync(path, replacement),
      ),
    ).toThrow(failure)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(original)
    expect(readdirSync(directory)).toEqual(['state.json'])
  })

  test('restores the prior state after publication fails following quarantine', async () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'state.json')
    const original = createCanonicalStateDocument({
      global: { hasSeenTasksHint: false },
    })
    writeCanonicalStateAtomicSync(path, original)
    const replacement = createCanonicalStateDocument({
      global: { hasSeenTasksHint: true },
    })
    const failure = Object.assign(new Error('injected link failure'), {
      code: 'EIO',
    })

    expect(() =>
      withInjectedLinkFailure(failure, () =>
        writeCanonicalStateAtomicSync(path, replacement),
      ),
    ).toThrow(failure)
    await expect(readCanonicalState(path)).resolves.toEqual(original)
    expect(readdirSync(directory)).toEqual(['state.json'])
  })

  test('preserves a concurrent state revision quarantined after the CAS check', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'state.json')
    const displacedExpected = join(directory, 'displaced-expected.json')
    const original = createCanonicalStateDocument({
      global: { hasSeenTasksHint: false },
    })
    const concurrent = createCanonicalStateDocument({
      global: { hasSeenTasksHint: true, hasUsedStash: true },
    })
    writeCanonicalStateAtomicSync(path, original)

    const nodeFs = createRequire(import.meta.url)('node:fs') as {
      renameSync(oldPath: string, newPath: string): void
    }
    const originalRenameSync = nodeFs.renameSync
    let swapped = false
    nodeFs.renameSync = (oldPath, newPath) => {
      if (!swapped && oldPath === path && newPath.includes('.quarantine-')) {
        swapped = true
        originalRenameSync(path, displacedExpected)
        writeFileSync(path, `${JSON.stringify(concurrent, null, 2)}\n`, {
          mode: 0o600,
        })
      }
      originalRenameSync(oldPath, newPath)
    }
    syncBuiltinESMExports()

    try {
      expect(() => writeCanonicalStateAtomicSync(
        path,
        createCanonicalStateDocument({ global: { hasSeenTasksHint: true } }),
      )).toThrow(/quarantined a concurrent revision/u)
    } finally {
      nodeFs.renameSync = originalRenameSync
      syncBuiltinESMExports()
    }

    expect(swapped).toBe(true)
    const quarantine = readdirSync(directory)
      .find((entry) => entry.startsWith('state.json.quarantine-'))
    expect(quarantine).toBeDefined()
    expect(JSON.parse(readFileSync(join(directory, quarantine!), 'utf8')))
      .toEqual(concurrent)
    expect(JSON.parse(readFileSync(displacedExpected, 'utf8'))).toEqual(original)
  })

  test('refuses a special destination leaf instead of replacing it', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'state.json')
    mkdirSync(path)

    expect(() => writeCanonicalStateAtomicSync(
      path,
      createCanonicalStateDocument({ global: { hasSeenTasksHint: true } }),
    )).toThrow(/regular file/u)
    expect(lstatSync(path).isDirectory()).toBe(true)
  })
})
