/**
 * The one-time Windows choice before an interactive session.
 *
 * AgenC has no sandbox on Windows yet, so the default `workspace-write`
 * session cannot start there. Before the first interactive session the TUI
 * asks once: continue without a sandbox, or quit. Continuing saves
 * `sandbox_mode = "danger-full-access"` in the user's config.toml, the same
 * value `agenc config set` writes; approvals still apply, so the default mode
 * asks before each command and file edit. Quitting saves nothing, so the
 * card returns on the next launch.
 *
 * The card never replaces a sandbox mode someone chose (user config, profile,
 * repository, --config file): only the built-in default is filled in. A run
 * that cannot prompt keeps today's refusal.
 */
import { getConfigFilePath } from "../commands/config-context.js";
import {
  resolveAgencHome,
  resolveWorkspace as resolveWorkspaceFromEnv,
} from "../config/env.js";
import { assertConfigPatchAuthority } from "../config/layer-authority.js";
import type { AgenCConfig } from "../config/schema.js";
import { ConfigStore } from "../config/store.js";
import { mutateCanonicalUserConfigSync } from "../config/update-sync.js";
import {
  probeSandboxExecutionStatus,
  type SandboxExecutionStatus,
} from "../sandbox/execution-broker.js";
import { sandboxPolicyValueFromAgenCConfig } from "../session/configuration.js";
import { readProcessCwdSafely } from "./cli-cwd.js";
import {
  readStartupCliFlags,
  startupConfigLayerOptions,
  type StartupCliFlags,
} from "./startup-selection.js";

/** The value the card saves: no sandbox, approvals unchanged. */
const WINDOWS_NO_SANDBOX_MODE = "danger-full-access" as const;

export interface WindowsSandboxPromptOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

export type WindowsSandboxChoice =
  /** Not Windows, a sandbox is available, or a sandbox mode is already chosen. */
  | { readonly kind: "not_needed" }
  /** No terminal to ask in; startup continues and refuses as before. */
  | { readonly kind: "headless" }
  | { readonly kind: "continued"; readonly configPath: string }
  | { readonly kind: "quit" };

export interface WindowsSandboxChoiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly startupCliFlags?: StartupCliFlags;
  readonly cwd?: string;
  readonly useEnvWorkspace?: boolean;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** Injectable for tests; defaults to the real host. */
  readonly platform?: NodeJS.Platform;
  readonly probe?: typeof probeSandboxExecutionStatus;
  readonly renderPrompt?: (options: WindowsSandboxPromptOptions) => Promise<boolean>;
}

const NOT_NEEDED: WindowsSandboxChoice = Object.freeze({ kind: "not_needed" });

/** Printed when the user quits at the card. */
export const WINDOWS_SANDBOX_QUIT_MESSAGE =
  "agenc: not started. AgenC has no sandbox on Windows yet. Run agenc again to continue without one, or run AgenC in WSL2.\n";

async function loadWindowsSandboxPrompt(): Promise<
  (options: WindowsSandboxPromptOptions) => Promise<boolean>
> {
  // A literal keeps this lazy edge to the shipped prompt entry in the bundle.
  const mod = (await import("./tui-trust-prompt.js")) as {
    readonly renderWindowsSandboxPrompt: (
      options: WindowsSandboxPromptOptions,
    ) => Promise<boolean>;
  };
  return mod.renderWindowsSandboxPrompt;
}

type StartupSandboxSource =
  /** Only the built-in default picked the mode: nobody has answered yet. */
  | { readonly kind: "default"; readonly mode: AgenCConfig["sandbox_mode"] }
  /** A config layer, profile or flag picked it, or the config is unreadable. */
  | { readonly kind: "chosen_or_unknown" };

const CHOSEN_OR_UNKNOWN: StartupSandboxSource = Object.freeze({
  kind: "chosen_or_unknown",
});

async function startupSandboxSource(params: {
  readonly env: NodeJS.ProcessEnv;
  readonly agencHome: string;
  readonly workspace: string;
  readonly startupCliFlags: StartupCliFlags;
}): Promise<StartupSandboxSource> {
  let configStore: ConfigStore;
  try {
    configStore = new ConfigStore({
      home: params.agencHome,
      env: params.env,
      cwd: params.workspace,
      // The trust preflight and the session report config problems.
      onWarn: () => {},
      ...startupConfigLayerOptions({
        cli: params.startupCliFlags,
        cwd: params.workspace,
      }),
    });
    const config = await configStore.reload();
    const scope = configStore.provenance("sandbox_mode")?.scope ?? "default";
    return scope === "default"
      ? { kind: "default", mode: config.sandbox_mode }
      : CHOSEN_OR_UNKNOWN;
  } catch {
    // An unreadable config is reported by the normal startup path.
    return CHOSEN_OR_UNKNOWN;
  }
}

export async function runWindowsSandboxChoiceForTui(
  options: WindowsSandboxChoiceOptions = {},
): Promise<WindowsSandboxChoice> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return NOT_NEEDED;
  const env = options.env ?? process.env;
  const startupCliFlags =
    options.startupCliFlags ??
    readStartupCliFlags(options.argv ?? process.argv);
  // Both bypass flags already run without a sandbox on a host that has none.
  if (
    startupCliFlags.bypassApprovals === true ||
    startupCliFlags.dangerouslyBypassApprovalsAndSandbox === true
  ) {
    return NOT_NEEDED;
  }
  const agencHome = resolveAgencHome(env);
  // A resume can start from a folder that no longer exists; the AgenC home
  // still gives the config layers a place to start from.
  const workspace =
    (options.useEnvWorkspace === false ? undefined : resolveWorkspaceFromEnv(env)) ??
    options.cwd ??
    readProcessCwdSafely() ??
    agencHome;
  const source = await startupSandboxSource({
    env,
    agencHome,
    workspace,
    startupCliFlags,
  });
  if (source.kind !== "default") return NOT_NEEDED;
  const mode = sandboxPolicyValueFromAgenCConfig(source.mode);
  if (mode === "danger_full_access") return NOT_NEEDED;
  const probe = options.probe ?? probeSandboxExecutionStatus;
  const status: SandboxExecutionStatus = probe({
    mode,
    cwd: workspace,
    env,
    platform,
  });
  // A Windows sandbox, once AgenC has one, makes the card unnecessary.
  if (status.kind !== "unavailable") return NOT_NEEDED;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    return { kind: "headless" };
  }
  const renderPrompt =
    options.renderPrompt ?? (await loadWindowsSandboxPrompt());
  const accepted = await renderPrompt({
    stdin,
    stdout,
    ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
  });
  if (!accepted) return { kind: "quit" };
  const patch = { sandbox_mode: WINDOWS_NO_SANDBOX_MODE };
  const configPath = getConfigFilePath(agencHome);
  try {
    assertConfigPatchAuthority("user", patch);
    mutateCanonicalUserConfigSync(configPath, (raw) => {
      raw.sandbox_mode = patch.sandbox_mode;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not save sandbox_mode in ${configPath}: ${message}`, {
      cause: error,
    });
  }
  return { kind: "continued", configPath };
}

/**
 * Ask on Windows when needed; false means the TUI must not start (the user
 * quit, or asking or saving the answer failed).
 */
export async function requireWindowsSandboxChoiceForTui(
  options: WindowsSandboxChoiceOptions = {},
): Promise<boolean> {
  const stderr = options.stderr ?? process.stderr;
  let choice: WindowsSandboxChoice;
  try {
    choice = await runWindowsSandboxChoiceForTui(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`agenc: ${message}\n`);
    return false;
  }
  if (choice.kind === "quit") {
    stderr.write(WINDOWS_SANDBOX_QUIT_MESSAGE);
    return false;
  }
  return true;
}
