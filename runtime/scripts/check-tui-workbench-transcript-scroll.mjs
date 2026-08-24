#!/usr/bin/env node
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
  { cols: 100, rows: 28 },
  { cols: 80, rows: 24 },
];

const WORKBENCH_ENV = {
  AGENC_NO_FLICKER: "1",
  AGENC_TUI_GLYPHS: "ascii",
  AGENC_TUI_WORKBENCH: "1",
};

const LONG_OUTPUT_PROMPT =
  "WORKBENCH-TRANSCRIPT-SCROLL: return the deterministic fixture.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackActiveSession(lifecycle, session) {
  if (lifecycle.activeSession !== null) {
    throw new Error(
      "workbench transcript scroll already has an active TUI session",
    );
  }
  lifecycle.activeSession = session;
  lifecycle.activeSessionCleanup = null;
}

async function cleanupActiveSession(lifecycle) {
  const session = lifecycle.activeSession;
  if (session === null) return;

  if (lifecycle.activeSessionCleanup === null) {
    session.kill();
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
    throw new AggregateError(
      errors,
      "workbench transcript scroll cleanup failed",
    );
  }
}

function fail(message, details = {}) {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  throw new Error(suffix ? `${message} (${suffix})` : message);
}

function frameRows(session, dimension) {
  return renderPtyRows(session.raw, dimension);
}

function frameText(session, dimension) {
  return frameRows(session, dimension).join("\n");
}

function assertFrameShape(session, dimension, label) {
  const rows = frameRows(session, dimension);
  if (rows.every((row) => row.trim().length === 0)) {
    fail("blank workbench transcript frame", { label });
  }
  for (const [index, row] of rows.entries()) {
    if (row.length > dimension.cols) {
      fail("workbench transcript row overflow", {
        label,
        row: index + 1,
        width: row.length,
        cols: dimension.cols,
      });
    }
  }
  const frame = rows.join("\n");
  if (!frame.includes("WORKBENCH")) {
    fail("workbench chrome absent from transcript frame", {
      label,
      frame: JSON.stringify(frame.slice(0, 1200)),
    });
  }
}

function assertExplorerRailVisible(session, dimension, label) {
  if (dimension.cols < 100) return;
  const rows = frameRows(session, dimension);
  const frame = rows.join("\n");
  const hasTreeRow = rows.some((row) =>
    /^\s*(?:[│|]\s*)?(?:\[[-+]\]|[v>▾▸])\s+\S/u.test(
      row.slice(0, 26),
    )
  );
  if (!frame.includes("WORKSPACE") || !hasTreeRow) {
    fail("workspace explorer rail disappeared during transcript scroll", {
      label,
      frame: JSON.stringify(frame.slice(0, 1200)),
    });
  }
}

async function waitForFrame(session, dimension, predicate, label, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let lastFrame = "";
  while (Date.now() - startedAt < timeoutMs) {
    lastFrame = frameText(session, dimension);
    if (predicate(lastFrame)) return;
    await sleep(100);
  }
  fail("timed out waiting for transcript frame state", {
    label,
    frame: JSON.stringify(lastFrame.slice(-800)),
  });
}

async function sendRepeated(session, bytes, count, pauseMs = 70) {
  for (let index = 0; index < count; index += 1) {
    session.send(bytes);
    await sleep(pauseMs);
  }
}

function sgrWheel(button, dimension) {
  const col = Math.min(dimension.cols - 4, Math.max(35, Math.floor(dimension.cols / 2)));
  const row = Math.min(dimension.rows - 6, 10);
  return `\x1b[<${button};${col};${row}M`;
}

async function runOne(dimension, lifecycle) {
  const session = new TuiSession({
    args: ["--dangerously-bypass-approvals-and-sandbox"],
    cols: dimension.cols,
    rows: dimension.rows,
    cwd: lifecycle.cwd,
    env: WORKBENCH_ENV,
    gateState: lifecycle.gateState,
  });
  trackActiveSession(lifecycle, session);
  const label = `${dimension.cols}x${dimension.rows}`;

  try {
    await session.start({ firstPaintMs: 1_000, postReplyMs: 1_000 });
    await session.waitForPrompt({ timeout: 20_000 });
    assertFrameShape(session, dimension, `${label} cold start`);

    // The loopback model returns 120 deterministic anchor lines for this
    // prompt, avoiding shell admission and host command dependencies.
    await session.submit(LONG_OUTPUT_PROMPT);
    await session.waitFor(/WBANCHOR-120/, {
      timeout: 20_000,
      label: `${label} tail anchor`,
    });
    await session.waitForIdle({ idleWindow: 1_000, timeout: 20_000 });
    assertFrameShape(session, dimension, `${label} long output tail`);
    assertExplorerRailVisible(session, dimension, `${label} long output tail`);
    await waitForFrame(
      session,
      dimension,
      (frame) => frame.includes("WBANCHOR-120"),
      `${label} tail visible`,
    );

    await sendRepeated(session, sgrWheel(64, dimension), 20, 30);
    await session.waitForIdle({ idleWindow: 800, timeout: 10_000 });
    assertFrameShape(session, dimension, `${label} mouse wheel scrolled up`);
    assertExplorerRailVisible(session, dimension, `${label} mouse wheel scrolled up`);
    await waitForFrame(
      session,
      dimension,
      (frame) => /WBANCHOR-0[0-8][0-9]/u.test(frame),
      `${label} old anchor visible after mouse wheel`,
    );

    await sendRepeated(session, sgrWheel(65, dimension), 40, 30);
    await session.waitForIdle({ idleWindow: 800, timeout: 10_000 });
    assertFrameShape(session, dimension, `${label} mouse wheel scrolled down`);
    assertExplorerRailVisible(session, dimension, `${label} mouse wheel scrolled down`);
    await waitForFrame(
      session,
      dimension,
      (frame) => frame.includes("WBANCHOR-120"),
      `${label} tail restored after mouse wheel`,
    );

    await sendRepeated(session, "\x1b[5~", 18);
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    assertFrameShape(session, dimension, `${label} scrolled up`);
    assertExplorerRailVisible(session, dimension, `${label} scrolled up`);
    await waitForFrame(
      session,
      dimension,
      (frame) => /WBANCHOR-00[1-9]|WBANCHOR-01[0-9]|WBANCHOR-02[0-9]/u.test(frame),
      `${label} old anchor visible`,
    );

    await sendRepeated(session, "\x1b[6~", 18);
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    assertFrameShape(session, dimension, `${label} scrolled down`);
    assertExplorerRailVisible(session, dimension, `${label} scrolled down`);
    await waitForFrame(
      session,
      dimension,
      (frame) => frame.includes("WBANCHOR-120"),
      `${label} tail restored`,
    );

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
    prefix: "agenc-tui-transcript-scroll-",
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
    lifecycle.cwd = createTuiGateProject(gateState);
    // The transcript fixture intentionally runs a local `!seq` command.
    // Make its sandbox policy explicit instead of depending on host support
    // for optional bubblewrap/user namespaces.
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
      if (lifecycle.aborted) return 1;
      const label = `${dimension.cols}x${dimension.rows}`;
      process.stdout.write(`workbench transcript scroll: ${label} ... `);
      try {
        await runOne(dimension, lifecycle);
        process.stdout.write("ok\n");
      } catch (error) {
        process.stdout.write("failed\n");
        failures.push({ label, error });
      }
      if (lifecycle.aborted) return 1;
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
