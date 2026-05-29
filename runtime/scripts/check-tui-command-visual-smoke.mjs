#!/usr/bin/env node
/**
 * Live slash-command visual smoke coverage.
 *
 * This complements the static design-state parity tests by opening the
 * retained command surfaces in a real PTY and checking the visible terminal
 * frame. It catches transient rich commands, missing hint spacing, and menu
 * content that starts below the viewport.
 */
import { TuiSession, renderPtyRows } from "./check-tui-e2e/harness.mjs";

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
    anchors: ["HOOKS", "hooks runtime", "runtime bridge missing"],
    supporting: ["hooks"],
    requiresFooter: true,
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
    supporting: ["delegate-capable", "registered"],
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
    supporting: ["git diff HEAD", "no uncommitted changes", "runtime/src"],
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

async function runOne(spec, dimension) {
  const session = new TuiSession({
    cols: dimension.cols,
    rows: dimension.rows,
  });
  const label = `${spec.command} ${dimension.cols}x${dimension.rows}`;
  try {
    await session.start({ firstPaintMs: 1_000, postReplyMs: 1_000 });
    await session.waitForPrompt({ timeout: 20_000 });
    assertNoMalformedHints(session.latestFrame, `${label} cold-start`);

    await session.submitSlashCommand(spec.command);
    await session.waitForIdle({ idleWindow: 900, timeout: 20_000 });
    if (spec.settleMs) await sleep(spec.settleMs);
    assertSurfaceVisible(session, spec, dimension);
    session.assertNoCrash();
  } finally {
    forceKillSession(session);
    await session.cleanup();
  }
}

async function main() {
  const failures = [];
  for (const dimension of DIMENSIONS) {
    for (const spec of COMMANDS) {
      const label = `${spec.command} ${dimension.cols}x${dimension.rows}`;
      process.stdout.write(`command visual smoke: ${label} ... `);
      try {
        await runOne(spec, dimension);
        process.stdout.write("ok\n");
      } catch (error) {
        process.stdout.write("failed\n");
        failures.push({ label, error });
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n${failure.label}: ${failure.error?.message ?? failure.error}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exit(1);
});
