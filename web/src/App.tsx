import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewId, WSMessage, ApprovalRequest } from './types';
import {
  WS_VOICE_SPEECH_STOPPED,
  WS_VOICE_DELEGATION,
  WS_VOICE_USER_TRANSCRIPT,
  WS_VOICE_TRANSCRIPT,
  WS_VOICE_RESPONSE_DONE,
} from './constants';
import { useWebSocket } from './hooks/useWebSocket';
import { useTheme } from './hooks/useTheme';
import { useChat } from './hooks/useChat';
import { useVoice } from './hooks/useVoice';
import { useAgentStatus } from './hooks/useAgentStatus';
import { useTools } from './hooks/useTools';
import { useTasks } from './hooks/useTasks';
import { useMarketSkills } from './hooks/useMarketSkills';
import { useGovernance } from './hooks/useGovernance';
import { useDisputes } from './hooks/useDisputes';
import { useReputation } from './hooks/useReputation';
import { useMemory } from './hooks/useMemory';
import { useApprovals } from './hooks/useApprovals';
import { useSettings } from './hooks/useSettings';
import { useWallet } from './hooks/useWallet';
import { useActivityFeed } from './hooks/useActivityFeed';
import { useAgents } from './hooks/useAgents';
import { useDesktop } from './hooks/useDesktop';
import { useRuns } from './hooks/useRuns';
import { useObservability } from './hooks/useObservability';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BBSHeader } from './components/BBSHeader';
import { BBSMenuBar } from './components/BBSMenuBar';
import { BBSStatusBar } from './components/BBSStatusBar';
import { ApprovalBanner } from './components/approvals/ApprovalBanner';
import { ApprovalDialog } from './components/approvals/ApprovalDialog';
import { ChatView } from './components/chat/ChatView';
import { AgentStatusView } from './components/dashboard/AgentStatusView';
import { ToolsView } from './components/tools/ToolsView';
import { MarketplaceView } from './components/marketplace/MarketplaceView';
import { MemoryView } from './components/memory/MemoryView';
import { ActivityFeedView } from './components/activity/ActivityFeedView';
import { ObservabilityView } from './components/observability/ObservabilityView';
import { RunDashboardView } from './components/runs/RunDashboardView';
import { SettingsView } from './components/settings/SettingsView';
import { PaymentView } from './components/payment/PaymentView';
import { DesktopView } from './components/desktop/DesktopView';
import { SimulationWorkspace } from './components/simulation';
import {
  DEFAULT_SIMULATION_ROUTE,
  readSimulationRouteFromUrl,
  readViewFromUrl,
  writeAppNavigationToUrl,
  type SimulationWorkspaceRoute,
} from './components/simulation/navigation';

const CHAT_COMPOSER_SELECTOR = 'textarea[data-chat-composer="true"]';

interface ComposerFocusSnapshot {
  element: HTMLTextAreaElement;
  selectionStart: number;
  selectionEnd: number;
}

function captureFocusedComposer(): ComposerFocusSnapshot | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLTextAreaElement)) return null;
  if (active.dataset.chatComposer !== 'true') return null;

  return {
    element: active,
    selectionStart: active.selectionStart ?? active.value.length,
    selectionEnd: active.selectionEnd ?? active.value.length,
  };
}

function restoreComposerFocus(snapshot: ComposerFocusSnapshot) {
  const restore = () => {
    if (typeof document === 'undefined') return;
    const active = document.activeElement;
    const target = document.body.contains(snapshot.element)
      ? snapshot.element
      : document.querySelector(CHAT_COMPOSER_SELECTOR);
    if (!(target instanceof HTMLTextAreaElement)) return;

    const activeIsNeutral =
      active === null
      || active === document.body
      || active === target
      || active instanceof HTMLIFrameElement;

    if (!activeIsNeutral) return;

    target.focus();
    const start = Math.min(snapshot.selectionStart, target.value.length);
    const end = Math.min(snapshot.selectionEnd, target.value.length);
    target.setSelectionRange(start, end);
  };

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.requestAnimationFrame(restore));
    return;
  }

  setTimeout(restore, 0);
}

function readInitialView(): ViewId {
  return typeof window === 'undefined' ? 'chat' : readViewFromUrl(window.location);
}

function readInitialSimulationRoute(): SimulationWorkspaceRoute {
  return typeof window === 'undefined'
    ? DEFAULT_SIMULATION_ROUTE
    : readSimulationRouteFromUrl(window.location);
}

function writeNavigationState(
  view: ViewId,
  simulationRoute: SimulationWorkspaceRoute,
  replace = false,
) {
  if (typeof window === 'undefined') {
    return;
  }
  const url = new URL(window.location.href);
  writeAppNavigationToUrl(url, view, simulationRoute);
  if (replace) {
    window.history.replaceState(null, '', url);
    return;
  }
  window.history.pushState(null, '', url);
}

export default function App() {
  const [currentView, setCurrentView] = useState<ViewId>(() => readInitialView());
  const [simulationRoute, setSimulationRoute] = useState<SimulationWorkspaceRoute>(() => readInitialSimulationRoute());
  const [selectedApproval, setSelectedApproval] = useState<ApprovalRequest | null>(null);
  const { theme } = useTheme();

  const handleViewChange = useCallback((view: ViewId) => {
    setCurrentView(view);
    writeNavigationState(view, simulationRoute);
  }, [simulationRoute]);

  const handleSimulationRouteChange = useCallback((
    route: SimulationWorkspaceRoute,
    options?: { replace?: boolean },
  ) => {
    setSimulationRoute(route);
    setCurrentView('simulation');
    writeNavigationState('simulation', route, options?.replace ?? false);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const onPopState = () => {
      setCurrentView(readViewFromUrl(window.location));
      setSimulationRoute(readSimulationRouteFromUrl(window.location));
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // WebSocket connection
  const { state: connectionState, send } = useWebSocket({
    onMessage: handleWSMessage,
  });

  const connected = connectionState === 'connected';

  // Type helper for hooks that expose handleMessage as an extra property
  type WithHandler<T> = T & { handleMessage: (msg: WSMessage) => void };

  // Hooks
  const chat = useChat({ send, connected });
  const handleDelegationResult = useCallback((task: string, content: string) => {
    chat.injectMessage(`[Voice] ${task}`, 'user');
    chat.injectMessage(content, 'agent');
  }, [chat]);
  const voice = useVoice({ send, onDelegationResult: handleDelegationResult });
  const agentStatus = useAgentStatus({ send, connected }) as WithHandler<ReturnType<typeof useAgentStatus>>;
  const tools = useTools({ send });
  const tasks = useTasks({ send }) as WithHandler<ReturnType<typeof useTasks>>;
  const marketSkills = useMarketSkills({ send });
  const governance = useGovernance({ send });
  const disputes = useDisputes({ send });
  const reputation = useReputation({ send });
  const memory = useMemory({ send }) as WithHandler<ReturnType<typeof useMemory>>;
  const approvals = useApprovals({ send }) as WithHandler<ReturnType<typeof useApprovals>>;
  const gatewaySettings = useSettings({ send, connected });
  const walletInfo = useWallet({ send, connected });
  const activityFeed = useActivityFeed({ send, connected });
  const agentsData = useAgents({ send, connected }) as WithHandler<ReturnType<typeof useAgents>>;
  const desktop = useDesktop({ send, connected });
  const runs = useRuns({
    send,
    connected,
    backgroundRunStatus: agentStatus.status?.backgroundRuns ?? null,
  }) as WithHandler<ReturnType<typeof useRuns>>;
  const observability = useObservability({ send, connected }) as WithHandler<
    ReturnType<typeof useObservability>
  >;
  const [desktopPanelOpen, setDesktopPanelOpen] = useState(false);
  const prevVncUrl = useRef<string | null>(null);
  const suppressNextVoiceTranscript = useRef(false);

  const sessionDesktopUrl = useMemo(
    () => desktop.vncUrlForSession(chat.sessionId)
      ?? (voice.isVoiceActive ? desktop.activeVncUrl : null),
    [desktop, chat.sessionId, voice.isVoiceActive],
  );

  const toggleDesktopPanel = useCallback(() => {
    setDesktopPanelOpen((prev) => !prev);
  }, []);

  // Auto-open desktop panel when a sandbox becomes ready
  useEffect(() => {
    if (sessionDesktopUrl && !prevVncUrl.current) {
      const focusedComposer = captureFocusedComposer();
      setDesktopPanelOpen(true);
      if (focusedComposer) {
        restoreComposerFocus(focusedComposer);
      }
    }
    prevVncUrl.current = sessionDesktopUrl;
  }, [sessionDesktopUrl]);

  // Periodically refresh sandbox list
  const desktopRefresh = desktop.refresh;
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => desktopRefresh(), 5000);
    return () => clearInterval(id);
  }, [connected, desktopRefresh]);

  // Voice toggle
  const handleVoiceToggle = useCallback(() => {
    if (voice.isVoiceActive) {
      voice.stopVoice();
    } else {
      void voice.startVoice();
    }
  }, [voice]);

  // Central message router
  function handleWSMessage(msg: WSMessage) {
    chat.handleMessage(msg);
    voice.handleMessage(msg);
    agentStatus.handleMessage(msg);
    tools.handleMessage(msg);
    tasks.handleMessage(msg);
    marketSkills.handleMessage(msg);
    governance.handleMessage(msg);
    disputes.handleMessage(msg);
    reputation.handleMessage(msg);
    memory.handleMessage(msg);
    approvals.handleMessage(msg);
    gatewaySettings.handleMessage(msg);
    walletInfo.handleMessage(msg);
    activityFeed.handleMessage(msg);
    agentsData.handleMessage(msg);
    desktop.handleMessage(msg);
    runs.handleMessage(msg);
    observability.handleMessage(msg);

    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    if (msg.type === WS_VOICE_DELEGATION) {
      const status = payload.status as string;
      if (status === 'completed') {
        suppressNextVoiceTranscript.current = true;
      } else if (status === 'started' || status === 'error' || status === 'blocked') {
        suppressNextVoiceTranscript.current = false;
      }
    }
    if (msg.type === WS_VOICE_RESPONSE_DONE) {
      suppressNextVoiceTranscript.current = false;
    }

    if (msg.type === WS_VOICE_SPEECH_STOPPED) {
      chat.injectMessage('[Voice]', 'user');
    }
    if (msg.type === WS_VOICE_USER_TRANSCRIPT && typeof payload.text === 'string') {
      chat.replaceLastUserMessage(payload.text);
    }
    if (msg.type === WS_VOICE_TRANSCRIPT && payload.done && typeof payload.text === 'string') {
      if (suppressNextVoiceTranscript.current) {
        suppressNextVoiceTranscript.current = false;
        return;
      }
      chat.injectMessage(payload.text, 'agent');
    }
  }

  const handleApprove = useCallback(
    (requestId: string) => {
      approvals.respond(requestId, true);
      setSelectedApproval(null);
    },
    [approvals],
  );

  const handleDeny = useCallback(
    (requestId: string) => {
      approvals.respond(requestId, false);
      setSelectedApproval(null);
    },
    [approvals],
  );

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-bbs-black">
        <BBSHeader
          connectionState={connectionState}
          approvalCount={approvals.pending.length}
        />
        <BBSMenuBar
          currentView={currentView}
          onViewChange={handleViewChange}
        />

        <ApprovalBanner
          pending={approvals.pending}
          onSelect={setSelectedApproval}
        />

        <main className="flex-1 min-h-0 overflow-hidden">
          {currentView === 'chat' && (
            <ChatView
              messages={chat.messages}
              isTyping={chat.isTyping}
              onSend={chat.sendMessage}
              onStop={chat.stopGeneration}
              connected={connected}
              voiceState={voice.voiceState}
              voiceTranscript={voice.transcript}
              voiceMode={voice.mode}
              onVoiceToggle={handleVoiceToggle}
              onVoiceModeChange={voice.setMode}
              onPushToTalkStart={voice.pushToTalkStart}
              onPushToTalkStop={voice.pushToTalkStop}
              delegationTask={voice.delegationTask}
              theme={theme}
              chatSessions={chat.sessions}
              selectedSessionDetail={chat.selectedSessionDetail}
              commandResult={chat.lastCommandResult}
              cockpit={chat.cockpit}
              commands={chat.commands}
              activeSessionId={chat.sessionId}
              onSelectSession={chat.resumeSession}
              onInspectSession={chat.inspectSession}
              onLoadSessionHistory={chat.loadSessionHistory}
              onForkSession={chat.forkSession}
              onNewChat={chat.startNewChat}
              desktopUrl={sessionDesktopUrl}
              desktopOpen={desktopPanelOpen}
              onToggleDesktop={toggleDesktopPanel}
              tokenUsage={chat.tokenUsage}
            />
          )}
          {currentView === 'status' && (
            <AgentStatusView
              status={agentStatus.status}
              onRefresh={agentStatus.refresh}
            />
          )}
          {currentView === 'runs' && (
            <RunDashboardView
              runs={runs.runs}
              selectedRun={runs.selectedRun}
              selectedSessionId={runs.selectedSessionId}
              loading={runs.loading}
              error={runs.error}
              runNotice={runs.runNotice}
              operatorAvailability={runs.operatorAvailability}
              browserNotificationsEnabled={runs.browserNotificationsEnabled}
              notificationPermission={runs.notificationPermission}
              onSelectRun={runs.setSelectedSessionId}
              onRefresh={runs.refresh}
              onInspect={runs.inspect}
              onControl={runs.control}
              onEnableBrowserNotifications={runs.enableBrowserNotifications}
            />
          )}
          {currentView === 'observability' && (
            <ObservabilityView
              summary={observability.summary}
              traces={observability.traces}
              selectedTraceId={observability.selectedTraceId}
              selectedTrace={observability.selectedTrace}
              selectedEventId={observability.selectedEventId}
              selectedEvent={observability.selectedEvent}
              artifact={observability.artifact}
              logs={observability.logs}
              loading={observability.loading}
              error={observability.error}
              search={observability.search}
              status={observability.status}
              onSearchChange={observability.setSearch}
              onStatusChange={observability.setStatus}
              onSelectTrace={observability.setSelectedTraceId}
              onSelectEvent={observability.setSelectedEventId}
              onRefresh={observability.refresh}
            />
          )}
          {(currentView === 'tools' || currentView === 'skills') && (
            <ToolsView
              tools={tools.tools}
              onRefresh={tools.refresh}
              onToggle={tools.toggle}
            />
          )}
          {(currentView === 'marketplace' || currentView === 'tasks') && (
            <MarketplaceView
              tasks={tasks.tasks}
              onTaskRefresh={tasks.refresh}
              onTaskCreate={tasks.create}
              onTaskClaim={tasks.claim}
              onTaskComplete={tasks.complete}
              onTaskDispute={tasks.dispute}
              onTaskCancel={tasks.cancel}
              skills={marketSkills.skills}
              selectedSkill={marketSkills.selectedSkill}
              onSkillsRefresh={marketSkills.refresh}
              onSkillInspect={marketSkills.inspect}
              onSkillPurchase={marketSkills.purchase}
              onSkillRate={marketSkills.rate}
              proposals={governance.proposals}
              selectedProposal={governance.selectedProposal}
              onGovernanceRefresh={governance.refresh}
              onProposalInspect={governance.inspect}
              onProposalVote={governance.vote}
              disputes={disputes.disputes}
              selectedDispute={disputes.selectedDispute}
              onDisputesRefresh={disputes.refresh}
              onDisputeInspect={disputes.inspect}
              reputation={reputation.summary}
              onReputationRefresh={reputation.refresh}
              onStake={reputation.stake}
              onDelegate={reputation.delegate}
            />
          )}
          {currentView === 'memory' && (
            <MemoryView
              results={memory.results}
              sessions={memory.sessions}
              onSearch={memory.search}
              onRefreshSessions={memory.refreshSessions}
            />
          )}
          {currentView === 'desktop' && (
            <DesktopView
              sandboxes={desktop.sandboxes}
              loading={desktop.loading}
              error={desktop.error}
              activeSessionId={chat.sessionId}
              onRefresh={desktop.refresh}
              onCreate={desktop.create}
              onAttach={(containerId, sessionId) => desktop.attach(containerId, sessionId)}
              onDestroy={desktop.destroy}
            />
          )}
          {currentView === 'activity' && (
            <ActivityFeedView
              events={activityFeed.events}
              onClear={activityFeed.clear}
            />
          )}
          {currentView === 'settings' && (
            <SettingsView
              settings={gatewaySettings}
              autoApprove={approvals.autoApprove}
              onAutoApproveChange={approvals.setAutoApprove}
            />
          )}
          {currentView === 'payment' && (
            <PaymentView wallet={walletInfo} />
          )}
          <div className={currentView === 'simulation' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
            <SimulationWorkspace
              active={currentView === 'simulation'}
              bridgeUrl="http://localhost:3200"
              route={simulationRoute}
              onRouteChange={handleSimulationRouteChange}
            />
          </div>
        </main>

        <BBSStatusBar
          activeNetwork={walletInfo.wallet?.network ?? walletInfo.wallet?.rpcUrl ?? null}
          targetNetwork={gatewaySettings.settings.connection.rpcUrl}
        />

        {selectedApproval && (
          <ApprovalDialog
            request={selectedApproval}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onClose={() => setSelectedApproval(null)}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
