import * as React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type {
  StatusNoticeContext,
  StatusNoticeDefinition,
} from './statusNoticeDefinitions.js'

type AuthSource =
  | 'ANTHROPIC_AUTH_TOKEN'
  | 'AGENC_OAUTH_TOKEN'
  | 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR'
  | 'CCR_OAUTH_TOKEN_FILE'
  | 'apiKeyHelper'
  | 'managedOAuth'
  | 'none'
type ApiKeySource =
  | 'ANTHROPIC_API_KEY'
  | '/login managed key'
  | 'apiKeyHelper'
  | 'none'

const mocks = vi.hoisted(() => ({
  agentTokens: 0,
  apiKeyConfigured: false,
  apiKeySource: 'none' as ApiKeySource,
  authTokenSource: {
    hasToken: false,
    source: 'none' as AuthSource,
  },
  pluginInstalled: true,
  subscriber: false,
  supportedIde: false,
  terminalIdeType: null as string | null,
}))

vi.mock('../ink.js', async () => {
  const React = await import('react')
  return {
    Box: ({ children }: { readonly children?: React.ReactNode }) =>
      React.createElement('ink-box', null, children),
    Text: ({ children }: { readonly children?: React.ReactNode }) =>
      React.createElement('ink-text', null, children),
  }
})

vi.mock('../../utils/auth.js', () => ({
  getApiKeyFromConfigOrMacOSKeychain: () =>
    mocks.apiKeyConfigured ? 'configured-key' : null,
  getAuthTokenSource: () => mocks.authTokenSource,
  getproviderApiKeyWithSource: () => ({ source: mocks.apiKeySource }),
  isAgenCAISubscriber: () => mocks.subscriber,
}))

vi.mock('../../utils/format.js', () => ({
  formatNumber: (value: number) => String(value),
}))

vi.mock('../../utils/ide.js', () => ({
  getTerminalIdeType: () => mocks.terminalIdeType,
  isSupportedJetBrainsTerminal: () => mocks.supportedIde,
  toIDEDisplayName: (ideType: string | null) => ideType ?? 'JetBrains IDE',
}))

vi.mock('../../utils/jetbrains.js', () => ({
  isJetBrainsPluginInstalledCachedSync: () => mocks.pluginInstalled,
}))

vi.mock('../../utils/statusNoticeHelpers.js', () => ({
  AGENT_DESCRIPTIONS_THRESHOLD: 100,
  getAgentDescriptionsTotalTokens: () => mocks.agentTokens,
}))

function baseContext(
  overrides: Partial<StatusNoticeContext> = {},
): StatusNoticeContext {
  return {
    config: {
      autoInstallIdeExtension: true,
    } as StatusNoticeContext['config'],
    daemonStatus: {
      autostartDisabled: false,
    },
    memoryDiagnostics: [],
    ...overrides,
  }
}

function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (React.isValidElement(node)) {
    return collectText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

function noticeById(
  notices: readonly StatusNoticeDefinition[],
  id: string,
): StatusNoticeDefinition {
  const notice = notices.find(candidate => candidate.id === id)
  expect(notice).toBeDefined()
  return notice as StatusNoticeDefinition
}

describe('statusNoticeDefinitions wave200-142 coverage', () => {
  beforeEach(() => {
    mocks.agentTokens = 0
    mocks.apiKeyConfigured = false
    mocks.apiKeySource = 'none'
    mocks.authTokenSource = { hasToken: false, source: 'none' }
    mocks.pluginInstalled = true
    mocks.subscriber = false
    mocks.supportedIde = false
    mocks.terminalIdeType = null
  })

  test('renders fallback notice guidance for diagnostics, auth, and IDE setup', async () => {
    const { getActiveNotices, statusNoticeDefinitions } = await import(
      './statusNoticeDefinitions.js'
    )

    mocks.agentTokens = 101
    const diagnosticsContext = baseContext({
      memoryDiagnostics: ['Large AGENC.md will slow startup'],
    })
    const diagnosticIds = getActiveNotices(diagnosticsContext).map(
      notice => notice.id,
    )

    expect(diagnosticIds).toContain('large-memory-files')
    expect(diagnosticIds).toContain('large-agent-descriptions')
    expect(
      collectText(
        noticeById(statusNoticeDefinitions, 'large-memory-files').render(
          diagnosticsContext,
        ),
      ),
    ).toContain('Large AGENC.md will slow startup')
    expect(
      collectText(
        noticeById(statusNoticeDefinitions, 'large-agent-descriptions').render(
          diagnosticsContext,
        ),
      ),
    ).toContain('101 tokens > 100')

    mocks.subscriber = true
    mocks.authTokenSource = { hasToken: true, source: 'apiKeyHelper' }
    expect(getActiveNotices(baseContext()).map(notice => notice.id)).toContain(
      'agenc-account-external-token',
    )
    expect(
      collectText(
        noticeById(
          statusNoticeDefinitions,
          'agenc-account-external-token',
        ).render(baseContext()),
      ),
    ).toContain('Using apiKeyHelper instead of AgenC account')

    mocks.apiKeyConfigured = true
    mocks.apiKeySource = 'apiKeyHelper'
    expect(getActiveNotices(baseContext()).map(notice => notice.id)).toContain(
      'api-key-conflict',
    )
    expect(
      collectText(
        noticeById(statusNoticeDefinitions, 'api-key-conflict').render(
          baseContext(),
        ),
      ),
    ).toContain('Using apiKeyHelper instead of provider Console key')
    expect(getActiveNotices(baseContext()).map(notice => notice.id)).not.toContain(
      'both-auth-methods',
    )

    const bothAuthNotice = noticeById(statusNoticeDefinitions, 'both-auth-methods')
    const cleanupCases: Array<{
      readonly apiKeySource: ApiKeySource
      readonly expected: string
      readonly source: AuthSource
    }> = [
      {
        apiKeySource: '/login managed key',
        expected: 'Unset the ANTHROPIC_AUTH_TOKEN environment variable',
        source: 'ANTHROPIC_AUTH_TOKEN',
      },
      {
        apiKeySource: '/login managed key',
        expected: 'Restart without the inherited OAuth token',
        source: 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR',
      },
      {
        apiKeySource: '/login managed key',
        expected: 'Remove the managed OAuth token file',
        source: 'CCR_OAUTH_TOKEN_FILE',
      },
      {
        apiKeySource: 'apiKeyHelper',
        expected: 'Unset the apiKeyHelper setting',
        source: 'apiKeyHelper',
      },
      {
        apiKeySource: '/login managed key',
        expected: 'No token source is active',
        source: 'none',
      },
      {
        apiKeySource: '/login managed key',
        expected: 'sign out of the AgenC account',
        source: 'managedOAuth',
      },
    ]

    for (const cleanupCase of cleanupCases) {
      mocks.apiKeySource = cleanupCase.apiKeySource
      mocks.authTokenSource = {
        hasToken: cleanupCase.source !== 'none',
        source: cleanupCase.source,
      }

      expect(collectText(bothAuthNotice.render(baseContext()))).toContain(
        cleanupCase.expected,
      )
    }

    mocks.supportedIde = true
    mocks.terminalIdeType = 'IntelliJ IDEA'
    mocks.pluginInstalled = false

    expect(
      getActiveNotices(
        baseContext({
          config: {} as StatusNoticeContext['config'],
        }),
      ).map(notice => notice.id),
    ).toContain('jetbrains-plugin-install')
    expect(
      getActiveNotices(
        baseContext({
          config: {
            autoInstallIdeExtension: false,
          } as StatusNoticeContext['config'],
        }),
      ).map(notice => notice.id),
    ).not.toContain('jetbrains-plugin-install')
  })
})
