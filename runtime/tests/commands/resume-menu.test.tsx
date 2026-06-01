/**
 * In-session `/resume` picker → relaunch wiring.
 *
 * Covers the safe-partial resume swap: selecting a session in the picker
 * records a pending resume id (via the appState bridge's
 * `requestResumeSession`) and closes the surface, instead of only
 * printing `agenc --resume <id>`. The boot entrypoint later consumes that
 * id to relaunch into the chosen session.
 */
import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openResumeMenu } from "./resume-menu.js";
import type { RolloutEntry } from "./resume.js";
import type { SlashCommandContext } from "./types.js";
import { createRoot } from "../tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../tui/state/AppState.js";
import {
  consumePendingResumeSessionId,
  resetPendingResumeSessionIdForTestingOnly,
  setPendingResumeSessionId,
} from "../tui/pending-resume.js";

function makeCtx(
  appState?: SlashCommandContext["appState"],
): SlashCommandContext {
  return {
    session: { services: {} } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/tmp/project",
    home: "/tmp",
    ...(appState ? { appState } : {}),
  };
}

function entry(sessionId: string, mtimeMs: number): RolloutEntry {
  return {
    filePath: `/tmp/project/rollout-${sessionId}.jsonl`,
    sessionId,
    mtimeMs,
    firstUserPreview: `preview for ${sessionId}`,
  };
}

function createStreams(): {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  const stdout = new PassThrough() as PassThrough & {
    columns?: number;
    rows?: number;
    isTTY?: boolean;
  };
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.isTTY = true;
  return { stdin, stdout };
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => {
  resetPendingResumeSessionIdForTestingOnly();
});

describe("pending resume slot", () => {
  it("round-trips and consumes exactly once", () => {
    expect(consumePendingResumeSessionId()).toBeNull();
    setPendingResumeSessionId("sess-1");
    expect(consumePendingResumeSessionId()).toBe("sess-1");
    // Consume-once: a second read does not re-resume.
    expect(consumePendingResumeSessionId()).toBeNull();
  });
});

describe("openResumeMenu Enter → requestResumeSession", () => {
  it("resumes the highlighted session and closes the surface", async () => {
    const setToolJSX = vi.fn();
    const requestResumeSession = vi.fn();
    const entries = [entry("sess-newest", 2000), entry("sess-older", 1000)];

    const opened = openResumeMenu(
      makeCtx({ setToolJSX, requestResumeSession }),
      entries,
    );
    expect(opened).toBe(true);

    const payload = setToolJSX.mock.calls[0]?.[0] as {
      jsx?: React.ReactNode;
    };
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          {payload.jsx}
        </AppStateProvider>,
      );
      await sleep();

      // Move down to the older session, then press Enter.
      stdin.write("j");
      await sleep();
      stdin.write("\r");
      await sleep();

      expect(requestResumeSession).toHaveBeenCalledTimes(1);
      expect(requestResumeSession).toHaveBeenCalledWith("sess-older");
      // Selecting closes the picker.
      expect(setToolJSX).toHaveBeenLastCalledWith(
        expect.objectContaining({
          jsx: null,
          shouldHidePromptInput: false,
          clearLocalJSX: true,
        }),
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  it("does not resume when the bridge lacks requestResumeSession", async () => {
    const setToolJSX = vi.fn();
    const entries = [entry("sess-a", 1000)];

    openResumeMenu(makeCtx({ setToolJSX }), entries);
    const payload = setToolJSX.mock.calls[0]?.[0] as {
      jsx?: React.ReactNode;
    };
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          {payload.jsx}
        </AppStateProvider>,
      );
      await sleep();

      // Enter is a no-op without a live bridge: no pending id, surface stays.
      stdin.write("\r");
      await sleep();

      expect(consumePendingResumeSessionId()).toBeNull();
      // The picker is still open (only the initial open call fired).
      expect(setToolJSX).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  it("ignores Enter when there are no resumable sessions", async () => {
    const setToolJSX = vi.fn();
    const requestResumeSession = vi.fn();

    openResumeMenu(makeCtx({ setToolJSX, requestResumeSession }), []);
    const payload = setToolJSX.mock.calls[0]?.[0] as {
      jsx?: React.ReactNode;
    };
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          {payload.jsx}
        </AppStateProvider>,
      );
      await sleep();
      stdin.write("\r");
      await sleep();

      expect(requestResumeSession).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
