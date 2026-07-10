/**
 * `agenc onboard` — explicit entry into the first-run setup wizard
 * (TODO task 2, Phase 0).
 *
 * The wizard itself is the existing first-run TUI onboarding
 * (`src/onboarding/Onboarding.tsx`); this CLI only routes into it:
 *
 *   agenc onboard            launch the TUI with the wizard forced (works
 *                            even after a completed first run)
 *   agenc onboard --status   non-interactive report: wizard state + daemon
 *   agenc onboard --reset    clear the completed/seen flags so the wizard
 *                            shows again on the next interactive start
 *
 * The launch path is executed by bin/agenc.ts (it needs the default TUI
 * route): it sets `AGENC_ONBOARDING=force` process-internally — see
 * `shouldShowFirstRunOnboarding` — and never persists anything to config.
 */
import { resolveAgencHome } from "../config/env.js";
import { createTerminalActIO, type ActIO } from "../onboarding/acts/io.js";
import { runIdentityAct } from "../onboarding/acts/identity.js";
import { runChannelAct } from "../onboarding/acts/channel.js";
import { runAutonomyAct } from "../onboarding/acts/autonomy.js";
import { runRecap } from "../onboarding/acts/recap.js";
import {
  readOnboardingActs,
  type OnboardingActsState,
} from "../onboarding/acts/state.js";
import {
  readOnboardingState,
  resetFirstRunOnboarding,
  type FirstRunOnboardingState,
} from "../onboarding/projectOnboardingState.js";
import {
  readAgenCDaemonPid,
  resolveAgenCDaemonPidPath,
} from "../app-server/daemon-cli.js";

export type AgenCOnboardCliCommand =
  | { readonly kind: "launch" }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "reset" }
  | { readonly kind: "act"; readonly act: "identity" | "channel" | "autonomy" | "recap" }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function formatAgenCOnboardCliHelpText(): string {
  return [
    "agenc onboard — set up AgenC: provider, key, theme, first chat",
    "",
    "Usage:",
    "  agenc onboard            Launch the interactive setup wizard (re-runs",
    "                           even after a completed first run)",
    "  agenc onboard identity   Act 2a — name your agent (persona workspace +",
    "                           the one-time naming ritual)",
    "  agenc onboard channel    Act 2b — connect Telegram/Discord/Slack/WebChat",
    "                           with live token checks + the pairing walkthrough",
    "  agenc onboard autonomy   Act 3 — budget cap, heartbeat, cron, webhooks",
    "                           (guardrails first, always)",
    "  agenc onboard recap      Posture summary + starter prompts",
    "  agenc onboard --status   Print wizard completion + daemon status",
    "                           (non-interactive, for scripts)",
    "  agenc onboard --json     With --status: emit the report as JSON",
    "  agenc onboard --reset    Clear the wizard's completed/seen flags so it",
    "                           shows again on the next interactive start",
    "",
    "Options:",
    "  -h, --help  Show this help text",
    "",
    "See also: agenc doctor (environment diagnostics), agenc login (auth)",
  ].join("\n");
}

/**
 * Parse argv for the top-level `onboard` command. Returns null when argv is
 * not an `onboard` invocation so the caller can fall through to other CLIs.
 */
export function parseAgenCOnboardCliArgs(
  argv: readonly string[],
): AgenCOnboardCliCommand | null {
  if (argv[0] !== "onboard") return null;
  if (
    argv[1] === "identity" ||
    argv[1] === "channel" ||
    argv[1] === "autonomy" ||
    argv[1] === "recap"
  ) {
    if (argv.length > 2) {
      return {
        kind: "error",
        message: `onboard ${argv[1]} does not accept extra arguments`,
      };
    }
    return { kind: "act", act: argv[1] };
  }
  let status = false;
  let json = false;
  let reset = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCOnboardCliHelpText() };
    }
    if (arg === "--status") {
      status = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--reset") {
      reset = true;
      continue;
    }
    return {
      kind: "error",
      message: `onboard command does not accept argument '${arg}'`,
    };
  }
  if (reset && (status || json)) {
    return {
      kind: "error",
      message: "onboard --reset cannot be combined with --status/--json",
    };
  }
  if (json && !status) {
    return { kind: "error", message: "onboard --json requires --status" };
  }
  if (reset) return { kind: "reset" };
  if (status) return { kind: "status", json };
  return { kind: "launch" };
}

export interface OnboardDaemonStatus {
  readonly pidPath: string;
  readonly pid: number | null;
  readonly running: boolean;
}

export interface OnboardStatusReport {
  readonly agencHome: string;
  readonly onboarding: {
    readonly completed: boolean;
    readonly completedAt?: string;
    readonly seenCount: number;
    readonly selectedProvider?: string;
    readonly selectedModel?: string;
  };
  /** Act-level completion — the local, consent-free onboarding funnel. */
  readonly acts: OnboardingActsState["acts"];
  readonly daemon: OnboardDaemonStatus;
}

export interface OnboardCliDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPidRunning?: (pid: number) => boolean;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Test seams for the interactive acts. */
  readonly actIO?: ActIO;
  readonly runIdentityActFn?: typeof runIdentityAct;
  readonly runChannelActFn?: typeof runChannelAct;
  readonly runAutonomyActFn?: typeof runAutonomyAct;
  readonly runRecapFn?: typeof runRecap;
}

function defaultIsPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readOnboardDaemonStatus(
  env: Readonly<Record<string, string | undefined>> = process.env,
  isPidRunning: (pid: number) => boolean = defaultIsPidRunning,
): Promise<OnboardDaemonStatus> {
  const pidPath = resolveAgenCDaemonPidPath(env);
  const pid = await readAgenCDaemonPid(pidPath);
  return {
    pidPath,
    pid,
    running: pid !== null && isPidRunning(pid),
  };
}

export async function buildOnboardStatusReport(
  deps: OnboardCliDeps = {},
): Promise<OnboardStatusReport> {
  const env = deps.env ?? process.env;
  const agencHome = resolveAgencHome(env);
  const state: FirstRunOnboardingState = readOnboardingState({ agencHome });
  const daemon = await readOnboardDaemonStatus(
    env,
    deps.isPidRunning ?? defaultIsPidRunning,
  );
  return {
    agencHome,
    acts: readOnboardingActs(agencHome).acts,
    onboarding: {
      completed: state.completed,
      ...(state.completedAt !== undefined
        ? { completedAt: state.completedAt }
        : {}),
      seenCount: state.seenCount,
      ...(state.selectedProvider !== undefined
        ? { selectedProvider: state.selectedProvider }
        : {}),
      ...(state.selectedModel !== undefined
        ? { selectedModel: state.selectedModel }
        : {}),
    },
    daemon,
  };
}

export function formatOnboardStatusText(report: OnboardStatusReport): string {
  const lines: string[] = [];
  lines.push("AgenC onboarding status");
  lines.push("");
  lines.push(`  Home:      ${report.agencHome}`);
  lines.push(
    `  Wizard:    ${
      report.onboarding.completed
        ? `completed${report.onboarding.completedAt ? ` (${report.onboarding.completedAt})` : ""}`
        : `not completed (seen ${report.onboarding.seenCount}x)`
    }`,
  );
  if (report.onboarding.selectedProvider !== undefined) {
    lines.push(
      `  Provider:  ${report.onboarding.selectedProvider}${
        report.onboarding.selectedModel !== undefined
          ? ` (${report.onboarding.selectedModel})`
          : ""
      }`,
    );
  }
  lines.push(
    `  Daemon:    ${
      report.daemon.running
        ? `running (pid ${report.daemon.pid})`
        : "not running"
    }`,
  );
  const actLabel = (act: "identity" | "channel" | "autonomy"): string => {
    const record = report.acts[act];
    return record !== undefined ? `done (${record.completedAt})` : "not yet";
  };
  lines.push(`  Identity:  ${actLabel("identity")}`);
  lines.push(`  Channel:   ${actLabel("channel")}`);
  lines.push(`  Autonomy:  ${actLabel("autonomy")}`);
  lines.push("");
  const nextAct = report.acts.identity === undefined
    ? "agenc onboard identity"
    : report.acts.channel === undefined
      ? "agenc onboard channel"
      : report.acts.autonomy === undefined
        ? "agenc onboard autonomy"
        : null;
  lines.push(
    report.onboarding.completed
      ? nextAct !== null
        ? `  Next: ${nextAct}`
        : "  All acts complete — recap with: agenc onboard recap"
      : "  Start the wizard with: agenc onboard",
  );
  return lines.join("\n");
}

/**
 * Execute the non-launch onboard subcommands. The `launch` kind is handled by
 * bin/agenc.ts (it needs the default TUI route). Returns the process exit
 * code.
 */
export async function runAgenCOnboardCli(
  command: Exclude<AgenCOnboardCliCommand, { kind: "launch" }>,
  deps: OnboardCliDeps = {},
): Promise<number> {
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  switch (command.kind) {
    case "help":
      stdout(command.text);
      return 0;
    case "act": {
      const env = deps.env ?? process.env;
      const agencHome = resolveAgencHome(env);
      const io = deps.actIO ?? createTerminalActIO();
      try {
        switch (command.act) {
          case "identity":
            return await (deps.runIdentityActFn ?? runIdentityAct)({ agencHome, io, env });
          case "channel":
            return await (deps.runChannelActFn ?? runChannelAct)({ agencHome, io, env });
          case "autonomy":
            return await (deps.runAutonomyActFn ?? runAutonomyAct)({ agencHome, io, env });
          case "recap":
            return await (deps.runRecapFn ?? runRecap)({ agencHome, io, env });
        }
        return 1;
      } finally {
        io.close();
      }
    }
    case "error":
      stderr(`agenc: ${command.message}`);
      return 1;
    case "reset": {
      const env = deps.env ?? process.env;
      const agencHome = resolveAgencHome(env);
      resetFirstRunOnboarding({ agencHome });
      stdout(
        "Onboarding reset — the setup wizard will show on the next interactive start (or run: agenc onboard).",
      );
      return 0;
    }
    case "status": {
      const report = await buildOnboardStatusReport(deps);
      stdout(
        command.json
          ? JSON.stringify(report, null, 2)
          : formatOnboardStatusText(report),
      );
      return 0;
    }
  }
}
