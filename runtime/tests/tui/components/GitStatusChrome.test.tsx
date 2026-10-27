import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { GitStatusChrome } from '../../../src/tui/components/GitStatusLine.js';
import { FullscreenLayout } from '../../../src/tui/components/FullscreenLayout.js';
import { createRoot } from '../../../src/tui/ink/root.js';
import { Text } from '../../../src/tui/ink.js';
import { AppStoreContext, getDefaultAppState } from '../../../src/tui/state/AppState.js';
import { createStore } from '../../../src/tui/state/store.js';
import { FullscreenModeProvider } from '../../../src/tui/context/fullscreenModeContext.js';
import { StatusTurnBusyContext } from '../../../src/tui/context/statusEffortContext.js';
import TerminalFocusContext from '../../../src/tui/ink/components/TerminalFocusContext.js';
import { probeGitStatus, type GitStatus } from '../../../src/tui/git-status.js';
import type { GitStatusEvents, GitStatusSession } from '../../../src/tui/hooks/useGitStatus.js';
import { DaemonEventReplay, DaemonEventReplayGapError } from '../../../src/tui/daemon-event-replay.js';

vi.mock('../../../src/tui/git-status.js', () => ({ probeGitStatus: vi.fn() }));
const probe = vi.mocked(probeGitStatus);
const clean = { branch: 'unique-branch', changed: 0, ahead: 0, behind: 0 };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

async function mount() {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  const root = await createRoot({ patchConsole: false, stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream });
  const store = createStore(getDefaultAppState());
  const listeners = new Set<(event: unknown) => void>();
  // The shell's live fan-out: the only event source the chrome may use.
  const events: GitStatusEvents = {
    subscribeToEvents(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  const session: GitStatusSession = { cwd: '/session/repo' };
  const render = (busy = false, focused = true, text = 'composer', currentSession = session, shown = true) => root.render(
    <AppStoreContext.Provider value={store}>
      <TerminalFocusContext.Provider value={{ isTerminalFocused: focused, terminalFocusState: focused ? 'focused' : 'blurred' }}>
        <StatusTurnBusyContext value={busy}>
          <FullscreenModeProvider enabled>
            <FullscreenLayout scrollable={<Text>transcript</Text>} bottom={<>
              {shown ? <GitStatusChrome session={currentSession} events={events} /> : null}<Text>{text}</Text>
            </>} />
          </FullscreenModeProvider>
        </StatusTurnBusyContext>
      </TerminalFocusContext.Provider>
    </AppStoreContext.Provider>,
  );
  const frame = () => {
    const end = output.lastIndexOf('\x1b[?2026l');
    const start = output.lastIndexOf('\x1b[?2026h', end);
    return stripAnsi(output.slice(start, end));
  };
  return { render, frame, store, session, listeners,
    emit(event: unknown) { for (const cb of listeners) cb(event); },
    close() { root.unmount(); stdin.end(); stdout.end(); },
  };
}

describe('live git composer chrome', () => {
  it('hides old repo data on cwd changes and ignores a late result after unmount', async () => {
    probe.mockResolvedValueOnce(clean);
    let finish!: (status: GitStatus | null) => void;
    probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const app = await mount();
    try {
      app.render(); await vi.waitFor(() => expect(app.frame()).toContain('unique-branch'));
      app.render(false, true, 'other composer', { ...app.session, cwd: '/other/repo' });
      await vi.waitFor(() => expect(probe).toHaveBeenLastCalledWith('/other/repo'));
      await vi.waitFor(() => expect(app.frame()).not.toContain('unique-branch'));
    } finally { app.close(); }
    finish({ ...clean, branch: 'late-result' });
    await Promise.resolve();
    expect(app.frame()).not.toContain('late-result');
    expect(app.listeners.size).toBe(0);
  });

  it('keeps first paint async, renders once above the composer, and leaves the footer without the branch', async () => {
    let finish!: (status: GitStatus | null) => void;
    probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const app = await mount();
    try {
      app.render();
      await vi.waitFor(() => expect(app.frame()).toContain('composer'));
      expect(app.frame()).not.toContain('unique-branch');
      finish(clean);
      await vi.waitFor(() => expect(app.frame()).toContain('unique-branch'));
      const frame = app.frame();
      expect(frame.match(/unique-branch/g)).toHaveLength(1);
      expect(frame.indexOf('unique-branch')).toBeLessThan(frame.indexOf('composer'));
      expect(frame.indexOf('composer')).toBeLessThan(frame.indexOf('asks first'));
      expect(probe).toHaveBeenCalledWith('/session/repo');
    } finally { app.close(); }
  });
  it('refreshes on tool, shell/turn, focus and interval boundaries, never on composer edits', async () => {
    probe.mockResolvedValue(clean);
    const app = await mount();
    try {
      app.render(); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(app.frame()).toContain('unique-branch'));
      app.render(false, true, 'typing');
      await vi.waitFor(() => expect(app.frame()).toContain('typing'));
      expect(probe).toHaveBeenCalledTimes(1);
      app.emit({ type: 'assistant_text_delta' });
      expect(probe).toHaveBeenCalledTimes(1);
      app.emit({ type: 'tool_call_completed' });
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
      app.emit({ msg: { type: 'exec_command_end' } });
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3));
      app.emit({ type: 'tool_result' });
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(4));
      app.render(true); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(5));
      app.render(false); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(6));
      app.render(false, false); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(7));
      app.render(false, true); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(8));
      vi.useFakeTimers();
      // The interval was installed with real timers, so re-enable the setting to install it here.
      app.store.setState(state => ({ ...state, settings: { ...state.settings, tui: { ...state.settings.tui, gitStatusEnabled: false } } }));
      await vi.advanceTimersByTimeAsync(100);
      app.store.setState(state => ({ ...state, settings: { ...state.settings, tui: { ...state.settings.tui, gitStatusEnabled: true } } }));
      await vi.advanceTimersByTimeAsync(100);
      const before = probe.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(probe.mock.calls.length).toBe(before + 1);
    } finally { app.close(); }
  });
  it('coalesces tool completions during a probe and hides errors and the disabled setting', async () => {
    let finish!: (status: GitStatus | null) => void;
    probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    probe.mockResolvedValue(null);
    const app = await mount();
    try {
      app.render(); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      for (let i = 0; i < 5; i++) app.emit({ type: 'tool_call_completed' });
      expect(probe).toHaveBeenCalledTimes(1);
      finish(clean);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(app.frame()).not.toContain('unique-branch'));
      app.store.setState(state => ({ ...state, settings: { ...state.settings, tui: { ...state.settings.tui, gitStatusEnabled: false } } }));
      await vi.waitFor(() => expect(app.listeners.size).toBe(0));
      app.emit({ type: 'tool_call_completed' });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally { app.close(); }
    expect(app.listeners.size).toBe(0);
  });

  it('remounts after an approval without a new daemon replay subscription past its capacity', async () => {
    probe.mockResolvedValue(clean);
    // A long task: the session's replay already refuses new subscribers.
    const replay = new DaemonEventReplay(3);
    for (let i = 0; i < 5; i++) replay.publish({ type: 'agent_message_delta' });
    expect(() => replay.subscribe(() => {})).toThrow(DaemonEventReplayGapError);
    const app = await mount();
    const session = { ...app.session, subscribeToEvents: (cb: (event: unknown) => void) => replay.subscribe(cb) };
    try {
      app.render(false, true, 'composer', session);
      await vi.waitFor(() => expect(app.frame()).toContain('unique-branch'));
      // An approval card hides the composer and its chrome, then both return.
      app.render(false, true, 'approval card', session, false);
      await vi.waitFor(() => expect(app.frame()).not.toContain('unique-branch'));
      expect(app.listeners.size).toBe(0);
      app.render(false, true, 'composer again', session, true);
      await vi.waitFor(() => expect(app.frame()).toContain('unique-branch'));
      expect(app.listeners.size).toBe(1);
      const calls = probe.mock.calls.length;
      app.emit({ type: 'tool_call_completed' });
      await vi.waitFor(() => expect(probe.mock.calls.length).toBeGreaterThan(calls));
    } finally { app.close(); }
  });
});
