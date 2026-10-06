/** Canonical CLI project trust check, shared before daemon startup and invocation. */
import { homedir } from "node:os";
import { parse as parsePath } from "node:path";

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
import {
  canonicalizeProjectTrustPathSync,
  projectConfigDigestSync,
  resolveProjectTrustKindSync,
  trustProject,
  trustProjectAutomatically,
} from "../permissions/trust/project-trust.js";
import {
  projectTrustReviewIsEmpty,
  reviewProjectTrust,
  summarizeProjectTrustReview,
  type ProjectTrustReview,
} from "../permissions/trust/trust-sources.js";
import type { TrustLocation } from "../permissions/trust/TrustDialog.js";
import { setSessionTrustAccepted } from "../bootstrap/state.js";

export interface ProjectTrustPromptOptions {
  readonly workspaceRoot: string;
  readonly review?: ProjectTrustReview;
  readonly location?: TrustLocation;
  readonly bypassPermissionsRequested?: boolean;
  readonly bypassSandboxRequested?: boolean;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

async function loadProjectTrustPrompt(): Promise<
  (opts: ProjectTrustPromptOptions) => Promise<boolean>
> {
  // A literal lets the bundler preserve this lazy entry edge when the preflight
  // moves into a shared chunk outside dist/bin.
  const mod = (await import("./tui-trust-prompt.js")) as {
    readonly renderProjectTrustPrompt: (
      opts: ProjectTrustPromptOptions,
    ) => Promise<boolean>;
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
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly onWarn?: (message: string) => void;
  readonly useEnvWorkspace?: boolean;
  readonly allowPrompt?: boolean;
  readonly renderPrompt?: (opts: ProjectTrustPromptOptions) => Promise<boolean>;
  readonly markSessionTrusted?: () => Promise<void>;
}

export interface ProjectTrustPreflightResult {
  readonly accepted: boolean;
  readonly projectRoot: string;
  readonly prompted: boolean;
  /**
   * Set when the root was trusted without a prompt because trust had nothing
   * to turn on there (see `trustProjectAutomatically`).
   */
  readonly automatic?: true;
}

/**
 * Folders where a trust grant is never automatic: the home folder and a
 * filesystem root hold far more than one project, so the user confirms them.
 */
function sensitiveTrustLocation(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): TrustLocation | undefined {
  const root = canonicalizeProjectTrustPathSync(projectRoot);
  if (parsePath(root).root === root) return "root";
  const home = env.HOME || env.USERPROFILE || homedir();
  if (home && canonicalizeProjectTrustPathSync(home) === root) return "home";
  return undefined;
}

function headlessRefusalDetail(
  review: ProjectTrustReview,
  location: TrustLocation | undefined,
): string {
  if (!projectTrustReviewIsEmpty(review)) {
    return `agenc: trusting it turns on ${summarizeProjectTrustReview(review)}; run agenc there in a terminal to review them\n`;
  }
  if (location === "home") {
    return "agenc: it is your home folder; run agenc there in a terminal to confirm\n";
  }
  if (location === "root") {
    return "agenc: it is the root of the disk; run agenc there in a terminal to confirm\n";
  }
  return "";
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
  // This preflight historically leaves constructor warnings silent, while
  // reload warnings use console.warn. Preserve that timing with a scoped sink.
  let constructed = false;
  const configStore = new ConfigStore({
    home: agencHome,
    env,
    cwd: rawWorkspace,
    ...(options.onWarn !== undefined ? { onWarn: (message: string) => {
      if (constructed) options.onWarn!(message);
    } } : {}),
    ...startupConfigLayerOptions({
      cli: startupCliFlags,
      cwd: rawWorkspace,
    }),
  });
  constructed = true;
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
  const trustLookup = {
    agencHome,
    env,
    projectRoot,
    projectRootMarkers: startup.config.project_root_markers,
  };
  const trustKind = resolveProjectTrustKindSync(trustLookup);
  const bypassSandboxRequested =
    startupCliFlags.dangerouslyBypassApprovalsAndSandbox === true;
  const bypassPermissionsRequested =
    bypassSandboxRequested ||
    startupCliFlags.permissionMode === "bypassPermissions";
  const markSessionTrusted =
    options.markSessionTrusted ?? markLegacySessionTrustAccepted;
  if (trustKind === "explicit") {
    await markSessionTrusted();
    return { accepted: true, projectRoot, prompted: false };
  }

  // Not explicitly trusted. Trust is granted without a prompt only when it
  // has nothing to turn on: no repository settings that need it, none of the
  // user's own hooks, not a home folder or disk root, and no bypass request.
  // The fingerprint brackets the review so a config file that changes while
  // it runs can never be recorded as reviewed.
  const digestBefore = projectConfigDigestSync(projectRoot);
  const review = await reviewProjectTrust({
    projectRoot,
    config: configStore.current(),
  });
  const digestAfter = projectConfigDigestSync(projectRoot);
  const location = sensitiveTrustLocation(projectRoot, env);
  const automaticGrant =
    digestBefore !== null &&
    digestBefore === digestAfter &&
    projectTrustReviewIsEmpty(review) &&
    location === undefined &&
    !bypassPermissionsRequested;
  if (automaticGrant) {
    if (trustKind === "none") {
      await trustProjectAutomatically({
        agencHome,
        env,
        projectRoot,
        configDigest: digestBefore,
      });
    }
    await markSessionTrusted();
    return {
      accepted: true,
      projectRoot,
      prompted: false,
      ...(trustKind === "none" ? { automatic: true as const } : {}),
    };
  }

  const canPrompt =
    options.allowPrompt !== false &&
    Boolean(stdin.isTTY) &&
    Boolean(stdout.isTTY);
  if (!canPrompt) {
    stderr.write(`agenc: project is not trusted: ${projectRoot}\n`);
    const detail = headlessRefusalDetail(review, location);
    if (detail.length > 0) stderr.write(detail);
    return { accepted: false, projectRoot, prompted: false };
  }

  const renderProjectTrustPrompt =
    options.renderPrompt ?? (await loadProjectTrustPrompt());
  const accepted = await renderProjectTrustPrompt({
    workspaceRoot: projectRoot,
    review,
    ...(location !== undefined ? { location } : {}),
    bypassPermissionsRequested,
    bypassSandboxRequested,
    stdin,
    stdout,
    stderr: stderr as NodeJS.WriteStream,
  });
  if (!accepted) {
    return { accepted: false, projectRoot, prompted: true };
  }
  await trustProject({
    agencHome,
    env,
    projectRoot,
  });
  await markSessionTrusted();
  return { accepted: true, projectRoot, prompted: true };
}

export async function requireProjectTrustForTui(
  options: ProjectTrustPreflightOptions = {},
): Promise<boolean> {
  return (await runProjectTrustPreflightForTui(options)).accepted;
}

