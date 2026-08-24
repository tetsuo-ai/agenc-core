import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resolveHomeContext } from '../../../src/config/home.ts'
import { runWithStartupProviderSelection } from '../../../src/utils/model/providers.ts'
import { runWithCanonicalSettingsAuthority } from '../../../src/utils/settings/canonicalAuthority.ts'
import { buildInheritedEnvVars } from '../../../src/utils/swarm/spawnUtils.ts'

const ORIGINAL_ENV = { ...process.env }

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
  },
  operation: () => T,
): T {
  return runWithCanonicalSettingsAuthority(authorityAt(options.home), () =>
    runWithStartupProviderSelection(
      {
        provider: options.provider ?? 'openai',
        model: 'teammate-test-model',
        environment: options.environment ?? {},
      },
      operation,
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
    buildInheritedEnvVars,
  )

  expect(envVars).toContain('AGENC_PROVIDER_MANAGED_BY_HOST=1')
})

test('buildInheritedEnvVars forwards PATH for source-built teammate tool lookups', () => {
  const envVars = withAuthority(
    {
      home: '/tmp/agenc-spawn-utils-home',
      environment: { PATH: '/custom/bin:/usr/bin' },
    },
    buildInheritedEnvVars,
  )

  expect(envVars).toContain('PATH=')
  expect(envVars).toContain('/custom/bin\\:/usr/bin')
})
test('buildInheritedEnvVars does not forward retired plaintext token directories', () => {
  process.env.AGENC_REMOTE_TOKEN_DIR = '/remote/tokens'

  const envVars = withAuthority(
    {
      home: '/tmp/agenc-spawn-utils-home',
      environment: { AGENC_REMOTE_TOKEN_DIR: '/remote/tokens' },
    },
    buildInheritedEnvVars,
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
        return buildInheritedEnvVars()
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
        return buildInheritedEnvVars()
      },
    ),
  ])

  expect(clientA).toContain('AGENC_PROVIDER=openai')
  expect(clientA).toContain('AGENC_HOME=/tmp/agenc-client-a')
  expect(clientA).toContain('OPENAI_API_KEY=client-a-key')
  expect(clientA).toContain('PATH=/client-a-bin')
  expect(clientA).not.toContain('client-b')
  expect(clientA).not.toContain('daemon-global')

  expect(clientB).toContain('AGENC_PROVIDER=github')
  expect(clientB).toContain('AGENC_HOME=/tmp/agenc-client-b')
  expect(clientB).toContain('GITHUB_TOKEN=client-b-key')
  expect(clientB).toContain('PATH=/client-b-bin')
  expect(clientB).not.toContain('client-a')
  expect(clientB).not.toContain('daemon-global')
})
