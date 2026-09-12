import { probeSandboxExecutionStatus } from "../sandbox/execution-broker.js";
import type { SandboxExecutionStatus } from "../sandbox/execution-broker.js";
import { BYPASS_APPROVALS_FLAG, DANGEROUS_BYPASS_FLAG } from "./startup-flags.js";
import type { StartupCliFlags } from "./startup-selection.js";

/**
 * How `--bypass-approvals` resolves on this host.
 *
 * The flag skips approval prompts (permission mode `bypassPermissions`) and
 * keeps the OS sandbox: Seatbelt on macOS, bubblewrap or Landlock on Linux.
 * On a host that cannot sandbox at all (Windows, a Linux box without user
 * namespaces or Landlock, a broken sandbox-exec) the configured
 * `workspace-write` policy would fail closed on the first tool call, which is
 * useless for an unattended run. The flag therefore degrades to full access
 * there, once, with a stderr notice naming the reason. Callers that want "no
 * sandbox anywhere" keep using `--dangerously-bypass-approvals-and-sandbox`.
 */
export interface StartupSandboxBypass {
  /** Value for `AgentRuntimeOptions.dangerouslyBypassApprovalsAndSandbox`. */
  readonly dangerouslyBypassApprovalsAndSandbox: boolean;
  /** One operator-facing line to write to stderr, when the sandbox was dropped. */
  readonly notice?: string;
}

export interface StartupSandboxBypassOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Injectable probe for tests; defaults to the real platform probe. */
  readonly probe?: (options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
  }) => SandboxExecutionStatus;
}

function defaultProbe(options: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): SandboxExecutionStatus {
  // `workspace_write` is the most demanding configured mode; if the host can
  // run it, it can run `read_only` too, and `danger-full-access` never probes.
  return probeSandboxExecutionStatus({ mode: "workspace_write", ...options });
}

export function sandboxUnavailableNotice(status: SandboxExecutionStatus): string {
  const reason = status.reason ?? "the platform sandbox is unavailable";
  return (
    `agenc: ${BYPASS_APPROVALS_FLAG}: the OS sandbox is unavailable on this host (${reason}); ` +
    `tools run without kernel confinement for this session. ` +
    `Run \`agenc doctor\` to repair the sandbox, or pass ${DANGEROUS_BYPASS_FLAG} to make the unsandboxed run explicit.`
  );
}

/**
 * Resolve the runtime sandbox flag for this startup from the parsed CLI flags.
 *
 * - `--dangerously-bypass-approvals-and-sandbox`: full access, no probe.
 * - `--bypass-approvals`: probe the host; keep the sandbox when it is ready
 *   (or not required), drop it with a notice when it is unavailable.
 * - neither: the configured sandbox policy applies unchanged.
 */
export function resolveStartupSandboxBypass(
  flags: Pick<StartupCliFlags, "bypassApprovals" | "dangerouslyBypassApprovalsAndSandbox">,
  options: StartupSandboxBypassOptions,
): StartupSandboxBypass {
  if (flags.dangerouslyBypassApprovalsAndSandbox === true) {
    return { dangerouslyBypassApprovalsAndSandbox: true };
  }
  if (flags.bypassApprovals !== true) {
    return { dangerouslyBypassApprovalsAndSandbox: false };
  }
  const probe = options.probe ?? defaultProbe;
  const status = probe({
    cwd: options.cwd,
    env: options.env,
    platform: options.platform ?? process.platform,
  });
  if (status.kind === "unavailable") {
    return {
      dangerouslyBypassApprovalsAndSandbox: true,
      notice: sandboxUnavailableNotice(status),
    };
  }
  return { dangerouslyBypassApprovalsAndSandbox: false };
}

/** Write the notice, if any, exactly once per process. */
let noticeWritten = false;
export function writeStartupSandboxBypassNotice(
  resolution: StartupSandboxBypass,
  stderr: { write(chunk: string): unknown } = process.stderr,
): void {
  if (resolution.notice === undefined || noticeWritten) return;
  noticeWritten = true;
  stderr.write(`${resolution.notice}\n`);
}

/** Test-only reset for the once-per-process notice latch. */
export function resetStartupSandboxBypassNoticeForTests(): void {
  noticeWritten = false;
}
