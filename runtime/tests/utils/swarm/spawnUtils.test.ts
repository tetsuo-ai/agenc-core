import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHomeContext } from '../../../src/config/home.ts'
import { runWithStartupProviderSelection } from '../../../src/utils/model/providers.ts'
import { runWithCanonicalSettingsAuthority } from '../../../src/utils/settings/canonicalAuthority.ts'
import { buildInheritedEnvVars } from '../../../src/utils/swarm/spawnUtils.ts'
import {
  runWithAgentRuntimeOptions,
  type AgentRuntimeOptions,
} from '../../../src/session/runtime-options.ts'

const ORIGINAL_ENV = { ...process.env }
const TEST_BASE_ENVIRONMENT = Object.freeze({
  HOME: '/tmp/agenc-spawn-utils-user',
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
})

function buildInheritedEnvVarsForTest(): string {
  return buildInheritedEnvVars(TEST_BASE_ENVIRONMENT)
}

function authorityAt(homePath: string) {
  const homeContext = resolveHomeContext({ AGENC_HOME: homePath })
  return {
    current: () => ({}),
    sources: () => [],
    projectRoot: '/tmp',
    homeContext,
    stateRepository: { getNamespace: () => ({}) },
    reload: async () => {},
    subscribe: () => {},
  } as never
}

function withAuthority<T>(
  options: {
    readonly home: string
    readonly provider?: string
    readonly environment?: Readonly<Record<string, string | undefined>>
    readonly runtimeOptions?: AgentRuntimeOptions
  },
  operation: () => T,
): T {
  const runtimeOptions =
    options.runtimeOptions ??
    Object.freeze({
      simpleMode: false,
      stdinDataMode: false,
      remoteMode: false,
      sessionTempRoot: '/tmp/agenc-spawn-utils-temp',
      pluginStorageRoot: '/tmp/agenc-spawn-utils-plugins',
      allowUntrustedHooks: false,
    })
  return runWithCanonicalSettingsAuthority(authorityAt(options.home), () =>
    runWithStartupProviderSelection(
      {
        provider: options.provider ?? 'openai',
        model: 'teammate-test-model',
        environment: {
          PATH: TEST_BASE_ENVIRONMENT.PATH,
          ...(options.environment ?? {}),
        },
      },
      () => runWithAgentRuntimeOptions(runtimeOptions, operation),
    ),
  )
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key]
  }
  Object.assign(process.env, ORIGINAL_ENV)
})

test('buildInheritedEnvVars marks spawned teammates as host-managed for provider routing', () => {
  const envVars = withAuthority(
    { home: '/tmp/agenc-spawn-utils-home' },
    buildInheritedEnvVarsForTest,
  )

  expect(envVars).toContain('AGENC_PROVIDER_MANAGED_BY_HOST\\=1')
})

test('buildInheritedEnvVars fails closed without parent runtime authority', () => {
  runWithCanonicalSettingsAuthority(
    authorityAt('/tmp/agenc-spawn-utils-home'),
    () =>
      runWithStartupProviderSelection(
        { provider: 'grok', model: 'grok-4.6', environment: {} },
        () =>
          expect(() => buildInheritedEnvVars(TEST_BASE_ENVIRONMENT)).toThrow(
            'Teammate spawn requires captured parent runtime-options authority',
          ),
      ),
  )
})

test('buildInheritedEnvVars forwards PATH for source-built teammate tool lookups', () => {
  const envVars = withAuthority(
    {
      home: '/tmp/agenc-spawn-utils-home',
      environment: { PATH: '/custom/bin:/usr/bin' },
    },
    buildInheritedEnvVarsForTest,
  )

  expect(envVars).toContain('PATH\\=')
  expect(envVars).toContain('/custom/bin\\:/usr/bin')
})
test('buildInheritedEnvVars does not forward retired plaintext token directories', () => {
  process.env.AGENC_REMOTE_TOKEN_DIR = '/remote/tokens'

  const envVars = withAuthority(
    {
      home: '/tmp/agenc-spawn-utils-home',
      environment: { AGENC_REMOTE_TOKEN_DIR: '/remote/tokens' },
    },
    buildInheritedEnvVarsForTest,
  )

  expect(envVars).not.toContain('AGENC_REMOTE_TOKEN_DIR')
})

test('buildInheritedEnvVars isolates concurrent client provider and home authority', async () => {
  process.env.AGENC_HOME = '/tmp/daemon-global-home'
  process.env.OPENAI_API_KEY = 'daemon-global-key'
  process.env.PATH = '/daemon-global-bin'

  const [clientA, clientB] = await Promise.all([
    withAuthority(
      {
        home: '/tmp/agenc-client-a',
        provider: 'openai',
        environment: {
          OPENAI_API_KEY: 'client-a-key',
          PATH: '/client-a-bin',
        },
      },
      async () => {
        await Promise.resolve()
        return buildInheritedEnvVars(TEST_BASE_ENVIRONMENT)
      },
    ),
    withAuthority(
      {
        home: '/tmp/agenc-client-b',
        provider: 'github',
        environment: {
          GITHUB_TOKEN: 'client-b-key',
          PATH: '/client-b-bin',
        },
      },
      async () => {
        await Promise.resolve()
        return buildInheritedEnvVars(TEST_BASE_ENVIRONMENT)
      },
    ),
  ])

  expect(clientA).toContain('AGENC_PROVIDER\\=openai')
  expect(clientA).toContain('AGENC_HOME\\=/tmp/agenc-client-a')
  expect(clientA).toContain('OPENAI_API_KEY\\=client-a-key')
  expect(clientA).toContain('PATH\\=/client-a-bin')
  expect(clientA).not.toContain('client-b')
  expect(clientA).not.toContain('daemon-global')

  expect(clientB).toContain('AGENC_PROVIDER\\=github')
  expect(clientB).toContain('AGENC_HOME\\=/tmp/agenc-client-b')
  expect(clientB).toContain('GITHUB_TOKEN\\=client-b-key')
  expect(clientB).toContain('PATH\\=/client-b-bin')
  expect(clientB).not.toContain('client-a')
  expect(clientB).not.toContain('daemon-global')
})

test('buildInheritedEnvVars projects every captured provider environment key once', () => {
  const envVars = withAuthority(
    {
      home: '/tmp/agenc-spawn-utils-home',
      provider: 'grok',
      environment: {
        AGENC_PROVIDER: 'stale-provider',
        AGENC_MODEL: 'stale-model',
        XAI_API_KEY: 'xai-key',
        GROK_BASE_URL: 'https://grok.example.test',
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENROUTER_API_KEY: 'openrouter-key',
        GROQ_API_KEY: 'groq-key',
        DEEPSEEK_API_KEY: 'deepseek-key',
        NVIDIA_API_KEY: 'nvidia-key',
        MINIMAX_API_KEY: 'minimax-key',
        GEMINI_ACCESS_TOKEN: 'gemini-token',
        AWS_BEDROCK_SESSION_TOKEN: 'bedrock-token',
      },
    },
    buildInheritedEnvVarsForTest,
  )

  for (const value of [
    'xai-key',
    'anthropic-key',
    'openrouter-key',
    'groq-key',
    'deepseek-key',
    'nvidia-key',
    'minimax-key',
    'gemini-token',
    'bedrock-token',
  ]) {
    expect(envVars).toContain(value)
  }
  expect(envVars).toContain('GROK_BASE_URL\\=')
  expect(envVars).toContain('grok.example.test')
  expect(envVars.match(/(?:^| )AGENC_PROVIDER\\=/g)).toHaveLength(1)
  expect(envVars).toContain('AGENC_PROVIDER\\=grok')
  expect(envVars).not.toContain('stale-provider')
  expect(envVars).not.toMatch(/AGENC_MODEL(?:=|\\=)/)
  expect(envVars).not.toContain('stale-model')
})

test('buildInheritedEnvVars projects captured shell, temp, plugin, and hook authority', () => {
  const runtimeOptions = Object.freeze({
    simpleMode: true,
    stdinDataMode: false,
    remoteMode: true,
    remoteMemoryRoot: '/tmp/agenc-spawn-remote-memory',
    coworkMemoryPathOverride: '/tmp/agenc-spawn-cowork-memory',
    coworkMemoryExtraGuidelines: 'Keep child memory scoped.',
    posixShellPath: '/bin/zsh',
    commandWrapperArgv: Object.freeze([
      'env',
      'SPAWN_BOUND=1',
      '/bin/zsh',
      '-c',
    ]),
    sessionTempRoot: '/tmp/agenc-spawn-session-temp',
    pluginStorageRoot: '/tmp/agenc-spawn-plugin-storage',
    allowUntrustedHooks: true,
  }) satisfies AgentRuntimeOptions

  const envVars = withAuthority(
    {
      home: '/tmp/agenc-spawn-utils-home',
      provider: 'grok',
      runtimeOptions,
    },
    buildInheritedEnvVarsForTest,
  )

  expect(envVars).toContain('AGENC_REMOTE\\=1')
  expect(envVars).toContain('AGENC_SHELL\\=/bin/zsh')
  expect(envVars).toContain('SPAWN_BOUND\\=1')
  expect(envVars).toContain('AGENC_TMPDIR\\=/tmp/agenc-spawn-session-temp')
  expect(envVars).toContain(
    'AGENC_PLUGIN_CACHE_DIR\\=/tmp/agenc-spawn-plugin-storage',
  )
  expect(envVars).toContain('AGENC_ALLOW_UNTRUSTED_HOOKS\\=1')
})

test('buildInheritedEnvVars clears stale pane authority in a real child environment', () => {
  const injectionRoot = mkdtempSync(
    join(tmpdir(), 'agenc-spawn-env-injection-'),
  )
  const injectionMarker = join(injectionRoot, 'injected')
  try {
    const envVars = withAuthority(
      {
        home: '/tmp/agenc-spawn-utils-home',
        provider: 'grok',
        environment: {
          XAI_API_KEY: 'captured-xai-key',
        },
      },
      () =>
        buildInheritedEnvVars({
          ...TEST_BASE_ENVIRONMENT,
          AGENC_MODEL: 'stale-pane-model',
          AGENC_SHELL: '/bin/stale-shell',
          AGENC_SHELL_PREFIX: 'stale-wrapper',
          AGENC_REMOTE_MEMORY_DIR: '/tmp/stale-remote-memory',
          AGENC_COWORK_MEMORY_PATH_OVERRIDE: '/tmp/stale-cowork-memory',
          AGENC_USE_DATA_STDIN: '1',
          AGENC_WORKSPACE: '/tmp/stale-workspace',
          AGENC_PROJECT_DIR: '/tmp/stale-project',
          AGENC_CWD: '/tmp/stale-hook-cwd',
          PWD: '/tmp/stale-pwd',
          OPENAI_API_KEY: 'stale-openai-key',
          OPENAI_BASE_URL: 'https://stale-openai.example.test',
          AGENC_CREDENTIAL_STALE: 'stale-dynamic-credential',
          [`BAD;touch ${injectionMarker};IGNORED`]: 'x',
          '-u': 'AGENC_PROVIDER',
          MULTILINE: 'first\nsecond',
        }),
    )
    expect(envVars.startsWith('-i -- ')).toBe(true)
    const output = execFileSync(
      '/bin/sh',
      ['-c', `env ${envVars} /usr/bin/env`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENC_MODEL: 'ambient-pane-model',
          AGENC_SHELL_PREFIX: 'ambient-pane-wrapper',
          OPENAI_API_KEY: 'ambient-openai-key',
        },
      },
    )
    const childEnvironment = Object.fromEntries(
      output.trimEnd().split('\n').map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      }),
    )

    expect(childEnvironment.HOME).toBe(TEST_BASE_ENVIRONMENT.HOME)
    expect(childEnvironment.PATH).toBe(TEST_BASE_ENVIRONMENT.PATH)
    expect(childEnvironment.LANG).toBe(TEST_BASE_ENVIRONMENT.LANG)
    expect(childEnvironment.XAI_API_KEY).toBe('captured-xai-key')
    expect(childEnvironment.AGENC_PROVIDER).toBe('grok')
    expect(childEnvironment.AGENC_REMOTE).toBe('0')
    expect(childEnvironment.AGENC_ALLOW_UNTRUSTED_HOOKS).toBe('0')
    expect(existsSync(injectionMarker)).toBe(false)
    for (const key of [
      'AGENC_MODEL',
      'AGENC_SHELL',
      'AGENC_SHELL_PREFIX',
      'AGENC_REMOTE_MEMORY_DIR',
      'AGENC_COWORK_MEMORY_PATH_OVERRIDE',
      'AGENC_USE_DATA_STDIN',
      'AGENC_WORKSPACE',
      'AGENC_PROJECT_DIR',
      'AGENC_CWD',
      'PWD',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'AGENC_CREDENTIAL_STALE',
      '-u',
      'MULTILINE',
    ]) {
      expect(childEnvironment[key]).toBeUndefined()
    }
  } finally {
    rmSync(injectionRoot, { recursive: true, force: true })
  }
})
