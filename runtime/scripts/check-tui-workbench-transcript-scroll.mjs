#!/usr/bin/env node
import { TuiSession, renderPtyRows } from "./check-tui-e2e/harness.mjs";

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

const LONG_OUTPUT_COMMAND = "!seq -f WBANCHOR-%03g 1 120 #";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (!frame.includes("TRANSCRIPT")) {
    fail("transcript title absent from frame", {
      label,
      frame: JSON.stringify(frame.slice(0, 1200)),
    });
  }
}

function assertExplorerRailVisible(session, dimension, label) {
  if (dimension.cols < 100) return;
  const rows = frameRows(session, dimension);
  const frame = rows.join("\n");
  const hasTreeRow = rows.some((row) => /^\s+[v>] \S/u.test(row.slice(0, 26)));
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

async function runOne(dimension) {
  const session = new TuiSession({
    cols: dimension.cols,
    rows: dimension.rows,
    env: WORKBENCH_ENV,
    useTempHome: true,
  });
  const label = `${dimension.cols}x${dimension.rows}`;

  try {
    await session.start({ firstPaintMs: 1_000, postReplyMs: 1_000 });
    await session.waitForPrompt({ timeout: 20_000 });
    assertFrameShape(session, dimension, `${label} cold start`);

    await session.submit(LONG_OUTPUT_COMMAND);
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
    session.kill();
    await session.cleanup();
  }
}

async function main() {
  const failures = [];
  for (const dimension of DIMENSIONS) {
    const label = `${dimension.cols}x${dimension.rows}`;
    process.stdout.write(`workbench transcript scroll: ${label} ... `);
    try {
      await runOne(dimension);
      process.stdout.write("ok\n");
    } catch (error) {
      process.stdout.write("failed\n");
      failures.push({ label, error });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n${failure.label}: ${failure.error?.message ?? failure.error}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exit(1);
});
