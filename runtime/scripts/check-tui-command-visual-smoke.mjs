#!/usr/bin/env node
/**
 * Live slash-command visual smoke coverage.
 *
 * This complements the static design-state parity tests by opening the
 * retained command surfaces in a real PTY and checking the visible terminal
 * frame. It catches transient rich commands, missing hint spacing, and menu
 * content that starts below the viewport.
 */
import { fileURLToPath } from "node:url";

import {
  TuiSession,
  renderPtyRows,
  tuiE2eGateEnv,
} from "./check-tui-e2e/harness.mjs";
import {
  buildMockProviderEnv,
  startMockModelServer,
} from "./local-openai-compatible-mock.mjs";
import {
  configureTuiGateSandbox,
  createTuiGateProject,
  createTuiGateState,
  installTuiGateSignalHandlers,
  startTuiGateDaemon,
  teardownTuiGateState,
} from "./tui-gate-state.mjs";

const BIN_AGENC = fileURLToPath(
  new URL("../dist/bin/agenc.js", import.meta.url),
);

const DIMENSIONS = [
  { cols: 148, rows: 40 },
  { cols: 120, rows: 30 },
  { cols: 80, rows: 24 },
];

const COMMANDS = [
  {
    command: "/help",
    anchors: ["AgenC Help"],
    supporting: ["Shortcuts", "/ for commands"],
    settleMs: 3_500,
  },
  {
    command: "/config",
    anchors: ["CONFIG"],
    supporting: ["Config Store", "effective settings"],
    requiresFooter: true,
  },
  {
    command: "/skills",
    anchors: ["SKILLS"],
    supporting: ["Skill Loader", "$"],
    requiresFooter: true,
  },
  {
    command: "/model",
    anchors: ["MODEL"],
    supporting: ["Model Route", "active"],
    requiresFooter: true,
  },
  {
    command: "/provider",
    anchors: ["PROVIDER"],
    supporting: ["Provider Route", "active"],
    requiresFooter: true,
  },
  {
    command: "/hooks",
    anchors: ["AgenC Hooks", "Commands: /hooks"],
    supporting: ["Configured hooks:", "PreToolUse: 0 hooks", "/hooks diagnostics"],
    requiresLiveSession: true,
  },
  {
    command: "/mcp",
    anchors: ["MCP"],
    supporting: ["MCP Servers", "servers"],
    requiresFooter: true,
  },
  {
    command: "/agents",
    anchors: ["AGENTS"],
    supporting: ["Built-in agents"],
    requiresFooter: true,
  },
  {
    command: "/permissions",
    anchors: ["PERMISSIONS"],
    supporting: ["Permission Rules", "mode"],
    requiresFooter: true,
  },
  {
    command: "/memory",
    anchors: ["AGENC.md", "memory"],
    supporting: ["open", "present"],
    requiresFooter: true,
  },
  {
    command: "/resume",
    anchors: ["RESUME"],
    settleMs: 800,
  },
  {
    command: "/tasks",
    anchors: ["BACKGROUND TASKS"],
    supporting: ["No background tasks", "[esc] dismiss"],
    requiresFooter: true,
  },
  {
    command: "/context",
    anchors: ["CONTEXT"],
    supporting: ["tokens", "BREAKDOWN BY SOURCE"],
  },
  {
    command: "/diff",
    anchors: ["DIFF", "git diff HEAD", "modified", "deleted"],
    supporting: ["diff-fixture.txt"],
    requiresFooter: true,
  },
];

const MALFORMED_HINT_PATTERNS = [
  /\/helpfor\b/i,
  /\/claimto\b/i,
  /\/(?:help|claim|config|skills|model|provider|hooks|mcp|agents|permissions|memory|resume|tasks|context|diff)(?:for|to|from|with|and)\b/i,
];

const FOOTER_PATTERNS = [
  /\[q\]\s*close/i,
  /\[esc\]\s*dismiss/i,
  /\[up\/down\]\s*navigate/i,
  /↑↓\s*select/i,
  /\bq\s+cl/i,
  /\bscroll\b/i,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forceKillSession(session) {
  const pid = session.term?.pid;
  session.kill();
  if (typeof pid !== "number") return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // best-effort teardown
    }
  }
}

function trackActiveSession(lifecycle, session) {
  if (lifecycle.activeSession !== null) {
    throw new Error("command visual smoke already has an active TUI session");
  }
  lifecycle.activeSession = session;
  lifecycle.activeSessionCleanup = null;
}

async function cleanupActiveSession(lifecycle) {
  const session = lifecycle.activeSession;
  if (session === null) return;

  if (lifecycle.activeSessionCleanup === null) {
    forceKillSession(session);
    lifecycle.activeSessionCleanup = session.cleanup();
  }
  const cleanupPromise = lifecycle.activeSessionCleanup;
  try {
    await cleanupPromise;
  } finally {
    if (
      lifecycle.activeSession === session &&
      lifecycle.activeSessionCleanup === cleanupPromise
    ) {
      lifecycle.activeSession = null;
      lifecycle.activeSessionCleanup = null;
    }
  }
}

async function cleanupLifecycle(lifecycle) {
  const errors = [];
  try {
    await cleanupActiveSession(lifecycle);
  } catch (error) {
    errors.push(error);
  }
  try {
    const gateState =
      lifecycle.gateState ?? await lifecycle.pendingGateState;
    lifecycle.gateState = gateState;
    lifecycle.pendingGateState = null;
    await teardownTuiGateState(gateState, BIN_AGENC);
  } catch (error) {
    errors.push(error);
  }
  if (lifecycle.mockClosePromise === null) {
    lifecycle.mockClosePromise = lifecycle.mockServer.close();
  }
  try {
    await lifecycle.mockClosePromise;
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "command visual smoke cleanup failed");
  }
}

function fail(message, details = {}) {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  throw new Error(suffix ? `${message} (${suffix})` : message);
}

function assertNoMalformedHints(text, label) {
  for (const pattern of MALFORMED_HINT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      fail("malformed slash-command hint spacing", {
        label,
        match: JSON.stringify(match[0]),
      });
    }
  }
}

function assertFrameWidthContract(rows, dimension, label) {
  const autoWraps = rows.autoWraps ?? [];
  if (autoWraps.length > 0) {
    fail("command surface caused terminal autowrap", {
      label,
      wraps: autoWraps.length,
      first: JSON.stringify(autoWraps[0]),
    });
  }
  for (const [index, row] of rows.entries()) {
    if (row.length > dimension.cols) {
      fail("command surface row overflow", {
        label,
        row: index + 1,
        width: row.length,
        cols: dimension.cols,
      });
    }
  }
}

function firstMarkerRow(rows, markers) {
  const normalized = markers.map((marker) => marker.toLowerCase());
  return rows.findIndex((row) => {
    const line = row.toLowerCase();
    return normalized.some((marker) => line.includes(marker));
  });
}

function assertSurfaceVisible(session, spec, dimension) {
  const rows = renderPtyRows(session.raw, dimension);
  const frame = rows.join("\n");
  const label = `${spec.command} ${dimension.cols}x${dimension.rows}`;
  const lowerFrame = frame.toLowerCase();
  assertNoMalformedHints(frame, label);
  assertFrameWidthContract(rows, dimension, label);

  if (!spec.anchors.some((marker) => lowerFrame.includes(marker.toLowerCase()))) {
    fail("command surface anchor missing from visible frame", {
      label,
      anchors: JSON.stringify(spec.anchors),
    });
  }

  if (
    spec.supporting &&
    !spec.supporting.some((marker) => lowerFrame.includes(marker.toLowerCase()))
  ) {
    fail("command surface supporting marker missing from visible frame", {
      label,
      markers: JSON.stringify(spec.supporting),
    });
  }

  const markerRow = firstMarkerRow(rows, spec.anchors);
  if (markerRow === -1) {
    fail("command surface never appeared in visible frame", { label });
  }

  const bottomChromeRows = 3;
  if (markerRow >= dimension.rows - bottomChromeRows) {
    fail("command surface starts below visible body", {
      label,
      row: markerRow + 1,
      rows: dimension.rows,
    });
  }

  if (spec.requiresFooter && !FOOTER_PATTERNS.some((pattern) => pattern.test(frame))) {
    fail("scroll or close affordance missing from command surface", { label });
  }
}

async function runOne(spec, dimension, lifecycle) {
  const session = new TuiSession({
    cols: dimension.cols,
    rows: dimension.rows,
    cwd: lifecycle.cwd,
    gateState: lifecycle.gateState,
  });
  trackActiveSession(lifecycle, session);
  const label = `${spec.command} ${dimension.cols}x${dimension.rows}`;
  try {
    await session.start({ firstPaintMs: 1_000, postReplyMs: 1_000 });
    await session.waitForPrompt({ timeout: 20_000 });
    assertNoMalformedHints(session.latestFrame, `${label} cold-start`);

    if (spec.requiresLiveSession) {
      await session.type("hello");
      await session.submit();
      await session.waitForAssistantReply({ timeout: 45_000 });
      await session.waitForPrompt({ timeout: 30_000 });
    }
    await session.submitSlashCommand(spec.command);
    await session.waitForIdle({ idleWindow: 900, timeout: 20_000 });
    if (spec.settleMs) await sleep(spec.settleMs);
    assertSurfaceVisible(session, spec, dimension);
    session.assertNoCrash();
  } finally {
    await cleanupActiveSession(lifecycle);
  }
}

async function main() {
  const mockServer = await startMockModelServer();
  const gateStatePromise = createTuiGateState({
    injectedEnv: tuiE2eGateEnv(
      buildMockProviderEnv(mockServer.baseUrl, {}),
    ),
    prefix: "agenc-tui-command-visual-",
  });
  const lifecycle = {
    gateState: null,
    pendingGateState: gateStatePromise,
    cwd: null,
    activeSession: null,
    activeSessionCleanup: null,
    aborted: false,
    mockServer,
    mockClosePromise: null,
  };
  let uninstallSignalHandlers = () => {};
  try {
    uninstallSignalHandlers = installTuiGateSignalHandlers(async () => {
      lifecycle.aborted = true;
      await cleanupLifecycle(lifecycle);
    });
    const gateState = await gateStatePromise;
    lifecycle.gateState = gateState;
    lifecycle.pendingGateState = null;
    lifecycle.cwd = createTuiGateProject(gateState, { dirty: true });
    // The hooks surface needs one live mock turn. Avoid depending on the
    // host's optional bubblewrap/user-namespace support for that precondition.
    await configureTuiGateSandbox(
      gateState,
      BIN_AGENC,
      "danger-full-access",
    );
    if (lifecycle.aborted) return 1;
    await startTuiGateDaemon(gateState, BIN_AGENC);
    if (lifecycle.aborted) return 1;

    const failures = [];
    for (const dimension of DIMENSIONS) {
      for (const spec of COMMANDS) {
        if (lifecycle.aborted) return 1;
        const label = `${spec.command} ${dimension.cols}x${dimension.rows}`;
        process.stdout.write(`command visual smoke: ${label} ... `);
        try {
          await runOne(spec, dimension, lifecycle);
          process.stdout.write("ok\n");
        } catch (error) {
          process.stdout.write("failed\n");
          failures.push({ label, error });
        }
        if (lifecycle.aborted) return 1;
      }
    }

    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`\n${failure.label}: ${failure.error?.message ?? failure.error}`);
      }
      return 1;
    }
    return 0;
  } finally {
    try {
      await cleanupLifecycle(lifecycle);
    } finally {
      uninstallSignalHandlers();
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
