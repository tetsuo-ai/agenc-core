import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { waitForFrameText } from "../helpers/workbench-buffer-neovim.mjs";

export const meta = {
  description: "The alternate footer, custom status-line command, and cost dialog receive canonical daemon usage.",
  args: [],
  env: { AGENC_TUI_WORKBENCH: "0" },
  slimCwd: true,
  timeoutMs: 90_000,
};

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
    /spend \$0\.00/u,
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
  await waitForFrameText(
    session,
    new RegExp(`STATUS_HOOK_135_OK_${usage.outputTokens}\\b`, "u"),
    "the custom status-line command with canonical output tokens",
    15_000,
  );
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
