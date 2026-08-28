// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import { type ReactNode, useEffect, useMemo } from 'react';
import { type Notification, useNotifications } from '../../context/notifications.js';
import { type AppState, useAppState } from '../../state/AppState.js';
import {
  hasEntitledRemoteAuthSessionSync,
  hasRemoteAuthSessionSync,
  remoteAuthSessionSubscriptionTierSync,
} from '../../../auth/session-state.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import { useIdeConnectionStatus } from '../../hooks/useIdeConnectionStatus.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { Box, Text } from '../../ink.js';
import { calculateTokenWarningStateForEnvironment } from '../../../services/compact/autoCompact.js';
import type { ProviderEnvironment } from '../../../llm/provider-options.js';
import type { MCPServerConnection } from '../../../services/mcp/types.js';
import type { Message } from '../../../types/message.js';
import type { ProviderAuthReadContext } from '../../../utils/auth.js';
import type { AutoUpdaterResult } from '../../../utils/autoUpdater.js';
import { getExternalEditor } from '../../../utils/editor.js';
import { getIsRemoteMode } from '../../../bootstrap/state.js';
import { setEnvHookNotifier } from '../../../utils/hooks/cwdChangedHooks.js';
import { toIDEDisplayName } from '../../../utils/ide.js';
import { getMessagesAfterCompactBoundary } from '../../../utils/messages.js';
import { isRegistryOwnedNonAnthropicModel, usesAnthropicAccountFlow } from '../../../utils/model/providers.js';
import { tokenCountFromLastAPIResponse } from '../../../utils/tokens.js';
import { AutoUpdaterWrapper } from '../AutoUpdaterWrapper.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { IdeStatusIndicator } from '../IdeStatusIndicator.js';
import { MemoryUsageIndicator } from '../../cost/MemoryUsageIndicator.js';
import { TuiErrorBoundary } from '../TuiErrorBoundary.js';
import { TokenWarning } from '../../cost/TokenWarning.js';
import { SandboxPromptFooterHint } from './SandboxPromptFooterHint.js';

export const FOOTER_TEMPORARY_STATUS_TIMEOUT = 5000;
type Props = {
  apiKeyStatus: VerificationStatus;
  autoUpdaterResult: AutoUpdaterResult | null;
  isAutoUpdating: boolean;
  debug: boolean;
  verbose: boolean;
  // The transcript arrives as a stable accessor + the id of the last assistant
  // message (the recompute trigger for the token count below), never as an
  // array prop: a fresh array per streaming flush would recompute the token
  // count at token rate.
  getMessages: () => Message[];
  lastAssistantMessageId: string | null;
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  remoteAuthSessionContext: ProviderAuthReadContext;
  isInputWrapped?: boolean;
  isNarrow?: boolean;
};
export function Notifications(t0: Props) {
  const $ = _c(35);
  const {
    apiKeyStatus,
    autoUpdaterResult,
    debug,
    isAutoUpdating,
    verbose,
    getMessages,
    lastAssistantMessageId,
    onAutoUpdaterResult,
    onChangeIsUpdating,
    ideSelection,
    mcpClients,
    remoteAuthSessionContext,
    isInputWrapped: t1,
    isNarrow: t2
  } = t0;
  const isInputWrapped = t1 === undefined ? false : t1;
  const isNarrow = t2 === undefined ? false : t2;
  let t3;
  if ($[0] !== lastAssistantMessageId) {
    const messagesForTokenCount = getMessagesAfterCompactBoundary(getMessages());
    t3 = tokenCountFromLastAPIResponse(messagesForTokenCount);
    $[0] = lastAssistantMessageId;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  const tokenUsage = t3;
  const mainLoopModel = useMainLoopModel();
  const t4 = useMemo(
    () => calculateTokenWarningStateForEnvironment(
      tokenUsage,
      mainLoopModel,
      remoteAuthSessionContext.environment,
    ),
    [mainLoopModel, remoteAuthSessionContext.environment, tokenUsage],
  );
  const isShowingCompactMessage = t4.isAboveWarningThreshold;
  const {
    status: ideStatus
  } = useIdeConnectionStatus(mcpClients);
  const notifications = useAppState(_temp);
  const {
    addNotification,
    removeNotification
  } = useNotifications();
  let t5;
  let t6;
  if ($[5] !== addNotification) {
    t5 = () => {
      setEnvHookNotifier((text, isError) => {
        addNotification({
          key: "env-hook",
          text,
          color: isError ? "error" : undefined,
          priority: isError ? "medium" : "low",
          timeoutMs: isError ? 8000 : 5000
        });
      });
      return _temp2;
    };
    t6 = [addNotification];
    $[5] = addNotification;
    $[6] = t5;
    $[7] = t6;
  } else {
    t5 = $[6];
    t6 = $[7];
  }
  useEffect(t5, t6);
  const shouldShowIdeSelection = ideStatus === "connected" && (ideSelection?.filePath || ideSelection?.text && ideSelection.lineCount > 0);
  const shouldShowAutoUpdater = !shouldShowIdeSelection || isAutoUpdating || autoUpdaterResult?.status !== "success";
  const hasRemoteAuthSession = hasRemoteAuthSessionSync(remoteAuthSessionContext);
  const remoteSubscriptionTier = remoteAuthSessionSubscriptionTierSync(remoteAuthSessionContext);
  const hasRemoteManagedKeys = hasEntitledRemoteAuthSessionSync(remoteAuthSessionContext);
  const usesAccountFlow = usesAnthropicAccountFlow(remoteAuthSessionContext.provider);
  const shouldShowRemoteAuthPlan = usesAccountFlow && !isRegistryOwnedNonAnthropicModel(mainLoopModel) && hasRemoteAuthSession && (apiKeyStatus === 'invalid' || apiKeyStatus === 'missing');
  let t8;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = getExternalEditor();
    $[9] = t8;
  } else {
    t8 = $[9];
  }
  const editor = t8;
  const shouldShowExternalEditorHint = isInputWrapped && !isShowingCompactMessage && apiKeyStatus !== "invalid" && apiKeyStatus !== "missing" && editor !== undefined;
  let t10;
  let t9;
  if ($[10] !== addNotification || $[11] !== removeNotification || $[12] !== shouldShowExternalEditorHint) {
    t9 = () => {
      if (shouldShowExternalEditorHint && editor) {
        addNotification({
          key: "external-editor-hint",
          jsx: <Text dimColor={true}><ConfigurableShortcutHint action="chat:externalEditor" context="Chat" fallback="ctrl+g" description={`edit in ${toIDEDisplayName(editor)}`} /></Text>,
          priority: "immediate",
          timeoutMs: 5000
        });
      } else {
        removeNotification("external-editor-hint");
      }
    };
    t10 = [shouldShowExternalEditorHint, editor, addNotification, removeNotification];
    $[10] = addNotification;
    $[11] = removeNotification;
    $[12] = shouldShowExternalEditorHint;
    $[13] = t10;
    $[14] = t9;
  } else {
    t10 = $[13];
    t9 = $[14];
  }
  useEffect(t9, t10);
  const t11 = isNarrow ? "flex-start" : "flex-end";
  const t13 = <NotificationContent ideSelection={ideSelection} mcpClients={mcpClients} notifications={notifications} apiKeyStatus={apiKeyStatus} debug={debug} verbose={verbose} tokenUsage={tokenUsage} mainLoopModel={mainLoopModel} providerEnvironment={remoteAuthSessionContext.environment} shouldShowAutoUpdater={shouldShowAutoUpdater} autoUpdaterResult={autoUpdaterResult} isAutoUpdating={isAutoUpdating} isShowingCompactMessage={isShowingCompactMessage} onAutoUpdaterResult={onAutoUpdaterResult} onChangeIsUpdating={onChangeIsUpdating} hasRemoteAuthSession={hasRemoteAuthSession} remoteSubscriptionTier={remoteSubscriptionTier} hasRemoteManagedKeys={hasRemoteManagedKeys} shouldShowRemoteAuthPlan={shouldShowRemoteAuthPlan} usesAccountFlow={usesAccountFlow} />;
  let t14;
  if ($[31] !== t11 || $[32] !== t13) {
    t14 = <TuiErrorBoundary><Box flexDirection="column" alignItems={t11} flexShrink={0} overflowX="hidden">{t13}</Box></TuiErrorBoundary>;
    $[31] = t11;
    $[32] = t13;
    $[33] = t14;
  } else {
    t14 = $[33];
  }
  return t14;
}
function _temp2() {
  return setEnvHookNotifier(null);
}
function _temp(s: AppState) {
  return s.notifications;
}
function NotificationContent({
  ideSelection,
  mcpClients,
  notifications,
  apiKeyStatus,
  debug,
  verbose,
  tokenUsage,
  mainLoopModel,
  providerEnvironment,
  shouldShowAutoUpdater,
  autoUpdaterResult,
  isAutoUpdating,
  isShowingCompactMessage,
  onAutoUpdaterResult,
  onChangeIsUpdating,
  hasRemoteAuthSession,
  remoteSubscriptionTier,
  hasRemoteManagedKeys,
  shouldShowRemoteAuthPlan,
  usesAccountFlow
}: {
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  notifications: {
    current: Notification | null;
    queue: Notification[];
  };
  apiKeyStatus: VerificationStatus;
  debug: boolean;
  verbose: boolean;
  tokenUsage: number;
  mainLoopModel: string;
  providerEnvironment: ProviderEnvironment;
  shouldShowAutoUpdater: boolean;
  autoUpdaterResult: AutoUpdaterResult | null;
  isAutoUpdating: boolean;
  isShowingCompactMessage: boolean;
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  hasRemoteAuthSession: boolean;
  remoteSubscriptionTier: string | undefined;
  hasRemoteManagedKeys: boolean;
  shouldShowRemoteAuthPlan: boolean;
  usesAccountFlow: boolean;
}): ReactNode {
  const isBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState((s_1: AppState) => s_1.isBriefOnly) : false;

  return <>
      <IdeStatusIndicator ideSelection={ideSelection} mcpClients={mcpClients} />
      {notifications.current && ('jsx' in notifications.current ? <Text wrap="truncate" key={notifications.current.key}>
            {notifications.current.jsx}
          </Text> : <Text color={notifications.current.color} dimColor={!notifications.current.color} wrap={notifications.current.wrap === true ? "wrap" : "truncate"}>
            {notifications.current.text}
          </Text>)}
      {usesAccountFlow && !isRegistryOwnedNonAnthropicModel(mainLoopModel) && !hasRemoteAuthSession && (apiKeyStatus === 'invalid' || apiKeyStatus === 'missing') && <Box>
          <Text color="error" wrap="truncate">
            {getIsRemoteMode() ? 'Authentication error · Try again' : 'Not logged in · Run /login'}
          </Text>
        </Box>}
      {shouldShowRemoteAuthPlan && <Box>
          <Text color={hasRemoteManagedKeys ? "success" : "warning"} wrap="truncate">
            {remoteAuthPlanNotice(remoteSubscriptionTier, hasRemoteManagedKeys)}
          </Text>
        </Box>}
      {debug && <Box>
          <Text color="warning" wrap="truncate">
            Debug mode
          </Text>
        </Box>}
      {apiKeyStatus !== 'invalid' && apiKeyStatus !== 'missing' && verbose && <Box>
          <Text dimColor wrap="truncate">
            {tokenUsage} tokens
          </Text>
        </Box>}
      {!isBriefOnly && <TokenWarning tokenUsage={tokenUsage} model={mainLoopModel} environment={providerEnvironment} />}
      {shouldShowAutoUpdater && <AutoUpdaterWrapper verbose={verbose} onAutoUpdaterResult={onAutoUpdaterResult} autoUpdaterResult={autoUpdaterResult} isUpdating={isAutoUpdating} onChangeIsUpdating={onChangeIsUpdating} showSuccessMessage={!isShowingCompactMessage} />}
      <MemoryUsageIndicator />
      <SandboxPromptFooterHint />
    </>;
}

function remoteAuthPlanNotice(
  tier: string | undefined,
  hasManagedKeys: boolean,
): string {
  const label = tier ?? "unknown";
  if (hasManagedKeys) {
    return `AgenC ${label} plan · managed model keys available`;
  }
  return `AgenC ${label} plan · upgrade at https://id.agenc.ag/pricing or add a BYOK key`;
}
