/**
 * Type definitions for system tools.
 *
 * @module
 */

import type { Logger } from "../../utils/logger.js";

// ============================================================================
// Bash tool types
// ============================================================================

/**
 * Configuration for the bash tool.
 */
export interface BashToolConfig {
  /** Working directory (default: process.cwd()) */
  readonly cwd?: string;
  /** Command timeout in ms (default: 30_000) */
  readonly timeoutMs?: number;
  /** Maximum timeout the LLM can request per-call in ms. Caps per-call timeoutMs overrides. */
  readonly maxTimeoutMs?: number;
  /** Allowed command prefixes (empty = allow all) */
  readonly allowList?: readonly string[];
  /** Blocked command prefixes (merged with DEFAULT_DENY_LIST) */
  readonly denyList?: readonly string[];
  /** Commands to remove from the deny list (overrides DEFAULT_DENY_LIST entries) */
  readonly denyExclusions?: readonly string[];
  /** Max output size in bytes (default: 100_000) */
  readonly maxOutputBytes?: number;
  /** Environment variables to pass to spawned process (default: minimal — PATH only) */
  readonly env?: Record<string, string>;
  /** Logger for execution events and security denials */
  readonly logger?: Logger;
  /** Lock working directory — reject per-call cwd overrides from LLM (default: false) */
  readonly lockCwd?: boolean;
  /** Disable all deny lists (default + config). Use for trusted daemon environments. (default: false) */
  readonly unrestricted?: boolean;
  /** Enable shell mode when args is omitted (default: true). Set false to require command+args only. */
  readonly shellMode?: boolean;
}

/**
 * Configuration for durable host-managed process tools.
 */
export interface SystemProcessToolConfig {
  /** Durable registry/log root directory. */
  readonly rootDir?: string;
  /** Default working directory. */
  readonly cwd?: string;
  /** Lock working directory — reject per-call cwd overrides. */
  readonly lockCwd?: boolean;
  /** Environment variables exposed to managed processes. */
  readonly env?: Record<string, string>;
  /** Allowed executable names/paths (empty = allow all except deny rules). */
  readonly allowList?: readonly string[];
  /** Blocked executable names/paths. */
  readonly denyList?: readonly string[];
  /** Executables removed from the deny set. */
  readonly denyExclusions?: readonly string[];
  /** Disable allow/deny enforcement for trusted environments. */
  readonly unrestricted?: boolean;
  /** Default recent-log bytes returned by status/logs. */
  readonly defaultLogTailBytes?: number;
  /** Maximum recent-log bytes allowed per call. */
  readonly maxLogTailBytes?: number;
  /** Default bounded settle window when waiting for fresh output from fast jobs. */
  readonly defaultLogSettleMs?: number;
  /** Maximum settle window allowed per call when waiting for fresh output. */
  readonly maxLogSettleMs?: number;
  /** Default graceful stop wait window in milliseconds. */
  readonly defaultStopWaitMs?: number;
  /** Logger for lifecycle and failure events. */
  readonly logger?: Logger;
  /** Time source override used by tests. */
  readonly now?: () => number;
  /** Optional lifecycle callback for terminal state transitions. */
  readonly onLifecycleEvent?: (event: SystemProcessLifecycleEvent) => void | Promise<void>;
}

export interface SystemProcessLifecycleEvent {
  /** Durable handle identifier. */
  readonly processId: string;
  /** Optional stable label assigned at start time. */
  readonly label?: string;
  /** Optional idempotency key assigned at start time. */
  readonly idempotencyKey?: string;
  /** Terminal lifecycle state. */
  readonly state: "exited" | "failed";
  /** Best-effort exit code. */
  readonly exitCode?: number | null;
  /** Best-effort terminating signal. */
  readonly signal?: string | null;
  /** Timestamp when the transition was observed. */
  readonly occurredAt: number;
  /** Runtime path that observed the transition. */
  readonly cause: "child_exit" | "child_error" | "stop";
}

/**
 * Configuration for durable host-managed server tools.
 */
export interface SystemServerToolConfig extends SystemProcessToolConfig {
  /** Durable registry root for structured server handles. */
  readonly rootDir?: string;
  /** Default readiness timeout in milliseconds. */
  readonly defaultReadinessTimeoutMs?: number;
  /** Health probe request timeout in milliseconds. */
  readonly healthTimeoutMs?: number;
  /** Optional external allowlist for non-loopback health URLs. */
  readonly allowedDomains?: readonly string[];
  /** Optional external blocklist for non-loopback health URLs. */
  readonly blockedDomains?: readonly string[];
}

/**
 * Configuration for durable remote MCP job handle tools.
 */
export interface SystemRemoteJobToolConfig {
  /** Durable registry root for remote job handles. */
  readonly rootDir?: string;
  /** Optional externally reachable callback base URL. */
  readonly callbackBaseUrl?: string;
  /** Polling timeout in milliseconds for remote status/cancel HTTP calls. */
  readonly defaultPollTimeoutMs?: number;
  /** Optional external allowlist for remote polling/cancel URLs. */
  readonly allowedDomains?: readonly string[];
  /** Optional external blocklist for remote polling/cancel URLs. */
  readonly blockedDomains?: readonly string[];
  /** Logger for lifecycle and failure events. */
  readonly logger?: Logger;
  /** Time source override used by tests. */
  readonly now?: () => number;
}

/**
 * Configuration for durable remote session handle tools.
 */
export interface SystemRemoteSessionToolConfig {
  /** Durable registry root for remote session handles. */
  readonly rootDir?: string;
  /** Optional externally reachable callback base URL. */
  readonly callbackBaseUrl?: string;
  /** Polling timeout in milliseconds for remote status/send/stop HTTP calls. */
  readonly defaultPollTimeoutMs?: number;
  /** Optional external allowlist for remote polling/message/stop URLs. */
  readonly allowedDomains?: readonly string[];
  /** Optional external blocklist for remote polling/message/stop URLs. */
  readonly blockedDomains?: readonly string[];
  /** Logger for lifecycle and failure events. */
  readonly logger?: Logger;
  /** Time source override used by tests. */
  readonly now?: () => number;
}

/**
 * Configuration for durable research handle tools.
 */
export interface SystemResearchToolConfig {
  /** Durable registry root for research handles. */
  readonly rootDir?: string;
  /** Logger for lifecycle and failure events. */
  readonly logger?: Logger;
  /** Time source override used by tests. */
  readonly now?: () => number;
}

export type SystemSandboxWorkspaceAccessMode = "none" | "readonly" | "readwrite";

/**
 * Configuration for durable code sandbox handle tools.
 */
export interface SystemSandboxToolConfig {
  /** Durable registry root for sandbox handles. */
  readonly rootDir?: string;
  /** Default Docker image for sandbox environments. */
  readonly defaultImage?: string;
  /** Optional allowlist of Docker images permitted for sandbox creation. */
  readonly allowedImages?: readonly string[];
  /** Host workspace path mounted into sandboxes when access is enabled. */
  readonly workspacePath?: string;
  /** Default workspace mount mode. */
  readonly defaultWorkspaceAccess?: SystemSandboxWorkspaceAccessMode;
  /** Default network policy for sandboxes. */
  readonly defaultNetworkAccess?: boolean;
  /** Default graceful-stop wait window for sandbox jobs. */
  readonly defaultStopWaitMs?: number;
  /** Default recent-log bytes returned by sandbox job status/log calls. */
  readonly defaultLogTailBytes?: number;
  /** Maximum recent-log bytes allowed per sandbox job status/log call. */
  readonly maxLogTailBytes?: number;
  /** Default bounded settle window when sandbox job log inspection should wait for fresh output. */
  readonly defaultLogSettleMs?: number;
  /** Maximum settle window allowed per sandbox job status/log call. */
  readonly maxLogSettleMs?: number;
  /** Docker daemon command timeout in milliseconds. */
  readonly dockerTimeoutMs?: number;
  /** Logger for lifecycle and failure events. */
  readonly logger?: Logger;
  /** Time source override used by tests. */
  readonly now?: () => number;
}

/**
 * Configuration for typed SQLite inspection/query tools.
 */
export interface SystemSqliteToolConfig {
  /** Allowed SQLite database path prefixes (required). */
  readonly allowedPaths: readonly string[];
  /** Maximum SQL text length accepted per query. */
  readonly maxSqlChars?: number;
  /** Default maximum rows returned from a query. */
  readonly defaultMaxRows?: number;
  /** Hard ceiling for maxRows overrides. */
  readonly maxRowsCap?: number;
  /** Maximum string/binary cell preview length. */
  readonly maxCellChars?: number;
  /** Logger for query execution and denials. */
  readonly logger?: Logger;
}

/**
 * Configuration for typed PDF inspection/extraction tools.
 */
export interface SystemPdfToolConfig {
  /** Allowed PDF path prefixes (required). */
  readonly allowedPaths: readonly string[];
  /** Default subprocess timeout for pdfinfo/pdftotext. */
  readonly timeoutMs?: number;
  /** Maximum extracted text characters returned by default. */
  readonly defaultMaxChars?: number;
  /** Hard ceiling for maxChars overrides. */
  readonly maxCharsCap?: number;
  /** Logger for extraction and validation failures. */
  readonly logger?: Logger;
}

/**
 * Configuration for typed spreadsheet inspection/extraction tools.
 */
export interface SystemSpreadsheetToolConfig {
  /** Allowed spreadsheet path prefixes (required). */
  readonly allowedPaths: readonly string[];
  /** Default subprocess timeout for spreadsheet parsing helpers. */
  readonly timeoutMs?: number;
  /** Default maximum rows returned from a spreadsheet read. */
  readonly defaultMaxRows?: number;
  /** Hard ceiling for maxRows overrides. */
  readonly maxRowsCap?: number;
  /** Maximum string cell preview length. */
  readonly maxCellChars?: number;
  /** Number of sample rows returned by spreadsheetInfo. */
  readonly infoSampleRows?: number;
  /** Logger for extraction and validation failures. */
  readonly logger?: Logger;
}

/**
 * Configuration for typed office-document inspection/extraction tools.
 */
export interface SystemOfficeDocumentToolConfig {
  /** Allowed document path prefixes (required). */
  readonly allowedPaths: readonly string[];
  /** Default subprocess timeout for parsing/conversion helpers. */
  readonly timeoutMs?: number;
  /** Maximum extracted text characters returned by default. */
  readonly defaultMaxChars?: number;
  /** Hard ceiling for maxChars overrides. */
  readonly maxCharsCap?: number;
  /** Logger for extraction and validation failures. */
  readonly logger?: Logger;
}

/**
 * Configuration for typed email-message inspection/extraction tools.
 */
export interface SystemEmailMessageToolConfig {
  /** Allowed email message path prefixes (required). */
  readonly allowedPaths: readonly string[];
  /** Default subprocess timeout for parsing helpers. */
  readonly timeoutMs?: number;
  /** Maximum extracted text characters returned by default. */
  readonly defaultMaxChars?: number;
  /** Hard ceiling for maxChars overrides. */
  readonly maxCharsCap?: number;
  /** Logger for extraction and validation failures. */
  readonly logger?: Logger;
}

/**
 * Configuration for typed calendar inspection/extraction tools.
 */
export interface SystemCalendarToolConfig {
  /** Allowed calendar path prefixes (required). */
  readonly allowedPaths: readonly string[];
  /** Default maximum events returned by calendarRead. */
  readonly defaultMaxEvents?: number;
  /** Hard ceiling for maxEvents overrides. */
  readonly maxEventsCap?: number;
  /** Logger for extraction and validation failures. */
  readonly logger?: Logger;
}

// ============================================================================
// Shell mode safety types
// ============================================================================

/**
 * A pattern that blocks dangerous shell commands in shell mode.
 */
export interface DangerousShellPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly message: string;
}

/**
 * Dangerous shell patterns checked in shell mode.
 * These catch dangerous operations regardless of how they're expressed
 * (pipes, subshells, aliases, etc.).
 */
export const DANGEROUS_SHELL_PATTERNS: readonly DangerousShellPattern[] = [
  {
    name: "privilege_escalation",
    pattern: /\b(?:sudo|su|doas)\b/,
    message: "Privilege escalation commands (sudo/su/doas) are blocked",
  },
  {
    name: "root_filesystem_destruction",
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?(\/\s*$|\/\*|~\/)/,
    message: "Recursive deletion of root or home directory is blocked",
  },
  {
    name: "reverse_shell",
    pattern: /(?:\bnc\b.*-[a-zA-Z]*e|\/dev\/tcp\/|\bsocat\b.*\bexec\b)/,
    message: "Reverse shell patterns are blocked",
  },
  {
    name: "download_and_execute",
    pattern: /(?:curl|wget)\b[^|]*\|\s*(?:ba)?sh\b/,
    message: "Download-and-execute (pipe to shell) is blocked",
  },
  {
    name: "system_commands",
    pattern: /\b(?:shutdown|reboot|halt|poweroff|mkfs)\b/,
    message: "Destructive system commands are blocked",
  },
  {
    name: "raw_device_access",
    pattern: /\bdd\b[^|]*\bof=\/dev\//,
    message: "Raw device writes via dd are blocked",
  },
  {
    name: "fork_bomb",
    pattern: /:\(\)\s*\{.*\|.*&\s*\}\s*;?\s*:/,
    message: "Fork bomb patterns are blocked",
  },
];

/**
 * Input schema for a bash tool invocation.
 */
export interface BashToolInput {
  /** Executable name (e.g. "ls", "git", "node") */
  readonly command: string;
  /** Arguments array passed to execFile */
  readonly args?: readonly string[];
  /** Per-call working directory override */
  readonly cwd?: string;
  /** Per-call timeout override in ms */
  readonly timeoutMs?: number;
}

/**
 * Result of a bash tool execution.
 */
export interface BashExecutionResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly truncated: boolean;
}

/**
 * Default deny list of commands that grant capabilities BEYOND what the
 * daemon-running user already has. The agent already has full read/write
 * access to the user's files via `system.writeFile` and `system.readFile`,
 * so denying ordinary developer tools (rm, chmod, python, node, curl,
 * tee, awk, etc.) is security theater: the agent could trash files just
 * as easily by writing garbage with `system.writeFile`. The only useful
 * denials are commands that escalate privilege or damage the system in
 * ways file I/O cannot.
 *
 * Merged with any user-provided deny list. Users can still narrow
 * further via `denyList` config; users can opt out of individual entries
 * via `denyExclusions`.
 */
export const DEFAULT_DENY_LIST: readonly string[] = [
  // Privilege escalation — these would let the agent escape its UID.
  "sudo",
  "su",
  "doas",
  // Raw block-device write / filesystem create — these can corrupt
  // disks beyond what file I/O can do, and on most systems require
  // root anyway, but block them at the source as defense in depth.
  "dd",
  "mkfs",
  // Filesystem mount manipulation — can mask or expose sensitive
  // mounts; usually requires root, blocked defensively.
  "mount",
  "umount",
  // System halt — irreversible and disruptive; usually requires root,
  // blocked defensively.
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  // Reverse shell vectors — these tools exist almost exclusively for
  // creating outbound shell connections to attacker-controlled hosts.
  // Plain network access (curl/wget/ssh) is allowed; only the
  // reverse-shell-specific tools stay denied.
  "nc",
  "netcat",
  "ncat",
  "socat",
];

/**
 * Deny list prefixes for version-specific binaries of the denied
 * commands above. Currently empty — the previous prefix list blocked
 * `python`, `node`, `ruby`, `perl`, `php`, `lua`, `pypy` along with
 * every version-specific binary, which prevented the agent from
 * running its own scripts. Script interpreters are now allowed; the
 * agent needs them to actually test the code it writes.
 */
export const DEFAULT_DENY_PREFIXES: readonly string[] = [];

// Default direct bash timeout. Daemon desktop mode lifts this ceiling via
// resolveBashToolTimeoutConfig(), but the standalone tool stays short by default.
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100_000;
