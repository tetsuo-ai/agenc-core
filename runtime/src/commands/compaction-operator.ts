import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import type {
  SessionExtendCompactionRetentionResult,
  SessionRollbackCompactionResult,
} from "../session/session.js";

interface CompactionOperatorSession {
  rollbackCompaction?(params: {
    readonly attemptId: string;
    readonly reviewedBranchTargetSessionId?: string;
  }): Promise<SessionRollbackCompactionResult>;
  extendCompactionRollbackRetention?(params: {
    readonly attemptId: string;
    readonly extendedUntilMs: number;
  }): Promise<SessionExtendCompactionRetentionResult>;
}

export const compactRollbackCommand: SlashCommand = {
  name: "compact-rollback",
  description: "Restore a committed compaction source history",
  argumentHint: "<attempt-id> [--branch <target-session-id>]",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx): Promise<SlashCommandResult> => safeExecute(async () => {
    const parsed = parseRollbackArgs(ctx.argsRaw);
    const rollback = operatorSession(ctx).rollbackCompaction;
    if (rollback === undefined) {
      throw new Error("compaction rollback is unavailable on this session");
    }
    const result = await rollback.call(ctx.session, parsed);
    return result.ok
      ? { kind: "text", text: result.displayText }
      : { kind: "error", message: result.message };
  }),
};

export const compactRetainCommand: SlashCommand = {
  name: "compact-retain",
  description: "Extend a compaction rollback-retention deadline",
  argumentHint: "<attempt-id> --until <ISO-8601>",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx): Promise<SlashCommandResult> => safeExecute(async () => {
    const parsed = parseRetentionArgs(ctx.argsRaw);
    const extend = operatorSession(ctx).extendCompactionRollbackRetention;
    if (extend === undefined) {
      throw new Error("compaction retention extension is unavailable on this session");
    }
    const result = await extend.call(ctx.session, parsed);
    return result.ok
      ? { kind: "text", text: result.displayText }
      : { kind: "error", message: result.message };
  }),
};

function operatorSession(ctx: SlashCommandContext): CompactionOperatorSession {
  return ctx.session as CompactionOperatorSession;
}

function parseRollbackArgs(argsRaw: string): {
  readonly attemptId: string;
  readonly reviewedBranchTargetSessionId?: string;
} {
  const args = words(argsRaw);
  const attemptId = args.shift();
  if (attemptId === undefined) {
    throw new Error("usage: /compact-rollback <attempt-id> [--branch <target-session-id>]");
  }
  if (args.length === 0) return { attemptId };
  if (args.length !== 2 || args[0] !== "--branch" || args[1] === undefined) {
    throw new Error("usage: /compact-rollback <attempt-id> [--branch <target-session-id>]");
  }
  return { attemptId, reviewedBranchTargetSessionId: args[1] };
}

function parseRetentionArgs(argsRaw: string): {
  readonly attemptId: string;
  readonly extendedUntilMs: number;
} {
  const args = words(argsRaw);
  if (args.length !== 3 || args[1] !== "--until") {
    throw new Error("usage: /compact-retain <attempt-id> --until <ISO-8601>");
  }
  const extendedUntilMs = Date.parse(args[2]!);
  if (!Number.isFinite(extendedUntilMs)) {
    throw new Error("--until must be a valid ISO-8601 timestamp");
  }
  return { attemptId: args[0]!, extendedUntilMs };
}

function words(value: string): string[] {
  return value.trim().split(/\s+/u).filter((part) => part.length > 0);
}
