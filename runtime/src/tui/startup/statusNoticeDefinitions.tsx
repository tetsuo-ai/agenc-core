// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import type * as React from 'react';
import { formatNumber } from '../../utils/format.js';
import type { getGlobalConfig } from '../../utils/config.js';
import { getproviderApiKeyWithSource, getApiKeyFromConfigOrMacOSKeychain, getAuthTokenSource, isAgenCAISubscriber } from '../../utils/auth.js';
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js';
import { getAgentDescriptionsTotalTokens, AGENT_DESCRIPTIONS_THRESHOLD } from '../../utils/statusNoticeHelpers.js';
import { isSupportedJetBrainsTerminal, toIDEDisplayName, getTerminalIdeType } from '../../utils/ide.js';
import { isJetBrainsPluginInstalledCachedSync } from '../../utils/jetbrains.js';

// Types
export type StatusNoticeType = 'warning' | 'error' | 'success' | 'info';
export type StatusNoticeContext = {
  config: ReturnType<typeof getGlobalConfig>;
  agentDefinitions?: AgentDefinitionsResult;
  memoryDiagnostics: string[];
  daemonStatus: {
    autostartDisabled: boolean;
  };
};
export type StatusNoticeDefinition = {
  id: string;
  type: StatusNoticeType;
  isActive: (context: StatusNoticeContext) => boolean;
  render: (context: StatusNoticeContext) => React.ReactNode;
};
type AuthTokenSource = ReturnType<typeof getAuthTokenSource>['source'];

function getAuthTokenDisplayName(source: AuthTokenSource): string {
  switch (source) {
    case 'ANTHROPIC_AUTH_TOKEN':
    case 'AGENC_OAUTH_TOKEN':
    case 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR':
    case 'CCR_OAUTH_TOKEN_FILE':
    case 'apiKeyHelper':
      return source;
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
    case 'CCR_OAUTH_TOKEN_FILE':
      return 'Remove the managed OAuth token file, or run agenc /logout.';
    case 'apiKeyHelper':
      return 'Unset the apiKeyHelper setting.';
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
  isActive: () => {
    const authTokenInfo = getAuthTokenSource();
    return isAgenCAISubscriber() && (authTokenInfo.source === 'ANTHROPIC_AUTH_TOKEN' || authTokenInfo.source === 'apiKeyHelper');
  },
  render: () => {
    const authTokenInfo = getAuthTokenSource();
    return `Auth conflict: Using ${authTokenInfo.source} instead of AgenC account subscription token. Either unset ${authTokenInfo.source}, or run agenc /logout.`;
  }
};
const apiKeyConflictNotice: StatusNoticeDefinition = {
  id: 'api-key-conflict',
  type: 'warning',
  isActive: () => {
    const {
      source: apiKeySource
    } = getproviderApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    return !!getApiKeyFromConfigOrMacOSKeychain() && (apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper');
  },
  render: () => {
    const {
      source: apiKeySource
    } = getproviderApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    return `Auth conflict: Using ${apiKeySource} instead of provider Console key. Either unset ${apiKeySource}, or run agenc /logout.`;
  }
};
const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  isActive: () => {
    const {
      source: apiKeySource
    } = getproviderApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    const authTokenInfo = getAuthTokenSource();
    return apiKeySource !== 'none' && authTokenInfo.source !== 'none' && !(apiKeySource === 'apiKeyHelper' && authTokenInfo.source === 'apiKeyHelper');
  },
  render: () => {
    const {
      source: apiKeySource
    } = getproviderApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    const authTokenInfo = getAuthTokenSource();
    const authTokenDisplayName = getAuthTokenDisplayName(authTokenInfo.source);
    const apiKeyCleanup = apiKeySource === 'ANTHROPIC_API_KEY' ? 'Unset the ANTHROPIC_API_KEY environment variable, or run agenc /logout then decline API key approval before login.' : apiKeySource === 'apiKeyHelper' ? 'Unset the apiKeyHelper setting.' : 'Run agenc /logout.';
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
export const statusNoticeDefinitions: StatusNoticeDefinition[] = [largeMemoryFilesNotice, largeAgentDescriptionsNotice, daemonAutostartNotice, agencAccountExternalTokenNotice, apiKeyConflictNotice, bothAuthMethodsNotice, jetbrainsPluginNotice];

// Helper functions for external use
export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  return statusNoticeDefinitions.filter(notice => notice.isActive(context));
}
