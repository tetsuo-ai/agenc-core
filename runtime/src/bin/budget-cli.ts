/**
 * `agenc budget` — inspect cost-bounded admission policy.
 *
 *   agenc budget status [--json]     configured admission policy
 *   agenc budget reset <agent>       rejected legacy mutation
 *
 * Durable usage and holds belong to the daemon execution-admission journal.
 * This command never mutates that accounting; inspect/cancel a run with
 * `agenc run status|replay|evidence|cancel`.
 */

import { resolveAgencHome } from "../config/env.js";
import { loadConfig } from "../config/loader.js";
import { resolveBudgetPolicy } from "../budget/config.js";
import type { BudgetPolicy } from "../budget/types.js";

export type AgenCBudgetCliCommand =
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "reset"; readonly agentId: string }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function formatAgenCBudgetCliHelpText(): string {
  return [
    "agenc budget — inspect cost-bounded execution admission",
    "",
    "Usage:",
    "  agenc budget status [--json]     Show configured admission policy",
    "  agenc budget reset <agent>       Rejected (legacy ledger mutation removed)",
    "",
    "Budget is enforced at daemon-owned model/tool boundaries and is disabled",
    "by default. Inspect durable usage with: agenc run status <run-id>.",
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
  readonly authority: "execution_admission_kernel";
  readonly enabled: boolean;
  readonly policy: {
    readonly dailyUsd?: number;
    readonly monthlyUsd?: number;
    readonly dailyTokens?: number;
    readonly monthlyTokens?: number;
    readonly softThreshold: number;
    readonly enforceInteractive: boolean;
  };
  readonly inspect: "agenc run status <run-id>";
  readonly cancel: "agenc run cancel <run-id> --reason <reason>";
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
  if (command.kind === "reset") {
    stderr(
      "agenc: budget reset is unavailable: durable admission accounting is immutable; " +
        "use 'agenc run status <run-id>' to inspect or 'agenc run cancel <run-id>' to stop work",
    );
    return 1;
  }
  const agencHome = resolveAgencHome(env);
  const loaded = await loadConfig({ home: agencHome, onWarn: () => {} });
  const { policy } = resolveBudgetPolicy(loaded.config.budget, env);
  const report: BudgetStatusReport = {
    authority: "execution_admission_kernel",
    enabled: policy.enabled,
    policy: policyView(policy),
    inspect: "agenc run status <run-id>",
    cancel: "agenc run cancel <run-id> --reason <reason>",
  };

  if (command.json) {
    stdout(JSON.stringify(report, null, 2));
    return 0;
  }

  stdout("AgenC budget");
  stdout("");
  stdout("  Authority:   daemon execution-admission kernel");
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
  stdout("  Usage:       agenc run status <run-id>");
  stdout("  Evidence:    agenc run evidence <run-id>");
  stdout("  Cancellation: agenc run cancel <run-id> --reason <reason>");
  return 0;
}
