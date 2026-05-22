#!/usr/bin/env node
import { TuiSession, renderPtyRows } from "./check-tui-e2e/harness.mjs";

const DIMENSIONS = [
  { cols: 148, rows: 40 },
  { cols: 120, rows: 30 },
  { cols: 80, rows: 24 },
  { cols: 60, rows: 20 },
];

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

function assertFrame(session, dimension, label, anchors) {
  const rows = renderPtyRows(session.raw, dimension);
  const frame = rows.join("\n");
  if (rows.every((row) => row.trim().length === 0)) {
    fail("blank workbench frame", { label });
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
  const lower = frame.toLowerCase();
  if (!anchors.some((anchor) => lower.includes(anchor.toLowerCase()))) {
    fail("workbench anchor missing", {
      label,
      anchors: JSON.stringify(anchors),
    });
  }
}

async function runOne(dimension) {
  const session = new TuiSession({
    cols: dimension.cols,
    rows: dimension.rows,
    env: { AGENC_TUI_WORKBENCH: "1" },
  });
  const label = `${dimension.cols}x${dimension.rows}`;
  try {
    await session.start({ firstPaintMs: 1_000, postReplyMs: 1_000 });
    await session.waitForPrompt({ timeout: 20_000 });
    assertFrame(session, dimension, `${label} cold start`, ["agenc", "mode"]);

    session.send("\x17h");
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    assertFrame(session, dimension, `${label} explorer focus`, ["Explorer"]);

    session.send("\x17l");
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    await session.submitSlashCommand("/diff");
    await session.waitForIdle({ idleWindow: 900, timeout: 20_000 });
    await sleep(300);
    assertFrame(session, dimension, `${label} diff surface`, ["DIFF", "git diff HEAD", "[q] close"]);
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
    process.stdout.write(`workbench visual smoke: ${label} ... `);
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
