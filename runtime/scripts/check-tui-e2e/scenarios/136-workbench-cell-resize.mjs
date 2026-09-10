import assert from "node:assert/strict";
import { renderPtyRows } from "../harness.mjs";
import { waitForFrameText } from "../helpers/workbench-buffer-neovim.mjs";

export const meta = {
  description: "Workbench prompt and agents cells survive repeated live terminal resizing.",
  env: { AGENC_TUI_WORKBENCH: "1" },
  slimCwd: true,
  timeoutMs: 60_000,
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const prompt = "START " + Array.from({ length: 32 }, (_, index) => `word${index.toString().padStart(2, "0")}`).join(" ") + " END";

async function resize(session, columns) {
  session.cols = columns;
  session.term.resize(columns, session.rows);
  await sleep(400);
}

function cells(session) {
  return renderPtyRows(session.raw, { cols: session.cols, rows: session.rows });
}

export default async function (session) {
  session.cols = 160;
  session.rows = 48;
  await session.start();
  await session.waitForPrompt({ timeout: 20_000 });
  await session.type(prompt);
  await session.submit();
  await session.waitForAssistantReply({ timeout: 20_000 });
  await session.waitForPrompt({ timeout: 10_000 });

  for (const columns of [160, 200, 160]) {
    await resize(session, columns);
    await waitForFrameText(session, /START[\s\S]*END/u, "complete submitted prompt");
    const rows = cells(session);
    assert.ok(rows.some((row) => row.includes("WORKSPACE")));
    assert.ok(rows.some((row) => row.includes("AGENTS")));
    const startRow = rows.findIndex((row) => row.includes("START"));
    const endRow = rows.findIndex((row, index) => index >= startRow && row.includes("END"));
    const contentColumn = rows[startRow].indexOf("START");
    const frameColumns = columns - 4;
    const rightEdge = 2 + frameColumns - Math.max(24, Math.floor(frameColumns * 0.19)) - 3;
    assert.equal(rows.slice(startRow, endRow + 1).map((row) => row.slice(contentColumn, rightEdge).trim()).join(" "), prompt);
  }

  await session.submitSlashCommand("/agents");
  await waitForFrameText(session, /delegate-capable[\s\S]*name · Role/u, "agents table");
  for (const columns of [160, 200, 160]) {
    await resize(session, columns);
    const rows = cells(session);
    const header = rows.findIndex((row) => row.includes("name · Role"));
    const markers = ["default", "runner", "verification", "Plan", "scanner", "when-to-use", "tools", "model", "budget"];
    const positions = markers.map((marker) => rows.findIndex((row, index) => index > header && new RegExp(`\\b${marker}\\b`, "u").test(row)));
    assert.ok(header >= 0 && positions.every((position) => position >= 0), `Missing agents table cells at ${columns} columns: ${markers.filter((_, index) => positions[index] < 0).join(", ")}\n${rows.join("\n")}`);
    assert.equal(new Set(positions).size, markers.length, rows.join("\n"));
  }
  session.send("q");
  await session.waitForPrompt({ timeout: 10_000 });
}
