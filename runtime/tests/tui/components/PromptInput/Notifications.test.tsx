import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from '../../remoteAuthSessionContext.fixture.js'

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  appState: {
    isBriefOnly: false,
    notifications: {
      current: null as
        | null
        | {
            color?: string
            key: string
            text?: string
            wrap?: boolean
            jsx?: React.ReactNode
          },
      queue: [] as unknown[],
    },
  },
  autoUpdaterProps: [] as Array<Record<string, unknown>>,
  compactWarning: false,
  compactWarningEnvironments: [] as unknown[],
  editor: undefined as string | undefined,
  envHookNotifier: null as null | ((text: string, isError?: boolean) => void),
  features: new Set<string>(),
  ideStatus: 'disconnected' as 'connected' | 'disconnected',
  mcpClientsSeen: undefined as unknown,
  model: 'gpt-5.4',
  removeNotification: vi.fn(),
  remoteMode: false,
  remoteAuthSession: false,
  remoteAuthContexts: [] as unknown[],
  remoteManagedKeys: false,
  remoteSubscriptionTier: undefined as
    | undefined
    | 'enterprise'
    | 'free'
    | 'pro'
    | 'team',
  subscriptionType: 'pro' as 'enterprise' | 'pro' | 'team',
  tokenUsage: 1234,
  tokenWarningEnvironments: [] as unknown[],
  usesAnthropicAccountFlow: true,
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../services/compact/autoCompact.js', () => ({
  calculateTokenWarningStateForEnvironment: (
    tokenUsage: number,
    model: string,
    environment: unknown,
  ) => {
    harness.compactWarningEnvironments.push(environment)
    return {
      isAboveWarningThreshold: harness.compactWarning,
      model,
      tokenUsage,
    }
  },
}))

vi.mock('../../../auth/session-state.js', () => ({
  hasEntitledRemoteAuthSessionSync: (context: unknown) => {
    harness.remoteAuthContexts.push(context)
    return harness.remoteManagedKeys
  },
  hasRemoteAuthSessionSync: (context: unknown) => {
    harness.remoteAuthContexts.push(context)
    return harness.remoteAuthSession
  },
  remoteAuthSessionSubscriptionTierSync: (context: unknown) => {
    harness.remoteAuthContexts.push(context)
    return harness.remoteSubscriptionTier
  },
}))

vi.mock('../../../utils/auth.js', () => ({
  getSubscriptionTypeForContext: () => harness.subscriptionType,
}))

vi.mock('../../../bootstrap/state.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../bootstrap/state.js')>()
  return {
    ...actual,
    getIsRemoteMode: () => harness.remoteMode,
  }
})

vi.mock('../../../utils/editor.js', () => ({
  getExternalEditor: () => harness.editor,
}))

vi.mock('../../../utils/envUtils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../utils/envUtils.js')>()
  return {
    ...actual,
    isEnvTruthy: (value: string | undefined) =>
      value === '1' || value === 'true' || value === 'yes',
  }
})

vi.mock('../../../utils/format.js', () => ({
  formatDuration: (ms: number) => `${ms}ms`,
}))

vi.mock('../../../utils/hooks/cwdChangedHooks.js', () => ({
  setEnvHookNotifier: (
    notifier: null | ((text: string, isError?: boolean) => void),
  ) => {
    harness.envHookNotifier = notifier
  },
}))

vi.mock('../../../utils/ide.js', () => ({
  toIDEDisplayName: (editor: string) => `IDE:${editor}`,
}))

vi.mock('../../../utils/messages.js', () => ({
  getMessagesAfterCompactBoundary: (messages: unknown[]) => messages,
}))

vi.mock('../../../utils/model/providers.js', () => ({
  usesAnthropicAccountFlow: () => harness.usesAnthropicAccountFlow,
  // The harness drives auth-flow visibility through usesAnthropicAccountFlow;
  // the registry gate stays inert so existing cases keep exercising the
  // Anthropic-flow copy paths.
  isRegistryOwnedNonAnthropicModel: () => false,
}))

vi.mock('../../../utils/tokens.js', () => ({
  tokenCountFromLastAPIResponse: () => harness.tokenUsage,
}))

vi.mock('../../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
    removeNotification: harness.removeNotification,
  }),
}))

vi.mock('../../hooks/useIdeConnectionStatus.js', () => ({
  useIdeConnectionStatus: (mcpClients: unknown) => {
    harness.mcpClientsSeen = mcpClients
    return { status: harness.ideStatus }
  },
}))

vi.mock('../../hooks/useMainLoopModel.js', () => ({
  useMainLoopModel: () => harness.model,
}))

vi.mock('../../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
}))

vi.mock('../AutoUpdaterWrapper.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    AutoUpdaterWrapper: (props: Record<string, unknown>) => {
      harness.autoUpdaterProps.push(props)
      const result = props.autoUpdaterResult as undefined | { status?: string }
      return ReactModule.createElement(
        Text,
        null,
        `AutoUpdater:${String(props.verbose)}:${String(props.isUpdating)}:${String(props.showSuccessMessage)}:${result?.status ?? 'none'}`,
      )
    },
  }
})

vi.mock('../ConfigurableShortcutHint.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    ConfigurableShortcutHint: ({
      description,
      fallback,
    }: {
      description: string
      fallback: string
    }) =>
      ReactModule.createElement(Text, null, `${fallback}:${description}`),
  }
})

vi.mock('../IdeStatusIndicator.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    IdeStatusIndicator: ({
      ideSelection,
      mcpClients,
    }: {
      ideSelection?: { filePath?: string; text?: string }
      mcpClients?: unknown[]
    }) =>
      ReactModule.createElement(
        Text,
        null,
        `IDE:${ideSelection?.filePath ?? ideSelection?.text ?? 'none'}:${mcpClients?.length ?? 0}`,
      ),
  }
})

vi.mock('../../cost/MemoryUsageIndicator.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    MemoryUsageIndicator: () =>
      ReactModule.createElement(Text, null, 'MemoryUsage'),
  }
})

vi.mock('../TuiErrorBoundary.js', () => ({
  TuiErrorBoundary: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}))

vi.mock('../../cost/TokenWarning.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    TokenWarning: ({
      environment,
      model,
      tokenUsage,
    }: {
      environment: unknown
      model: string
      tokenUsage: number
    }) => {
      harness.tokenWarningEnvironments.push(environment)
      return ReactModule.createElement(Text, null, `TokenWarning:${tokenUsage}:${model}`)
    },
  }
})

vi.mock('./SandboxPromptFooterHint.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    SandboxPromptFooterHint: () =>
      ReactModule.createElement(Text, null, 'SandboxHint'),
  }
})

import { createRoot } from '../../ink/root.js'
import { Text } from '../../ink.js'
import { Notifications } from './Notifications.js'

type RenderedNotifications = {
  dispose: () => Promise<void>
  output: () => string
  rerender: (overrides?: Partial<NotificationsProps>) => Promise<void>
}

type NotificationsProps = React.ComponentProps<typeof Notifications>

function resetHarness() {
  harness.addNotification.mockClear()
  harness.appState.isBriefOnly = false
  harness.appState.notifications = { current: null, queue: [] }
  harness.autoUpdaterProps = []
  harness.compactWarning = false
  harness.compactWarningEnvironments = []
  harness.editor = undefined
  harness.envHookNotifier = null
  harness.features = new Set()
  harness.ideStatus = 'disconnected'
  harness.mcpClientsSeen = undefined
  harness.model = 'gpt-5.4'
  harness.removeNotification.mockClear()
  harness.remoteMode = false
  harness.remoteAuthSession = false
  harness.remoteAuthContexts = []
  harness.remoteManagedKeys = false
  harness.remoteSubscriptionTier = undefined
  harness.subscriptionType = 'pro'
  harness.tokenUsage = 1234
  harness.tokenWarningEnvironments = []
  harness.usesAnthropicAccountFlow = true
}

function baseProps(): NotificationsProps {
  return {
    apiKeyStatus: 'valid',
    autoUpdaterResult: null,
    debug: false,
    getMessages: () => [],
    ideSelection: undefined,
    isAutoUpdating: false,
    lastAssistantMessageId: null,
    mcpClients: undefined,
    onAutoUpdaterResult: vi.fn(),
    onChangeIsUpdating: vi.fn(),
    remoteAuthSessionContext: TEST_REMOTE_AUTH_SESSION_CONTEXT,
    verbose: false,
  }
}

function createStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  stdout.resume()
  ;(stdout as unknown as { columns: number; rows: number }).columns = 120
  ;(stdout as unknown as { columns: number; rows: number }).rows = 30

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function renderNotifications(
  overrides: Partial<NotificationsProps> = {},
): Promise<RenderedNotifications> {
  let props = { ...baseProps(), ...overrides } as NotificationsProps
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  const render = () => {
    root.render(<Notifications {...props} />)
  }

  render()
  await sleep()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    output: () => stripAnsi(output),
    rerender: async next => {
      props = { ...props, ...next }
      render()
      await sleep()
    },
  }
}

beforeEach(() => {
  resetHarness()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Notifications', () => {
  test('uses the explicit session authority for every remote auth read', async () => {
    const rendered = await renderNotifications()

    try {
      expect(harness.remoteAuthContexts).toHaveLength(3)
      expect(
        harness.remoteAuthContexts.every(
          context => context === TEST_REMOTE_AUTH_SESSION_CONTEXT,
        ),
      ).toBe(true)
      expect(harness.compactWarningEnvironments).toEqual([
        TEST_REMOTE_AUTH_SESSION_CONTEXT.environment,
      ])
      expect(harness.tokenWarningEnvironments).toEqual([
        TEST_REMOTE_AUTH_SESSION_CONTEXT.environment,
      ])
    } finally {
      await rendered.dispose()
    }
  })

  test('wraps opted-in notifications so the remediation tail stays readable', async () => {
    // Terminal is 120 columns; this message is deliberately longer so a
    // truncating render would drop the trailing remediation.
    const remediation = 'run `agenc doctor --apparmor-profile` and reload'
    harness.appState.notifications.current = {
      color: 'error',
      key: 'prompt-submit-failed',
      text: `Message not sent: [sandbox_probe_failed] required sandbox blocked startup: probe failed because the kernel refused the namespace. ${remediation}`,
      wrap: true,
    }
    const rendered = await renderNotifications({})

    try {
      expect(rendered.output()).toContain('Message not sent:')
      expect(rendered.output()).toContain(remediation)
    } finally {
      await rendered.dispose()
    }
  })

  test('still truncates notifications that do not opt into wrapping', async () => {
    const tail = 'TAIL_MARKER_THAT_MUST_BE_TRUNCATED_AWAY'
    harness.appState.notifications.current = {
      color: 'error',
      key: 'plain-long',
      text: `Message not sent: ${'x'.repeat(200)} ${tail}`,
    }
    const rendered = await renderNotifications({})

    try {
      expect(rendered.output()).toContain('Message not sent:')
      expect(rendered.output()).not.toContain(tail)
    } finally {
      await rendered.dispose()
    }
  })

  test('renders status rows and wires env hook notifications', async () => {
    harness.appState.notifications.current = {
      color: 'success',
      key: 'plain',
      text: 'Plain notice',
    }
    const rendered = await renderNotifications({
      debug: true,
      mcpClients: [{ name: 'server-a' }] as never,
      verbose: true,
    })

    try {
      expect(rendered.output()).toContain('IDE:none:1')
      expect(rendered.output()).toContain('Plain notice')
      expect(rendered.output()).toContain('Debug mode')
      expect(rendered.output()).toContain('1234 tokens')
      expect(rendered.output()).toContain('TokenWarning:1234:gpt-5.4')
      expect(rendered.output()).toContain('AutoUpdater:true:false:true:none')
      expect(rendered.output()).toContain('MemoryUsage')
      expect(rendered.output()).toContain('SandboxHint')
      expect(harness.mcpClientsSeen).toEqual([{ name: 'server-a' }])

      expect(harness.envHookNotifier).toEqual(expect.any(Function))
      harness.envHookNotifier?.('env changed', false)
      harness.envHookNotifier?.('env failed', true)
      expect(harness.addNotification).toHaveBeenCalledWith({
        key: 'env-hook',
        text: 'env changed',
        color: undefined,
        priority: 'low',
        timeoutMs: 5000,
      })
      expect(harness.addNotification).toHaveBeenCalledWith({
        key: 'env-hook',
        text: 'env failed',
        color: 'error',
        priority: 'medium',
        timeoutMs: 8000,
      })
    } finally {
      await rendered.dispose()
    }

    expect(harness.envHookNotifier).toBeNull()
  })

  test('shows external editor hint and suppresses updater when an IDE selection owns the footer', async () => {
    harness.appState.notifications.current = {
      jsx: <Text>JSX notice</Text>,
      key: 'jsx',
    }
    harness.editor = 'vscode'
    harness.ideStatus = 'connected'
    const rendered = await renderNotifications({
      autoUpdaterResult: { status: 'success' } as never,
      ideSelection: { filePath: 'src/app.ts', lineCount: 0, text: '' } as never,
      isInputWrapped: true,
    })

    try {
      expect(rendered.output()).toContain('IDE:src/app.ts')
      expect(rendered.output()).toContain('JSX notice')
      expect(rendered.output()).not.toContain('AutoUpdater:')
      expect(harness.autoUpdaterProps).toHaveLength(0)
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'external-editor-hint',
          priority: 'immediate',
          timeoutMs: 5000,
        }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('renders auth failures and compact auto-updater state without editor hints', async () => {
    harness.remoteMode = true
    harness.compactWarning = true
    harness.editor = 'vscode'
    const rendered = await renderNotifications({
      apiKeyStatus: 'invalid',
      autoUpdaterResult: { status: 'success' } as never,
      isInputWrapped: true,
      verbose: true,
    })

    try {
      expect(rendered.output()).toContain('Authentication error · Try again')
      expect(rendered.output()).not.toContain('1234 tokens')
      expect(rendered.output()).toContain('AutoUpdater:true:false:false:success')
      expect(harness.removeNotification).toHaveBeenCalledWith(
        'external-editor-hint',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('renders local missing-auth copy', async () => {
    const rendered = await renderNotifications({
      apiKeyStatus: 'missing',
    })

    try {
      expect(rendered.output()).toContain('Not logged in · Run /login')
    } finally {
      await rendered.dispose()
    }
  })

  test('renders remote free-plan upgrade copy when managed keys are unavailable', async () => {
    harness.remoteAuthSession = true
    harness.remoteSubscriptionTier = 'free'
    const rendered = await renderNotifications({
      apiKeyStatus: 'missing',
    })

    try {
      expect(rendered.output()).toContain(
        'AgenC free plan · upgrade at https://id.agenc.ag/pricing or add a BYOK key',
      )
      expect(rendered.output()).not.toContain('Not logged in · Run /login')
    } finally {
      await rendered.dispose()
    }
  })

  test('renders remote paid-plan managed-key status', async () => {
    harness.remoteAuthSession = true
    harness.remoteManagedKeys = true
    harness.remoteSubscriptionTier = 'pro'
    const rendered = await renderNotifications({
      apiKeyStatus: 'missing',
    })

    try {
      expect(rendered.output()).toContain(
        'AgenC pro plan · managed model keys available',
      )
      expect(rendered.output()).not.toContain('Not logged in · Run /login')
    } finally {
      await rendered.dispose()
    }
  })

  test('suppresses team overage and token warnings in brief mode', async () => {
    harness.appState.isBriefOnly = true
    harness.features.add('KAIROS')
    harness.subscriptionType = 'team'
    const rendered = await renderNotifications()

    try {
      expect(rendered.output()).not.toContain('TokenWarning:')
    } finally {
      await rendered.dispose()
    }
  })
})
