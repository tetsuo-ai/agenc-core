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
      safeExecute(async () => ({
        kind: "text",
        text: commandText(verb, ctx.argsRaw),
      })),
  };
}

export const protocolCommands: readonly SlashCommand[] = [
  protocolCommand("claim"),
  protocolCommand("delegate"),
  protocolCommand("proof"),
  protocolCommand("settle"),
  protocolCommand("stake"),
];
