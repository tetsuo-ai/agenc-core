/** Canonical CLI project trust check, shared before daemon startup and invocation. */
import { ConfigStore } from "../config/store.js";
import {
  resolveAgencHome,
  resolveWorkspace as resolveWorkspaceFromEnv,
} from "../config/env.js";
import {
  readStartupCliFlags,
  resolveCanonicalStartupSelection,
  resolvedStartupProfileName,
  startupConfigLayerOptions,
  type StartupCliFlags,
} from "./startup-selection.js";
import { isProjectTrustedSync, trustProject } from "../permissions/trust/project-trust.js";
import { formatProjectTrustSources, summarizeProjectTrustSources } from "../permissions/trust/trust-sources.js";
import { setSessionTrustAccepted } from "../bootstrap/state.js";

async function loadProjectTrustPrompt(): Promise<
  (opts: {
    readonly workspaceRoot: string;
    readonly riskSources?: readonly string[];
    readonly bypassPermissionsRequested?: boolean;
    readonly stdin?: NodeJS.ReadStream;
    readonly stdout?: NodeJS.WriteStream;
    readonly stderr?: NodeJS.WriteStream;
  }) => Promise<boolean>
> {
  // A literal lets the bundler preserve this lazy entry edge when the preflight
  // moves into a shared chunk outside dist/bin.
  const mod = (await import("./tui-trust-prompt.js")) as {
    readonly renderProjectTrustPrompt: (opts: {
      readonly workspaceRoot: string;
      readonly riskSources?: readonly string[];
      readonly bypassPermissionsRequested?: boolean;
      readonly stdin?: NodeJS.ReadStream;
      readonly stdout?: NodeJS.WriteStream;
      readonly stderr?: NodeJS.WriteStream;
    }) => Promise<boolean>;
  };
  return mod.renderProjectTrustPrompt;
}

async function markLegacySessionTrustAccepted(): Promise<void> {
  setSessionTrustAccepted(true);
}

export interface ProjectTrustPreflightOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly startupCliFlags?: StartupCliFlags;
  readonly cwd?: string;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly useEnvWorkspace?: boolean;
  readonly allowPrompt?: boolean;
  readonly renderPrompt?: (opts: {
    readonly workspaceRoot: string;
    readonly riskSources?: readonly string[];
    readonly stdin?: NodeJS.ReadStream;
    readonly stdout?: NodeJS.WriteStream;
    readonly stderr?: NodeJS.WriteStream;
  }) => Promise<boolean>;
  readonly markSessionTrusted?: () => Promise<void>;
}

export interface ProjectTrustPreflightResult {
  readonly accepted: boolean;
  readonly projectRoot: string;
  readonly prompted: boolean;
}

export async function runProjectTrustPreflightForTui(
  options: ProjectTrustPreflightOptions = {},
): Promise<ProjectTrustPreflightResult> {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const agencHome = resolveAgencHome(env);
  const startupCliFlags =
    options.startupCliFlags ??
    readStartupCliFlags(options.argv ?? process.argv);
  const rawWorkspace =
    options.useEnvWorkspace === false
      ? (options.cwd ?? process.cwd())
      : (resolveWorkspaceFromEnv(env) ?? options.cwd ?? process.cwd());
  const configStore = new ConfigStore({
    home: agencHome,
    env,
    cwd: rawWorkspace,
    ...startupConfigLayerOptions({
      cli: startupCliFlags,
      cwd: rawWorkspace,
    }),
  });
  const config = await configStore.reload();
  const profileName = resolvedStartupProfileName(startupCliFlags, env);
  const startup = resolveCanonicalStartupSelection({
    config,
    ...(profileName !== undefined ? { profileName } : {}),
  });
  // ConfigStore's repository discovery is the sole project-root authority.
  // Re-running marker discovery after later layers would let configuration
  // come from one root while trust authorizes another.
  const projectRoot = configStore.projectRoot;
  if (
    isProjectTrustedSync({
      agencHome,
      env,
      projectRoot,
      projectRootMarkers: startup.config.project_root_markers,
    })
  ) {
    await (options.markSessionTrusted ?? markLegacySessionTrustAccepted)();
    return { accepted: true, projectRoot, prompted: false };
  }

  const canPrompt =
    options.allowPrompt !== false &&
    Boolean(stdin.isTTY) &&
    Boolean(stdout.isTTY);
  if (!canPrompt) {
    stderr.write(`agenc: project is not trusted: ${projectRoot}\n`);
    return { accepted: false, projectRoot, prompted: false };
  }

  const riskSources = formatProjectTrustSources(
    await summarizeProjectTrustSources({
      cwd: projectRoot,
      configStore,
    }),
  );
  const renderProjectTrustPrompt =
    options.renderPrompt ?? (await loadProjectTrustPrompt());
  const accepted = await renderProjectTrustPrompt({
    workspaceRoot: projectRoot,
    riskSources,
    bypassPermissionsRequested:
      startupCliFlags.dangerouslyBypassApprovalsAndSandbox === true ||
      startupCliFlags.permissionMode === "bypassPermissions",
    stdin,
    stdout,
    stderr,
  });
  if (!accepted) {
    return { accepted: false, projectRoot, prompted: true };
  }
  await trustProject({
    agencHome,
    env,
    projectRoot,
  });
  await (options.markSessionTrusted ?? markLegacySessionTrustAccepted)();
  return { accepted: true, projectRoot, prompted: true };
}

export async function requireProjectTrustForTui(
  options: ProjectTrustPreflightOptions = {},
): Promise<boolean> {
  return (await runProjectTrustPreflightForTui(options)).accepted;
}

