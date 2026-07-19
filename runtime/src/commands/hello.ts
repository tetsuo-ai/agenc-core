/**
 * `/hello` — print a greeting card with the current model and workspace.
 *
 * Immediate, read-only utility that appends a framed text card to the
 * transcript so users can confirm which model and workspace the session is
 * bound to without opening `/status`.
 *
 * @module
 */

import { asRecord } from "../utils/record.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface HelloSnapshot {
  readonly model: string;
  readonly workspace: string;
}

interface SessionConfigShape {
  readonly collaborationMode?: { readonly model?: string };
  readonly cwd?: string;
}

function readSessionConfiguration(session: unknown): SessionConfigShape | null {
  const sessionRec = asRecord(session);
  const state = asRecord(sessionRec?.state);
  const peek = state?.unsafePeek;
  if (typeof peek === "function") {
    const peeked = asRecord(peek.call(sessionRec?.state));
    const fromState = asRecord(peeked?.sessionConfiguration);
    if (fromState !== null) {
      return fromState as SessionConfigShape;
    }
  }
  const fallback = asRecord(sessionRec?.sessionConfiguration);
  return fallback as SessionConfigShape | null;
}

/**
 * Resolve model + workspace for the greeting card.
 * Prefer session configuration; fall back to the dispatch cwd.
 */
export function collectHelloSnapshot(
  session: unknown,
  cwd: string,
): HelloSnapshot {
  const sc = readSessionConfiguration(session);
  const model =
    typeof sc?.collaborationMode?.model === "string" &&
    sc.collaborationMode.model.trim().length > 0
      ? sc.collaborationMode.model
      : "unknown";
  const workspace =
    typeof sc?.cwd === "string" && sc.cwd.trim().length > 0 ? sc.cwd : cwd;
  return { model, workspace };
}

/**
 * Render a simple ASCII greeting card for the transcript.
 */
export function formatHelloCard(snapshot: HelloSnapshot): string {
  const lines = [
    "Hello from AgenC",
    `Model     : ${snapshot.model}`,
    `Workspace : ${snapshot.workspace}`,
  ];
  const innerWidth = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const top = `┌${"─".repeat(innerWidth + 2)}┐`;
  const bottom = `└${"─".repeat(innerWidth + 2)}┘`;
  const body = lines
    .map((line) => `│ ${line.padEnd(innerWidth)} │`)
    .join("\n");
  return `${top}\n${body}\n${bottom}`;
}

export const helloCommand: SlashCommand = {
  name: "hello",
  description: "Print a greeting card with the current model and workspace",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const snapshot = collectHelloSnapshot(ctx.session, ctx.cwd);
      return { kind: "text", text: formatHelloCard(snapshot) };
    }),
};
