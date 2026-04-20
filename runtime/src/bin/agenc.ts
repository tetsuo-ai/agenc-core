#!/usr/bin/env node
/**
 * `agenc` CLI entry point — lean rebuild.
 *
 * One-shot, no TUI yet. Reads a prompt from argv (or stdin), boots the
 * Grok provider, builds the coding-profile tool registry, runs the
 * `query` loop, and streams events to stdout. The Ink/React cockpit
 * lands in a later tranche; this lets us verify the agent path
 * end-to-end before adding UI.
 *
 * Usage:
 *   agenc "help me understand this repo"
 *   echo "..." | agenc
 *
 * Env:
 *   XAI_API_KEY        required — xAI API key (also accepts GROK_API_KEY)
 *   AGENC_MODEL        optional — model override (default: grok-4-fast)
 *   AGENC_WORKSPACE    optional — project root (default: process.cwd())
 */

import { cwd as processCwd } from "node:process";
import { GrokProvider } from "../llm/grok/index.js";
import type { LLMToolCall } from "../llm/types.js";
import { buildToolRegistry } from "../tool-registry.js";
import { query, type QueryEvent } from "../query.js";

const DEFAULT_MODEL = "grok-4-fast";

function resolveApiKey(): string {
  const key =
    process.env.XAI_API_KEY ??
    process.env.GROK_API_KEY ??
    process.env.AGENC_XAI_API_KEY ??
    "";
  if (!key) {
    throw new Error(
      "missing xAI API key — set XAI_API_KEY (or GROK_API_KEY) in the environment",
    );
  }
  return key;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function resolveUserMessage(): Promise<string> {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    return argv.join(" ").trim();
  }
  const piped = await readStdin();
  if (piped) return piped;
  throw new Error(
    "no prompt provided — pass as argv (`agenc ...`) or pipe via stdin",
  );
}

const SYSTEM_PROMPT = `You are AgenC, a coding assistant running in a terminal.

Do real tool calls instead of narrating. Prefer system.readFile,
system.editFile, system.bash, system.grep, system.glob over describing
what you would do. End the turn when the work is done or when you
genuinely need user input — not to announce progress.

Trust the output of tools you already ran. If a file's content is in
your context from a prior read, don't re-read it. Report outcomes
faithfully: if a command fails, say so; do not claim success without
evidence.

When modifying an existing file, prefer system.editFile over
system.writeFile. Read before editing so the match is grounded in the
actual file bytes.`;

function describeToolCall(toolCall: LLMToolCall): string {
  const tail =
    toolCall.arguments && toolCall.arguments.length > 80
      ? `${toolCall.arguments.slice(0, 80)}…`
      : (toolCall.arguments ?? "");
  return `${toolCall.name}(${tail})`;
}

function renderEvent(event: QueryEvent): void {
  switch (event.type) {
    case "turn_start":
      if (event.turnIndex > 0) {
        process.stderr.write(`\n── turn ${event.turnIndex + 1} ──\n`);
      }
      return;
    case "assistant_text":
      process.stdout.write(event.content);
      process.stdout.write("\n");
      return;
    case "tool_call":
      process.stderr.write(`→ ${describeToolCall(event.toolCall)}\n`);
      return;
    case "tool_result": {
      const tag = event.result.isError ? "✗" : "✓";
      const preview =
        event.result.content.length > 200
          ? `${event.result.content.slice(0, 200)}…`
          : event.result.content;
      process.stderr.write(`${tag} ${preview}\n`);
      return;
    }
    case "turn_complete": {
      const { usage, stopReason, error } = event;
      const line = `\n[${stopReason}] in:${usage.promptTokens} out:${usage.completionTokens} total:${usage.totalTokens}\n`;
      process.stderr.write(line);
      if (error) {
        process.stderr.write(`error: ${error.message}\n`);
      }
      return;
    }
  }
}

async function main(): Promise<number> {
  const apiKey = resolveApiKey();
  const userMessage = await resolveUserMessage();
  const workspaceRoot = process.env.AGENC_WORKSPACE ?? processCwd();
  const model = process.env.AGENC_MODEL ?? DEFAULT_MODEL;

  const registry = buildToolRegistry({ workspaceRoot });

  const provider = new GrokProvider({
    apiKey,
    model,
    tools: registry.toLLMTools(),
  });

  const events = query({
    provider,
    registry,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
  });

  for await (const event of events) {
    renderEvent(event);
    if (event.type === "turn_complete") {
      if (event.stopReason === "error") return 1;
      if (event.stopReason === "cancelled") return 130;
      return 0;
    }
  }

  // Generator ended without yielding turn_complete — shouldn't happen,
  // but surface as an error rather than a silent 0 exit.
  return 1;
}

void (async () => {
  try {
    const code = await main();
    process.exit(code);
  } catch (error) {
    process.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
})();
