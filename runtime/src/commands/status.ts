/**
 * `/status` — show session/runtime status.
 *
 * Read-only snapshot of: session id, project root, cwd, model + provider,
 * turn count, token usage (BudgetTracker.emitted + remaining), uptime,
 * and permission mode. Runs `immediate: true` — no LLM round-trip.
 *
 * @module
 */

import { monotonicMs } from "../utils/monotonic.js";
import type { Session } from "../session/session.js";
import type { PermissionModeRegistry } from "../permissions/mode.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

interface StatusLine {
  key: string;
  value: string;
}

/**
 * Build the status lines from a Session. Exposed for tests so they can
 * assert structure without reaching through the formatting layer.
 */
export function collectStatus(
  session: Session,
  cwd: string,
  nowMs: number = monotonicMs(),
): StatusLine[] {
  const lines: StatusLine[] = [];
  lines.push({ key: "Session ID", value: session.conversationId });
  lines.push({ key: "CWD", value: cwd });

  // Read SessionConfiguration via the lock's synchronous peek. This is
  // safe for an immediate:true display command — no concurrent writer
  // would race a cheap fields-only read, and using `.with()` would
  // force us into an async code path the dispatcher doesn't need.
  const rawState = session.state.unsafePeek() as {
    sessionConfiguration?: {
      cwd?: string;
      collaborationMode?: { model?: string };
      provider?: { slug?: string };
      approvalPolicy?: { value?: string };
    };
    history?: unknown[];
  };
  const stateObj = rawState ?? null;

  if (stateObj?.sessionConfiguration) {
    const sc = stateObj.sessionConfiguration;
    const model = sc.collaborationMode?.model ?? "unknown";
    const provider = sc.provider?.slug ?? "unknown";
    lines.push({ key: "Model", value: model });
    lines.push({ key: "Provider", value: provider });
  } else {
    lines.push({ key: "Model", value: "unknown" });
    lines.push({ key: "Provider", value: "unknown" });
  }

  const turnCount = stateObj?.history?.length ?? 0;
  lines.push({ key: "Turn count", value: String(turnCount) });

  // Token usage: prefer BudgetTracker.emitted; remaining may be null
  // (unbounded) or finite.
  const bt = session.budgetTracker;
  if (bt) {
    const emitted = bt.emitted;
    const remaining = bt.remaining;
    lines.push({ key: "Tokens emitted", value: String(emitted) });
    lines.push({
      key: "Tokens remaining",
      value: remaining === null || !Number.isFinite(remaining)
        ? "unlimited"
        : String(remaining),
    });
  } else {
    lines.push({ key: "Tokens emitted", value: "n/a (budget disabled)" });
  }

  const uptime = Math.max(0, nowMs - session.createdAtMs);
  lines.push({ key: "Uptime (ms)", value: String(uptime) });

  // Permission mode — sourced from the T11 `PermissionModeRegistry`
  // (`session.services.permissionModeRegistry`). Fall back to "default"
  // when the registry is not wired (unit-test fixtures, early bootstrap).
  const services = (session as unknown as {
    services?: { permissionModeRegistry?: PermissionModeRegistry | null };
  }).services;
  const registry = services?.permissionModeRegistry ?? null;
  lines.push({
    key: "Permission mode",
    value: registry?.current().mode ?? "default",
  });

  return lines;
}

/**
 * Render StatusLine[] into a column-aligned text block.
 */
export function formatStatus(lines: ReadonlyArray<StatusLine>): string {
  const width = lines.reduce((m, l) => Math.max(m, l.key.length), 0);
  return lines
    .map((l) => `${l.key.padEnd(width)} : ${l.value}`)
    .join("\n");
}

export const statusCommand: SlashCommand = {
  name: "status",
  description: "Show current session and runtime status",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const lines = collectStatus(ctx.session, ctx.cwd);
      return { kind: "text", text: formatStatus(lines) };
    }),
};

export default statusCommand;
