#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { TuiSession, renderPtyRows } from "./check-tui-e2e/harness.mjs";
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
  { cols: 60, rows: 20 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackActiveSession(lifecycle, session) {
  if (lifecycle.activeSession !== null) {
    throw new Error("workbench visual smoke already has an active TUI session");
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
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "workbench visual smoke cleanup failed");
  }
}

function fail(message, details = {}) {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  throw new Error(suffix ? `${message} (${suffix})` : message);
}

function markerColumns(rows, markers) {
  const matches = [];
  for (const [rowIndex, row] of rows.entries()) {
    for (const marker of markers) {
      const column = row.indexOf(marker);
      if (column !== -1) {
        matches.push({ row: rowIndex + 1, column, marker });
      }
    }
  }
  return matches;
}

function assertFrameWidthContract(rows, dimension, label) {
  const autoWraps = rows.autoWraps ?? [];
  if (autoWraps.length > 0) {
    fail("workbench frame caused terminal autowrap", {
      label,
      wraps: autoWraps.length,
      first: JSON.stringify(autoWraps[0]),
    });
  }
  for (const [index, row] of rows.entries()) {
    if (row.length > dimension.cols) {
      fail("workbench frame overflow", {
        label,
        row: index + 1,
        width: row.length,
        cols: dimension.cols,
      });
    }
  }
}

function assertPaneLocality(rows, dimension, label) {
  const explorerMarkers = markerColumns(rows, ["WORKSPACE"]);
  const surfaceMarkers = markerColumns(rows, ["TRANSCRIPT", "DIFF"]);
  const agentMarkers = markerColumns(rows, ["Agents"]);
  const surfaceStart = Math.min(...surfaceMarkers.map((match) => match.column));
  const agentStart = agentMarkers.length > 0
    ? Math.min(...agentMarkers.map((match) => match.column))
    : dimension.cols;

  if (Number.isFinite(surfaceStart)) {
    for (const match of explorerMarkers) {
      if (match.column >= surfaceStart) {
        fail("workbench explorer marker overlapped active surface", {
          label,
          marker: match.marker,
          row: match.row,
          column: match.column,
          surfaceStart,
        });
      }
    }
    for (const match of surfaceMarkers) {
      if (match.column >= agentStart) {
        fail("workbench surface marker overlapped agents rail", {
          label,
          marker: match.marker,
          row: match.row,
          column: match.column,
          agentStart,
        });
      }
    }
  }

  if (agentMarkers.length > 0 && Number.isFinite(surfaceStart)) {
    for (const match of agentMarkers) {
      if (match.column <= surfaceStart) {
        fail("workbench agents marker overlapped active surface", {
          label,
          marker: match.marker,
          row: match.row,
          column: match.column,
          surfaceStart,
        });
      }
    }
  }
}

function assertFrame(session, dimension, label, anchors) {
  const rows = renderPtyRows(session.raw, dimension);
  const frame = rows.join("\n");
  if (rows.every((row) => row.trim().length === 0)) {
    fail("blank workbench frame", { label });
  }
  assertFrameWidthContract(rows, dimension, label);
  assertPaneLocality(rows, dimension, label);
  const lower = frame.toLowerCase();
  if (!anchors.some((anchor) => lower.includes(anchor.toLowerCase()))) {
    fail("workbench anchor missing", {
      label,
      anchors: JSON.stringify(anchors),
    });
  }
}

async function runOne(dimension, lifecycle) {
  const session = new TuiSession({
    cols: dimension.cols,
    rows: dimension.rows,
    cwd: lifecycle.cwd,
    gateState: lifecycle.gateState,
    env: {
      AGENC_TUI_WORKBENCH: "1",
      AGENC_OAUTH_TOKEN: "test-workbench-visual-token",
    },
  });
  trackActiveSession(lifecycle, session);
  const label = `${dimension.cols}x${dimension.rows}`;
  try {
    await session.start({ firstPaintMs: 1_000, postReplyMs: 1_000 });
    await session.waitForPrompt({ timeout: 20_000 });
    assertFrame(session, dimension, `${label} cold start`, ["AgenC Workbench", "TRANSCRIPT", "WORKSPA"]);

    session.send("\x17h");
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    assertFrame(session, dimension, `${label} explorer focus`, ["WORKSPACE", "WORKSPA"]);

    // Ctrl-W j is the documented composer-focus shortcut at every responsive
    // layout. Moving right from the explorer is ambiguous once panes collapse.
    session.send("\x17j");
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    await session.submitSlashCommand("/diff");
    await session.waitForIdle({ idleWindow: 900, timeout: 20_000 });
    await sleep(300);
    assertFrame(
      session,
      dimension,
      `${label} diff surface`,
      ["AgenC Workbench | DIFF"],
    );
    assertFrame(
      session,
      dimension,
      `${label} diff command`,
      ["git diff HEAD"],
    );
    assertFrame(
      session,
      dimension,
      `${label} diff fixture`,
      ["M diff-fixture.txt"],
    );
    session.assertNoCrash();
  } finally {
    await cleanupActiveSession(lifecycle);
  }
}

async function main() {
  const gateStatePromise = createTuiGateState({
    prefix: "agenc-tui-workbench-visual-",
  });
  const lifecycle = {
    gateState: null,
    pendingGateState: gateStatePromise,
    cwd: null,
    activeSession: null,
    activeSessionCleanup: null,
    aborted: false,
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
    await configureTuiGateSandbox(gateState, BIN_AGENC, undefined);
    if (lifecycle.aborted) return 1;
    await startTuiGateDaemon(gateState, BIN_AGENC);
    if (lifecycle.aborted) return 1;

    const failures = [];
    for (const dimension of DIMENSIONS) {
      if (lifecycle.aborted) return 1;
      const label = `${dimension.cols}x${dimension.rows}`;
      process.stdout.write(`workbench visual smoke: ${label} ... `);
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
