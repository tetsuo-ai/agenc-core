import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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
            jsx?: React.ReactNode
          },
      queue: [] as unknown[],
    },
  },
  autoUpdaterProps: [] as Array<Record<string, unknown>>,
  compactWarning: false,
  editor: undefined as string | undefined,
  envHookNotifier: null as null | ((text: string, isError?: boolean) => void),
  features: new Set<string>(),
  helperConfigured: false,
  helperElapsedMs: 0,
  ideStatus: 'disconnected' as 'connected' | 'disconnected',
  mcpClientsSeen: undefined as unknown,
  model: 'gpt-5.4',
  removeNotification: vi.fn(),
  subscriptionType: 'pro' as 'enterprise' | 'pro' | 'team',
  tokenUsage: 1234,
  usesAnthropicAccountFlow: true,
  usingOverage: false,
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../services/compact/autoCompact.js', () => ({
  calculateTokenWarningState: (tokenUsage: number, model: string) => ({
    isAboveWarningThreshold: harness.compactWarning,
    model,
    tokenUsage,
  }),
}))

vi.mock('../../../utils/auth.js', () => ({
  getApiKeyHelperElapsedMs: () => harness.helperElapsedMs,
  getConfiguredApiKeyHelper: () =>
    harness.helperConfigured ? 'echo helper' : null,
  getSubscriptionType: () => harness.subscriptionType,
}))

vi.mock('../../../utils/editor.js', () => ({
  getExternalEditor: () => harness.editor,
}))

vi.mock('../../../utils/envUtils.js', () => ({
  isEnvTruthy: (value: string | undefined) =>
    value === '1' || value === 'true' || value === 'yes',
}))

vi.mock('../../../utils/format.js', () => ({
  formatDuration: (ms: number) => `${ms}ms`,
}))

vi.mock('../../../utils/hooks/fileChangedWatcher.js', () => ({
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

vi.mock('../../rate-limits/agenc-ai-limits.js', () => ({
  useAgenCAiLimits: () => ({ isUsingOverage: harness.usingOverage }),
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
      model,
      tokenUsage,
    }: {
      model: string
      tokenUsage: number
    }) => ReactModule.createElement(Text, null, `TokenWarning:${tokenUsage}:${model}`),
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

const originalRemote = process.env.AGENC_REMOTE

function resetHarness() {
  harness.addNotification.mockClear()
  harness.appState.isBriefOnly = false
  harness.appState.notifications = { current: null, queue: [] }
  harness.autoUpdaterProps = []
  harness.compactWarning = false
  harness.editor = undefined
  harness.envHookNotifier = null
  harness.features = new Set()
  harness.helperConfigured = false
  harness.helperElapsedMs = 0
  harness.ideStatus = 'disconnected'
  harness.mcpClientsSeen = undefined
  harness.model = 'gpt-5.4'
  harness.removeNotification.mockClear()
  harness.subscriptionType = 'pro'
  harness.tokenUsage = 1234
  harness.usesAnthropicAccountFlow = true
  harness.usingOverage = false
}

function baseProps(): NotificationsProps {
  return {
    apiKeyStatus: 'valid',
    autoUpdaterResult: null,
    debug: false,
    ideSelection: undefined,
    isAutoUpdating: false,
    messages: [],
    mcpClients: undefined,
    onAutoUpdaterResult: vi.fn(),
    onChangeIsUpdating: vi.fn(),
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
  if (originalRemote === undefined) {
    delete process.env.AGENC_REMOTE
  } else {
    process.env.AGENC_REMOTE = originalRemote
  }
})

afterEach(() => {
  if (originalRemote === undefined) {
    delete process.env.AGENC_REMOTE
  } else {
    process.env.AGENC_REMOTE = originalRemote
  }
  vi.restoreAllMocks()
})

describe('Notifications', () => {
  test('renders status rows and wires env hook notifications', async () => {
    harness.appState.notifications.current = {
      color: 'success',
      key: 'plain',
      text: 'Plain notice',
    }
    harness.usingOverage = true
    const rendered = await renderNotifications({
      debug: true,
      mcpClients: [{ name: 'server-a' }] as never,
      verbose: true,
    })

    try {
      expect(rendered.output()).toContain('IDE:none:1')
      expect(rendered.output()).toContain('Plain notice')
      expect(rendered.output()).toContain('Now using extra usage')
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
    process.env.AGENC_REMOTE = 'true'
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

  test('shows slow apiKeyHelper notice and suppresses team overage in brief mode', async () => {
    harness.appState.isBriefOnly = true
    harness.features.add('KAIROS')
    harness.helperConfigured = true
    harness.helperElapsedMs = 12_000
    harness.subscriptionType = 'team'
    harness.usingOverage = true
    const rendered = await renderNotifications()

    try {
      await sleep(1100)

      expect(rendered.output()).toContain('apiKeyHelper is taking a while')
      expect(rendered.output()).toContain('(12000ms)')
      expect(rendered.output()).not.toContain('Now using extra usage')
      expect(rendered.output()).not.toContain('TokenWarning:')
    } finally {
      await rendered.dispose()
    }
  })
})
