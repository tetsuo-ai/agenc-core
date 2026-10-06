import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stripAnsi } from "../harness.mjs";
import { waitForFrameText } from "../helpers/frame.mjs";

export const meta = {
  description: "The alternate footer, custom status-line command, and cost dialog receive canonical daemon usage.",
  args: [],
  env: { AGENC_TUI_WORKBENCH: "0" },
  slimCwd: true,
  // The daemon runs the status-line command through the session sandbox. A
  // host without a usable sandbox (a Linux container without bubblewrap)
  // refuses it with sandbox_policy_unexpressible and the footer stays blank,
  // so pin full access like the other command-running scenarios. This
  // scenario checks the usage the command receives, not the sandbox.
  sandboxMode: "danger-full-access",
  timeoutMs: 90_000,
};

// The footer notice for a status line the daemon refused or failed to run
// (daemonStatusLineNotice in src/tui/startup/StatusLine.tsx). The notice is
// transient, so read it from the whole PTY stream. Ink draws some of its
// spaces as cursor-forward moves; turn those back into spaces, and stop at
// the box-drawing characters of the chrome painted next to it.
const STATUS_LINE_NOTICE =
  /status\s*line\s*command\s*(?:blocked|failed|timed\s*out|is\s*not\s*supported)[^\n\u2500-\u257f]{0,200}/u;

function statusLineNotice(session) {
  const text = stripAnsi(
    session.raw.replace(/\x1b\[(\d*)C/gu, (_, count) => " ".repeat(Number(count || 1))),
  );
  return STATUS_LINE_NOTICE.exec(text)?.[0].trim();
}

export default async function (session) {
  const configPath = join(session.gateState.agencHome, "config.toml");
  const scriptPath = join(session.gateState.agencHome, "status-line-135.mjs");
  const receiptPath = join(session.cwd, "status-line-135.jsonl");
  const existingConfig = await readFile(configPath, "utf8");
  assert.doesNotMatch(existingConfig, /^\[statusLine\]/mu);
  await writeFile(scriptPath, [
    'import { appendFileSync } from "node:fs";',
    'let input = "";',
    'for await (const chunk of process.stdin) input += chunk;',
    'const status = JSON.parse(input);',
    'const receipt = {',
    '  sessionId: status.session_id,',
    '  cwd: status.cwd,',
    '  currentDir: status.workspace.current_dir,',
    '  projectDir: status.workspace.project_dir,',
    '  model: status.model.id,',
    '  costUsd: status.cost.total_cost_usd,',
    '  hasUnknownCost: status.cost.has_unknown_cost,',
    '  inputTokens: status.context_window.total_input_tokens,',
    '  outputTokens: status.context_window.total_output_tokens,',
    '};',
    `appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(receipt) + "\\n");`,
    'process.stdout.write(`STATUS_HOOK_135_OK_${receipt.outputTokens}`);',
    '',
  ].join("\n"));
  const command = `"${process.execPath}" "${scriptPath}"`;
  await writeFile(configPath, `${existingConfig}\n[statusLine]\ntype = "command"\ncommand = ${JSON.stringify(command)}\n`);
  await session.start();
  await session.waitForPrompt({ timeout: 20_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 45_000 });
  await session.waitForPrompt({ timeout: 20_000 });
  await waitForFrameText(
    session,
    /\$0\.00/u,
    "canonical local-model cost in the alternate footer",
    15_000,
  );
  const rollout = await session.readRolloutItems();
  const usage = rollout.filter((item) =>
    item.type === "event_msg" && item.payload?.msg?.type === "session_usage",
  ).at(-1)?.payload.msg.payload;
  if (usage?.modelCalls !== 1 || usage.costUsd !== 0 || usage.hasUnknownCost !== false) {
    throw new Error(`Unexpected canonical mock usage: ${JSON.stringify(usage)}`);
  }
  const sessionMeta = rollout.find((item) => item.type === "session_meta")?.payload;
  assert.ok(sessionMeta?.sessionId, "The canonical rollout must identify the session");
  assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0);
  const expectedReceipt = {
    sessionId: sessionMeta.sessionId,
    cwd: session.cwd,
    currentDir: session.cwd,
    projectDir: session.cwd,
    model: usage.models[0].model,
    costUsd: usage.costUsd,
    hasUnknownCost: usage.hasUnknownCost,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  try {
    await waitForFrameText(
      session,
      new RegExp(`STATUS_HOOK_135_OK_${usage.outputTokens}\\b`, "u"),
      "the custom status-line command with canonical output tokens",
      15_000,
    );
  } catch (error) {
    const notice = statusLineNotice(session);
    if (notice === undefined) throw error;
    throw new Error(`the status-line command did not render; the footer reported: ${notice}`, { cause: error });
  }
  const receipts = (await readFile(receiptPath, "utf8"))
    .split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(receipts.some((receipt) => {
    try {
      assert.deepEqual(receipt, expectedReceipt);
      return true;
    } catch {
      return false;
    }
  }), `No custom status-line receipt matches canonical usage: ${JSON.stringify({ expectedReceipt, receipts })}`);
  const admission = (await session.readRolloutItems())
    .filter((item) => item.type === "event_msg" && item.payload?.msg?.type === "execution_admission")
    .map((item) => item.payload.msg.payload)
    .filter((event) => event.kind === "tool_exec" && event.stepId.startsWith("hook:StatusLine:"));
  assert.ok(admission.some((event) => event.event === "dispatched" && admission.some((completed) =>
    completed.stepId === event.stepId && completed.event === "reconciled",
  )), "The daemon must dispatch and reconcile the status-line hook through execution admission");
  await session.submitSlashCommand("/cost");
  await waitForFrameText(session, /BY MODEL/u, "matching model usage in cost dialog", 15_000);
}
