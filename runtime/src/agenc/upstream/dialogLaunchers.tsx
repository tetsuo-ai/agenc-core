/**
 * Thin launchers for one-off dialog JSX sites in main.tsx.
 * Each launcher dynamically imports its component and wires the `done` callback
 * identically to the original inline call site. Zero behavior change.
 *
 * Part of the main.tsx React/JSX extraction effort. See sibling PRs
 * perf/extract-interactive-helpers and perf/launch-repl.
 */
import React from 'react';
import type { AssistantSession } from './assistant/sessionDiscovery.js';
import type { StatsStore } from '../../tui/context/stats';
import type { Root } from '../../tui/ink.js';
import { renderAndRun, showSetupDialog } from './interactiveHelpers.js';
import { KeybindingSetup } from '../../tui/keybindings/KeybindingProviderSetup.js';
import type { AppState } from '../../tui/state/AppStateStore.js';
import type { AgentMemoryScope } from './tools/AgentTool/agentMemory.js';
import type { TeleportRemoteResponse } from '../../utils/conversationRecovery.js';
import type { FpsMetrics } from '../../utils/fpsTracker.js';
import type { ValidationError } from '../../utils/settings/validation.js';

// Type-only access to ResumeConversation's Props via the module type.
// No runtime cost - erased at compile time.
type ResumeConversationProps = React.ComponentProps<typeof import('../../tui/history/ResumeConversation.js').ResumeConversation>;

/**
 * Site ~3173: SnapshotUpdateDialog (agent memory snapshot update prompt).
 * Original callback wiring: onComplete={done}, onCancel={() => done('keep')}.
 */
export async function launchSnapshotUpdateDialog(root: Root, props: {
  agentType: string;
  scope: AgentMemoryScope;
  snapshotTimestamp: string;
}): Promise<'merge' | 'keep' | 'replace'> {
  const {
    SnapshotUpdateDialog
  } = await import('../../tui/components/agents/SnapshotUpdateDialog');
  return showSetupDialog<'merge' | 'keep' | 'replace'>(root, done => <SnapshotUpdateDialog agentType={props.agentType} scope={props.scope} snapshotTimestamp={props.snapshotTimestamp} onComplete={done} onCancel={() => done('keep')} />);
}

/**
 * Site ~3250: InvalidSettingsDialog (settings validation errors).
 * Original callback wiring: onContinue={done}, onExit passed through from caller.
 */
export async function launchInvalidSettingsDialog(root: Root, props: {
  settingsErrors: ValidationError[];
  onExit: () => void;
}): Promise<void> {
  const {
    InvalidSettingsDialog
  } = await import('../../tui/components/InvalidSettingsDialog');
  return showSetupDialog(root, done => <InvalidSettingsDialog settingsErrors={props.settingsErrors} onContinue={done} onExit={props.onExit} />);
}

/**
 * Site ~4229: AssistantSessionChooser (pick a bridge session to attach to).
 * Original callback wiring: onSelect={id => done(id)}, onCancel={() => done(null)}.
 */
export async function launchAssistantSessionChooser(root: Root, props: {
  sessions: AssistantSession[];
}): Promise<string | null> {
  const {
    AssistantSessionChooser
  } = await import('./assistant/AssistantSessionChooser.js');
  return showSetupDialog<string | null>(root, done => <AssistantSessionChooser sessions={props.sessions} onSelect={id => done(id)} onCancel={() => done(null)} />);
}

/**
 * `agenc assistant` found zero sessions, but this source snapshot has no
 * installer implementation for the assistant daemon. Resolve as cancellation so
 * the caller follows the same graceful-exit path as an explicit cancel.
 */
export async function launchAssistantInstallWizard(root: Root): Promise<string | null> {
  void root;
  return null;
}

/**
 * Site ~4549: TeleportResumeWrapper (interactive teleport session picker).
 * Original callback wiring: onComplete={done}, onCancel={() => done(null)}, source="cliArg".
 */
export async function launchTeleportResumeWrapper(root: Root): Promise<TeleportRemoteResponse | null> {
  const {
    TeleportResumeWrapper
  } = await import('../../tui/components/TeleportResumeWrapper');
  return showSetupDialog<TeleportRemoteResponse | null>(root, done => <TeleportResumeWrapper onComplete={done} onCancel={() => done(null)} source="cliArg" />);
}

/**
 * Site ~4597: TeleportRepoMismatchDialog (pick a local checkout of the target repo).
 * Original callback wiring: onSelectPath={done}, onCancel={() => done(null)}.
 */
export async function launchTeleportRepoMismatchDialog(root: Root, props: {
  targetRepo: string;
  initialPaths: string[];
}): Promise<string | null> {
  const {
    TeleportRepoMismatchDialog
  } = await import('../../tui/components/TeleportRepoMismatchDialog');
  return showSetupDialog<string | null>(root, done => <TeleportRepoMismatchDialog targetRepo={props.targetRepo} initialPaths={props.initialPaths} onSelectPath={done} onCancel={() => done(null)} />);
}

/**
 * Site ~4903: ResumeConversation mount (interactive session picker).
 * Uses renderAndRun, NOT showSetupDialog. Wraps in <App><KeybindingSetup>.
 * Preserves original Promise.all parallelism between getWorktreePaths and imports.
 */
export async function launchResumeChooser(root: Root, appProps: {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
  initialState: AppState;
}, worktreePathsPromise: Promise<string[]>, resumeProps: Omit<ResumeConversationProps, 'worktreePaths'>): Promise<void> {
  const [worktreePaths, {
    ResumeConversation
  }, {
    App
  }] = await Promise.all([worktreePathsPromise, import('../../tui/history/ResumeConversation.js'), import('../../tui/components/App.js')]);
  await renderAndRun(root, <App getFpsMetrics={appProps.getFpsMetrics} stats={appProps.stats} initialState={appProps.initialState}>
      <KeybindingSetup>
        <ResumeConversation {...resumeProps} worktreePaths={worktreePaths} />
      </KeybindingSetup>
    </App>);
}
