// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import type * as React from 'react';
import type { HomeContext } from '../../config/home.js';
import { formatNumber } from '../../utils/format.js';
import type { getRuntimeState } from '../../utils/config.js';
import { getAnthropicApiKeyWithSourceForContext, getPrimaryApiKeyFromSecureStorage, getAuthTokenSourceForContext, isAgenCAISubscriberForContext, selectedProviderUsesExternalAuth, type ProviderAuthReadContext } from '../../utils/auth.js';
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js';
import { getAgentDescriptionsTotalTokens, AGENT_DESCRIPTIONS_THRESHOLD } from '../../utils/statusNoticeHelpers.js';
import { isSupportedJetBrainsTerminal, toIDEDisplayName, getTerminalIdeType } from '../../utils/ide.js';
import { isJetBrainsPluginInstalledCachedSync } from '../../utils/jetbrains.js';

// Types
export type StatusNoticeType = 'warning' | 'error' | 'success' | 'info';
export type StatusNoticeContext = {
  config: ReturnType<typeof getRuntimeState>;
  homeContext: HomeContext;
  providerAuthContext: ProviderAuthReadContext;
  agentDefinitions?: AgentDefinitionsResult;
  memoryDiagnostics: string[];
  daemonStatus: {
    autostartDisabled: boolean;
    /** Set when daemon autostart failed at CLI startup (message text). */
    autostartFailure?: string;
  };
};
export type StatusNoticeDefinition = {
  id: string;
  type: StatusNoticeType;
  authScope?: 'anthropic';
  isActive: (context: StatusNoticeContext) => boolean;
  render: (context: StatusNoticeContext) => React.ReactNode;
};
type AuthTokenSource = ReturnType<typeof getAuthTokenSourceForContext>['source'];
type ApiKeySourceResult = ReturnType<typeof getAnthropicApiKeyWithSourceForContext>;

function readApiKeyWithSource(
  context: ProviderAuthReadContext,
): ApiKeySourceResult {
  try {
    return getAnthropicApiKeyWithSourceForContext(context);
  } catch {
    return { key: null, source: 'none' };
  }
}

function readAuthTokenSource(
  context: ProviderAuthReadContext,
): ReturnType<typeof getAuthTokenSourceForContext> {
  try {
    return getAuthTokenSourceForContext(context);
  } catch {
    return { source: 'none', hasToken: false };
  }
}

function readSubscriberStatus(context: ProviderAuthReadContext): boolean {
  try {
    return isAgenCAISubscriberForContext(context);
  } catch {
    return false;
  }
}

function hasManagedApiKey(context: ProviderAuthReadContext): boolean {
  try {
    return getPrimaryApiKeyFromSecureStorage(context.home) !== null;
  } catch {
    return false;
  }
}

function getAuthTokenDisplayName(source: AuthTokenSource): string {
  switch (source) {
    case 'ANTHROPIC_AUTH_TOKEN':
    case 'AGENC_OAUTH_TOKEN':
    case 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR':
      return source;
    case 'native-secure-storage':
      return 'native secure storage';
    case 'none':
      return 'token auth';
    default:
      return 'AgenC account token';
  }
}

function getAuthTokenCleanupHint(source: AuthTokenSource): string {
  switch (source) {
    case 'ANTHROPIC_AUTH_TOKEN':
    case 'AGENC_OAUTH_TOKEN':
      return `Unset the ${source} environment variable, or run agenc /logout.`;
    case 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR':
      return 'Restart without the inherited OAuth token, or run agenc /logout.';
    case 'native-secure-storage':
      return 'Run agenc /logout to clear persisted authentication.';
    case 'none':
      return 'No token source is active.';
    default:
      return 'Run agenc /logout to sign out of the AgenC account.';
  }
}

// Individual notice definitions
const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: ctx => ctx.memoryDiagnostics.length > 0,
  render: ctx => {
    return `${ctx.memoryDiagnostics.join(' · ')} · /memory · open`;
  }
};
const agencAccountExternalTokenNotice: StatusNoticeDefinition = {
  id: 'agenc-account-external-token',
  type: 'warning',
  authScope: 'anthropic',
  isActive: ctx => {
    const authTokenInfo = readAuthTokenSource(ctx.providerAuthContext);
    return readSubscriberStatus(ctx.providerAuthContext) && authTokenInfo.source === 'ANTHROPIC_AUTH_TOKEN';
  },
  render: ctx => {
    const authTokenInfo = readAuthTokenSource(ctx.providerAuthContext);
    return `Auth conflict: Using ${authTokenInfo.source} instead of AgenC account subscription token. Either unset ${authTokenInfo.source}, or run agenc /logout.`;
  }
};
const apiKeyConflictNotice: StatusNoticeDefinition = {
  id: 'api-key-conflict',
  type: 'warning',
  authScope: 'anthropic',
  isActive: ctx => {
    const {
      source: apiKeySource
    } = readApiKeyWithSource(ctx.providerAuthContext);
    return apiKeySource === 'ANTHROPIC_API_KEY' &&
      hasManagedApiKey(ctx.providerAuthContext);
  },
  render: ctx => {
    const {
      source: apiKeySource
    } = readApiKeyWithSource(ctx.providerAuthContext);
    return `Auth conflict: Using ${apiKeySource} instead of provider Console key. Either unset ${apiKeySource}, or run agenc /logout.`;
  }
};
const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  authScope: 'anthropic',
  isActive: ctx => {
    const {
      source: apiKeySource
    } = readApiKeyWithSource(ctx.providerAuthContext);
    const authTokenInfo = readAuthTokenSource(ctx.providerAuthContext);
    return apiKeySource !== 'none' && authTokenInfo.source !== 'none';
  },
  render: ctx => {
    const {
      source: apiKeySource
    } = readApiKeyWithSource(ctx.providerAuthContext);
    const authTokenInfo = readAuthTokenSource(ctx.providerAuthContext);
    const authTokenDisplayName = getAuthTokenDisplayName(authTokenInfo.source);
    const apiKeyCleanup = apiKeySource === 'ANTHROPIC_API_KEY' ? 'Unset the ANTHROPIC_API_KEY environment variable, or run agenc /logout then decline API key approval before login.' : 'Run agenc /logout.';
    return `Auth conflict: Both a token (${authTokenDisplayName}) and an API key (${apiKeySource}) are set. This may lead to unexpected behavior. Trying to use ${authTokenDisplayName}? ${apiKeyCleanup} Trying to use ${apiKeySource}? ${getAuthTokenCleanupHint(authTokenInfo.source)}`;
  }
};
const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return totalTokens > AGENT_DESCRIPTIONS_THRESHOLD;
  },
  render: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return `Large cumulative agent descriptions will impact performance (~${formatNumber(totalTokens)} tokens > ${formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)}) · /agents · manage`;
  }
};
const daemonAutostartNotice: StatusNoticeDefinition = {
  id: 'daemon-autostart-disabled',
  type: 'info',
  isActive: context => context.daemonStatus.autostartDisabled,
  render: () => {
    return 'AgenC daemon autostart is disabled. Background agents and reconnectable sessions require a running daemon. · agenc daemon start';
  }
};
const daemonAutostartFailedNotice: StatusNoticeDefinition = {
  id: 'daemon-autostart-failed',
  type: 'error',
  isActive: context => Boolean(context.daemonStatus.autostartFailure),
  render: context => {
    return `AgenC daemon autostart failed: ${context.daemonStatus.autostartFailure}. Background agents and reconnectable sessions are unavailable. · agenc daemon start`;
  }
};
const jetbrainsPluginNotice: StatusNoticeDefinition = {
  id: 'jetbrains-plugin-install',
  type: 'info',
  isActive: context => {
    // Only show if running in JetBrains built-in terminal
    if (!isSupportedJetBrainsTerminal()) {
      return false;
    }
    // Don't show if auto-install is disabled
    const shouldAutoInstall = context.config.autoInstallIdeExtension ?? true;
    if (!shouldAutoInstall) {
      return false;
    }
    // Check if plugin is already installed (cached to avoid repeated filesystem checks)
    const ideType = getTerminalIdeType();
    return ideType !== null && !isJetBrainsPluginInstalledCachedSync(ideType);
  },
  render: () => {
    const ideType = getTerminalIdeType();
    const ideName = toIDEDisplayName(ideType);
    return `Install the ${ideName} plugin from the JetBrains Marketplace.`;
  }
};

// All notice definitions
export const statusNoticeDefinitions: StatusNoticeDefinition[] = [largeMemoryFilesNotice, largeAgentDescriptionsNotice, daemonAutostartNotice, daemonAutostartFailedNotice, agencAccountExternalTokenNotice, apiKeyConflictNotice, bothAuthMethodsNotice, jetbrainsPluginNotice];

// Helper functions for external use
export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  const externalAuth = selectedProviderUsesExternalAuth(
    context.providerAuthContext.provider,
  );
  return statusNoticeDefinitions.filter(
    notice =>
      !(externalAuth && notice.authScope === 'anthropic') &&
      notice.isActive(context),
  );
}
