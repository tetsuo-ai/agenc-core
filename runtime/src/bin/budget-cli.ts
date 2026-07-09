/**
 * `agenc budget` — inspect and operate cost-bounded autonomy (TODO task 15).
 *
 *   agenc budget status [--json]     per-agent spend vs caps + policy
 *   agenc budget reset <agent>       clear an agent's spend + pause (operator)
 *
 * Read-only except `reset`. Never signs, spends, or mutates agent/daemon state
 * beyond the budget ledger.
 */

import { resolveAgencHome } from "../config/env.js";
import { loadConfig } from "../config/loader.js";
import { BudgetLedger } from "../budget/ledger.js";
import { resolveBudgetPolicy } from "../budget/config.js";
import type { BudgetPolicy } from "../budget/types.js";

export type AgenCBudgetCliCommand =
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "reset"; readonly agentId: string }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function formatAgenCBudgetCliHelpText(): string {
  return [
    "agenc budget — inspect and operate cost-bounded autonomy",
    "",
    "Usage:",
    "  agenc budget status [--json]     Policy + per-agent spend vs caps",
    "  agenc budget reset <agent>       Clear an agent's spend and un-pause it",
    "",
    "Budget is enforced daemon-side around autonomous turns and is disabled by",
    "default. Configure via [budget] in config.toml or AGENC_BUDGET* env vars.",
    "Ledger: <AGENC_HOME>/budget/ledger.json",
    "",
    "Options:",
    "  -h, --help  Show this help text",
  ].join("\n");
}

export function parseAgenCBudgetCliArgs(
  argv: readonly string[],
): AgenCBudgetCliCommand | null {
  if (argv[0] !== "budget") return null;
  const rest = argv.slice(1);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    return { kind: "help", text: formatAgenCBudgetCliHelpText() };
  }
  const json = rest.includes("--json");
  const positional = rest.filter((a) => !a.startsWith("-"));
  if (positional[0] === "status") {
    return { kind: "status", json };
  }
  if (positional[0] === "reset") {
    if (positional[1] === undefined) {
      return { kind: "error", message: "budget reset needs an <agent> id" };
    }
    return { kind: "reset", agentId: positional[1] };
  }
  return {
    kind: "error",
    message: `unknown budget subcommand '${positional[0] ?? ""}' (expected: status, reset)`,
  };
}

export interface BudgetCliDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

interface BudgetStatusReport {
  readonly enabled: boolean;
  readonly policy: {
    readonly dailyUsd?: number;
    readonly monthlyUsd?: number;
    readonly dailyTokens?: number;
    readonly monthlyTokens?: number;
    readonly softThreshold: number;
    readonly enforceInteractive: boolean;
  };
  readonly agents: ReadonlyArray<{
    readonly agentId: string;
    readonly paused: boolean;
    readonly day: { usd: number; tokens: number; key: string };
    readonly month: { usd: number; tokens: number; key: string };
  }>;
}

function policyView(policy: BudgetPolicy): BudgetStatusReport["policy"] {
  return {
    ...(policy.caps.dailyUsd !== undefined ? { dailyUsd: policy.caps.dailyUsd } : {}),
    ...(policy.caps.monthlyUsd !== undefined
      ? { monthlyUsd: policy.caps.monthlyUsd }
      : {}),
    ...(policy.caps.dailyTokens !== undefined
      ? { dailyTokens: policy.caps.dailyTokens }
      : {}),
    ...(policy.caps.monthlyTokens !== undefined
      ? { monthlyTokens: policy.caps.monthlyTokens }
      : {}),
    softThreshold: policy.softThreshold,
    enforceInteractive: policy.enforceInteractive,
  };
}

export async function runAgenCBudgetCli(
  command: AgenCBudgetCliCommand,
  deps: BudgetCliDeps = {},
): Promise<number> {
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (command.kind === "help") {
    stdout(command.text);
    return 0;
  }
  if (command.kind === "error") {
    stderr(`agenc: ${command.message}`);
    return 1;
  }

  const env = deps.env ?? process.env;
  const agencHome = resolveAgencHome(env);
  const loaded = await loadConfig({ home: agencHome, onWarn: () => {} });
  const { policy } = resolveBudgetPolicy(loaded.config.budget, env);
  const ledger = new BudgetLedger({ agencHome });

  if (command.kind === "reset") {
    ledger.reset(command.agentId);
    stdout(`Budget reset for agent ${command.agentId} (spend cleared, un-paused).`);
    return 0;
  }

  const report: BudgetStatusReport = {
    enabled: policy.enabled,
    policy: policyView(policy),
    agents: ledger.listAgents().map((agentId) => {
      const s = ledger.snapshot(agentId);
      return {
        agentId,
        paused: s.paused,
        day: { usd: s.day.usd, tokens: s.day.tokens, key: s.day.key },
        month: { usd: s.month.usd, tokens: s.month.tokens, key: s.month.key },
      };
    }),
  };

  if (command.json) {
    stdout(JSON.stringify(report, null, 2));
    return 0;
  }

  stdout("AgenC budget");
  stdout("");
  stdout(`  Enforcement: ${report.enabled ? "enabled" : "disabled (no caps active)"}`);
  const p = report.policy;
  const caps: string[] = [];
  if (p.dailyUsd !== undefined) caps.push(`$${p.dailyUsd}/day`);
  if (p.monthlyUsd !== undefined) caps.push(`$${p.monthlyUsd}/month`);
  if (p.dailyTokens !== undefined) caps.push(`${p.dailyTokens} tok/day`);
  if (p.monthlyTokens !== undefined) caps.push(`${p.monthlyTokens} tok/month`);
  stdout(`  Caps:        ${caps.length > 0 ? caps.join(", ") : "none"}`);
  stdout(
    `  Scope:       ${p.enforceInteractive ? "all turns" : "autonomous turns only"}` +
      ` (soft warn at ${Math.round(p.softThreshold * 100)}%)`,
  );
  stdout("");
  if (report.agents.length === 0) {
    stdout("  No per-agent spend recorded yet.");
  } else {
    stdout("  Agents:");
    for (const a of report.agents) {
      stdout(
        `    ${a.agentId}${a.paused ? " [PAUSED]" : ""}: ` +
          `$${a.day.usd.toFixed(4)} today, $${a.month.usd.toFixed(4)} this month`,
      );
    }
  }
  return 0;
}
