/**
 * AgenC protocol slash commands (`/claim`, `/delegate`, `/proof`,
 * `/settle`, `/stake`).
 *
 * A1/A2 wiring: when the `[protocol]` config block is enabled with
 * adapter `"marketplace-cli"`, `/claim` becomes a READ-ONLY marketplace
 * browser — `/claim` lists claimable tasks, `/claim <task-pda>` shows
 * one task — through `ProtocolTransport` (which shells out to the
 * installed `agenc-marketplace` binary; see `src/protocol/`).
 *
 * Everything else stays honest and inert:
 *   - With the block absent/disabled (the default) every verb returns
 *     EXACTLY the historical "transport is not attached" stub text.
 *   - The mutating verbs (`/delegate`, `/proof`, `/settle`, `/stake` —
 *     and actually claiming a task) are owner-gated: with a transport
 *     attached they surface its typed VERB_NOT_ENABLED error instead of
 *     doing anything on-chain. No wallet reads, no signing, no spend.
 *
 * Marketplace-derived text is untrusted: it is sanitized before
 * rendering and never influences command construction.
 */

import type { ProtocolConfig } from "../config/schema.js";
import type {
  ClaimableTaskList,
  ProtocolResult,
  ProtocolTransport,
  ProtocolTransportError,
  TaskDetail,
} from "../protocol/index.js";
import { createProtocolTransport, isValidTaskPda } from "../protocol/index.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

type ProtocolVerb = "claim" | "delegate" | "proof" | "settle" | "stake";

const PROTOCOL_PLUGIN = {
  pluginManifest: { name: "agenc-core" },
} as const;

const READONLY_SAFETY_LINE = "Wallet/signing/mutation used: No.";

const descriptions: Record<ProtocolVerb, string> = {
  claim: "Claim an open task from the AgenC marketplace",
  delegate: "Delegate a task step to another AgenC worker",
  proof: "Generate or verify a proof for the current task",
  settle: "Submit task completion and settle escrow",
  stake: "Inspect or adjust AgenC protocol stake",
};

const usage: Record<ProtocolVerb, string> = {
  claim: "/claim <task-pda>",
  delegate: "/delegate <agent> <step>",
  proof: "/proof [target]",
  settle: "/settle [task-pda]",
  stake: "/stake [amount]",
};

function commandText(verb: ProtocolVerb, argsRaw: string): string {
  const args = argsRaw.trim();
  const lines = [
    `AgenC protocol · ${verb}`,
    descriptions[verb],
    `Usage: ${usage[verb]}`,
  ];
  if (args.length > 0) {
    lines.push("", `Requested: ${verb} ${args}`);
  }
  lines.push(
    "",
    "Protocol transport is not attached to this runtime yet; this command is registered for the TUI protocol surface and will emit protocol_* events once the on-chain client is configured.",
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Transport-attached rendering (A2)
// ─────────────────────────────────────────────────────────────────────

function isTransportAttached(config: ProtocolConfig | undefined): boolean {
  return config?.enabled === true && config.adapter === "marketplace-cli";
}

function transportFor(ctx: SlashCommandContext): ProtocolTransport {
  return createProtocolTransport(ctx.configStore?.current().protocol, {
    cwd: ctx.cwd,
  });
}

function renderTransportError(
  verb: ProtocolVerb,
  error: ProtocolTransportError,
): SlashCommandResult {
  return {
    kind: "error",
    message: `AgenC protocol · ${verb}: [${error.code}] ${error.message}`,
  };
}

function renderClaimableList(list: ClaimableTaskList): SlashCommandResult {
  const lines = [
    "AgenC protocol · claim — claimable mainnet tasks (read-only)",
    "",
  ];
  if (list.tasks.length === 0) {
    lines.push("No claimable tasks found.");
  } else {
    list.tasks.forEach((task, index) => {
      const fields = [
        task.status !== undefined ? `status=${task.status}` : undefined,
        task.reward !== undefined ? `reward=${task.reward}` : undefined,
      ].filter((f): f is string => f !== undefined);
      lines.push(
        `${index + 1}. ${task.taskPda}${fields.length > 0 ? `  (${fields.join(", ")})` : ""}`,
      );
      if (task.description !== undefined) {
        lines.push(`   ${task.description}`);
      }
    });
    lines.push("", "Use /claim <task-pda> for details.");
  }
  lines.push(
    "",
    "Claiming/submitting is owner-gated and not enabled in this runtime.",
    READONLY_SAFETY_LINE,
  );
  return { kind: "text", text: lines.join("\n") };
}

function renderTaskDetail(detail: TaskDetail): SlashCommandResult {
  const lines = [
    "AgenC protocol · claim — task detail (read-only)",
    "",
    `Task PDA: ${detail.taskPda}`,
  ];
  if (detail.status !== undefined) lines.push(`Status: ${detail.status}`);
  if (detail.reward !== undefined) lines.push(`Reward: ${detail.reward}`);
  if (detail.description !== undefined) {
    lines.push(`Description: ${detail.description}`);
  }
  if (detail.moderation !== undefined) {
    const m = detail.moderation;
    const fields = [
      m.status !== undefined ? `status=${m.status}` : undefined,
      m.riskScore !== undefined ? `riskScore=${m.riskScore}` : undefined,
      m.advisoryOnly !== undefined ? `advisoryOnly=${m.advisoryOnly}` : undefined,
      m.hardBoundary !== undefined ? `hardBoundary=${m.hardBoundary}` : undefined,
    ].filter((f): f is string => f !== undefined);
    if (fields.length > 0) lines.push(`Moderation: ${fields.join(", ")}`);
  }
  lines.push(
    "",
    "Claiming/submitting is owner-gated and not enabled in this runtime.",
    READONLY_SAFETY_LINE,
  );
  return { kind: "text", text: lines.join("\n") };
}

async function executeClaim(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const args = (ctx.argsRaw ?? "").trim();
  const transport = transportFor(ctx);
  if (args.length === 0) {
    const result = await transport.listClaimable({ limit: 10 });
    if (!result.ok) return renderTransportError("claim", result.error);
    return renderClaimableList(result.value);
  }
  // Strict pre-spawn validation: the argument must be PDA-shaped
  // (base58, length-bounded). Shell metacharacters, quotes, whitespace,
  // and flag-like strings never reach the adapter, let alone a process.
  if (!isValidTaskPda(args)) {
    return {
      kind: "error",
      message:
        "AgenC protocol · claim: invalid task PDA. Expected a base58 " +
        "Solana address (32-44 characters). No command was executed.",
    };
  }
  const result = await transport.taskDetail(args);
  if (!result.ok) return renderTransportError("claim", result.error);
  return renderTaskDetail(result.value);
}

async function executeOwnerGatedVerb(
  verb: Exclude<ProtocolVerb, "claim">,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const transport = transportFor(ctx);
  const argsRaw = ctx.argsRaw ?? "";
  const args = argsRaw.trim();
  let result: ProtocolResult<never>;
  switch (verb) {
    case "delegate":
      result = await transport.delegateStep("", args);
      break;
    case "proof":
      result = await transport.submitProof(args.length > 0 ? args : undefined);
      break;
    case "settle":
      result = await transport.settleTask(args.length > 0 ? args : undefined);
      break;
    case "stake":
      result = await transport.adjustStake(args.length > 0 ? args : undefined);
      break;
  }
  // Every current transport returns a typed error for mutating verbs;
  // render it honestly. `never` success cannot occur, but keep the
  // defensive fallback so a future contract break stays visible.
  const error: ProtocolTransportError = result.ok
    ? { code: "VERB_NOT_ENABLED", message: "unexpected success from owner-gated verb" }
    : result.error;
  const lines = [
    `AgenC protocol · ${verb}`,
    descriptions[verb],
    `Usage: ${usage[verb]}`,
  ];
  if (args.length > 0) {
    lines.push("", `Requested: ${verb} ${args}`);
  }
  lines.push(
    "",
    "Protocol transport is attached (read-only marketplace-cli adapter), " +
      `but this verb is owner-gated: [${error.code}] ${error.message}`,
    READONLY_SAFETY_LINE,
  );
  return { kind: "text", text: lines.join("\n") };
}

function protocolCommand(verb: ProtocolVerb): SlashCommand {
  return {
    name: verb,
    description: descriptions[verb],
    supportedSurfaces: ["runtime", "daemon-tui"],
    userInvocable: true,
    immediate: true,
    kind: "protocol",
    source: "plugin",
    loadedFrom: "plugin",
    pluginInfo: PROTOCOL_PLUGIN,
    execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
      safeExecute(async () => {
        // Revert-safe default: without an explicit enabled
        // marketplace-cli transport, behavior is EXACTLY the historical
        // stub text for every verb.
        if (!isTransportAttached(ctx.configStore?.current().protocol)) {
          return {
            kind: "text",
            text: commandText(verb, ctx.argsRaw),
          };
        }
        if (verb === "claim") {
          return executeClaim(ctx);
        }
        return executeOwnerGatedVerb(verb, ctx);
      }),
  };
}

export const protocolCommands: readonly SlashCommand[] = [
  protocolCommand("claim"),
  protocolCommand("delegate"),
  protocolCommand("proof"),
  protocolCommand("settle"),
  protocolCommand("stake"),
];
