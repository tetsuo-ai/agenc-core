/**
 * `agenc security audit [--json] [--fix]` — local exposure and blast-radius
 * audit with safe autofixes (TODO task 3, Phase 0).
 *
 * Fail-closed philosophy: the command exits 1 while any critical finding
 * remains (after `--fix` when requested), so scripts and provisioning can
 * gate on it. `--fix` applies only reversible, owner-scoped filesystem
 * permission fixes; it never edits config or environment.
 *
 * v1 checks:
 *   daemon-ws-exposure       non-loopback daemon WebSocket overrides (env)
 *   home-dir-perms           $AGENC_HOME group/world access        [fixable]
 *   sensitive-file-perms     auth.json/daemon.cookie/config/vaults [fixable]
 *   config-integrity         config.toml unparseable (falls back to defaults)
 *   default-permission-mode  configured approval-bypass default    (warn)
 *
 * The check registry is deliberately extensible: channel DM policies
 * (task 6), webhook token posture (task 17), and skill/plugin provenance
 * (task 26) land here as those surfaces ship.
 */
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveAgencHome } from "../config/env.js";
import { loadConfig } from "../config/loader.js";

export type SecuritySeverity = "ok" | "warn" | "critical";

export interface SecurityFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: SecuritySeverity;
  readonly detail: string;
  readonly remediation?: string;
  readonly fixable: boolean;
  /** Present only when --fix ran and this finding was fixable. */
  readonly fixed?: boolean;
}

export interface SecurityAuditContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly agencHome: string;
  readonly configExists: boolean;
  readonly configParseError?: string;
  readonly defaultPermissionMode?: string;
  readonly applyFixes: boolean;
}

type SecurityCheck = (ctx: SecurityAuditContext) => SecurityFinding[];

const GROUP_WORLD_BITS = 0o077;

function modeOf(path: string): { mode: number; isDirectory: boolean } | null {
  try {
    const stat = statSync(path);
    return { mode: stat.mode & 0o777, isDirectory: stat.isDirectory() };
  } catch {
    return null;
  }
}

function isLoopbackHostValue(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

const checkDaemonWsExposure: SecurityCheck = (ctx) => {
  const allow = ctx.env.AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK?.trim()
    .toLowerCase();
  const host = ctx.env.AGENC_DAEMON_WEBSOCKET_HOST?.trim();
  if (allow === "1" || allow === "true") {
    return [
      {
        id: "daemon-ws-exposure",
        title: "Daemon WebSocket non-loopback override is enabled",
        severity: "critical",
        detail:
          "AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK is set: the daemon may accept WebSocket connections from other hosts. Exposed agent daemons are the single most exploited misconfiguration in this product category.",
        remediation:
          "Unset AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK; for remote access prefer a tailnet or SSH tunnel to a loopback bind.",
        fixable: false,
      },
    ];
  }
  if (host !== undefined && host.length > 0 && !isLoopbackHostValue(host)) {
    return [
      {
        id: "daemon-ws-exposure",
        title: "Daemon WebSocket host is not loopback",
        severity: "critical",
        detail: `AGENC_DAEMON_WEBSOCKET_HOST=${host} requests a non-loopback bind. The daemon refuses it without the explicit override, but the environment expresses exposure intent.`,
        remediation:
          "Unset AGENC_DAEMON_WEBSOCKET_HOST or point it at 127.0.0.1/::1.",
        fixable: false,
      },
    ];
  }
  return [
    {
      id: "daemon-ws-exposure",
      title: "Daemon WebSocket bound to loopback",
      severity: "ok",
      detail: "No non-loopback override is set; remote origins are rejected.",
      fixable: false,
    },
  ];
};

const checkHomeDirPerms: SecurityCheck = (ctx) => {
  const stat = modeOf(ctx.agencHome);
  if (stat === null) {
    return [
      {
        id: "home-dir-perms",
        title: "AgenC home does not exist yet",
        severity: "ok",
        detail: `${ctx.agencHome} is absent — it is created owner-only (0700) on first use.`,
        fixable: false,
      },
    ];
  }
  if ((stat.mode & GROUP_WORLD_BITS) === 0) {
    return [
      {
        id: "home-dir-perms",
        title: "AgenC home permissions are owner-only",
        severity: "ok",
        detail: `${ctx.agencHome} mode ${stat.mode.toString(8)}`,
        fixable: false,
      },
    ];
  }
  let fixed = false;
  if (ctx.applyFixes) {
    try {
      chmodSync(ctx.agencHome, 0o700);
      fixed = true;
    } catch {
      fixed = false;
    }
  }
  return [
    {
      id: "home-dir-perms",
      title: "AgenC home is group/world accessible",
      severity: "critical",
      detail: `${ctx.agencHome} mode ${stat.mode.toString(8)} grants access beyond the owner. Auth tokens, the daemon cookie, and session transcripts live here.`,
      remediation: `chmod 700 ${ctx.agencHome}`,
      fixable: true,
      ...(ctx.applyFixes ? { fixed } : {}),
    },
  ];
};

const KNOWN_SENSITIVE_ENTRIES = [
  "auth.json",
  "daemon.cookie",
  "config.toml",
  "onboarding.json",
  "trusted-projects.json",
  "credentials",
];

const checkSensitiveFilePerms: SecurityCheck = (ctx) => {
  const candidates = new Set(KNOWN_SENSITIVE_ENTRIES);
  try {
    for (const entry of readdirSync(ctx.agencHome)) {
      if (entry.endsWith(".vault.json")) candidates.add(entry);
    }
  } catch {
    // Absent home is already reported by home-dir-perms.
  }
  const findings: SecurityFinding[] = [];
  for (const name of [...candidates].sort()) {
    const path = join(ctx.agencHome, name);
    const stat = modeOf(path);
    if (stat === null) continue;
    if ((stat.mode & GROUP_WORLD_BITS) === 0) continue;
    let fixed = false;
    if (ctx.applyFixes) {
      try {
        chmodSync(path, stat.isDirectory ? 0o700 : 0o600);
        fixed = true;
      } catch {
        fixed = false;
      }
    }
    findings.push({
      id: `sensitive-file-perms:${name}`,
      title: `${name} is group/world accessible`,
      severity: "critical",
      detail: `${path} mode ${stat.mode.toString(8)}`,
      remediation: `chmod ${stat.isDirectory ? 700 : 600} ${path}`,
      fixable: true,
      ...(ctx.applyFixes ? { fixed } : {}),
    });
  }
  if (findings.length === 0) {
    findings.push({
      id: "sensitive-file-perms",
      title: "Sensitive files are owner-only",
      severity: "ok",
      detail:
        "auth.json, daemon.cookie, config.toml, trusted-projects.json, vaults: no group/world bits.",
      fixable: false,
    });
  }
  return findings;
};

const checkConfigIntegrity: SecurityCheck = (ctx) => {
  if (ctx.configParseError !== undefined) {
    return [
      {
        id: "config-integrity",
        title: "config.toml is unparseable",
        severity: "warn",
        detail: `The runtime silently falls back to defaults, which can mask a hardened configuration you believe is active: ${ctx.configParseError}`,
        remediation: "Fix or regenerate config.toml (agenc config validate).",
        fixable: false,
      },
    ];
  }
  return [
    {
      id: "config-integrity",
      title: ctx.configExists ? "config.toml parses cleanly" : "No config.toml (defaults active)",
      severity: "ok",
      detail: ctx.configExists
        ? "Configured values are what the runtime actually uses."
        : "Built-in defaults are in effect.",
      fixable: false,
    },
  ];
};

const checkDefaultPermissionMode: SecurityCheck = (ctx) => {
  const mode = ctx.defaultPermissionMode;
  if (mode === "bypassPermissions" || mode === "dontAsk") {
    return [
      {
        id: "default-permission-mode",
        title: `Configured default permission mode is ${mode}`,
        severity: "warn",
        detail:
          "Every session starts with tool approvals bypassed. Combined with untrusted inputs (web content, task text) this is the largest configured blast radius on this machine.",
        remediation:
          "Remove permissions.default_mode from config.toml and opt in per session (--yolo) instead.",
        fixable: false,
      },
    ];
  }
  return [
    {
      id: "default-permission-mode",
      title: `Default permission mode: ${mode ?? "default"}`,
      severity: "ok",
      detail: "Sessions start with approval prompts enabled.",
      fixable: false,
    },
  ];
};

export const SECURITY_CHECKS: readonly SecurityCheck[] = [
  checkDaemonWsExposure,
  checkHomeDirPerms,
  checkSensitiveFilePerms,
  checkConfigIntegrity,
  checkDefaultPermissionMode,
];

export function runSecurityChecks(
  ctx: SecurityAuditContext,
): readonly SecurityFinding[] {
  return SECURITY_CHECKS.flatMap((check) => check(ctx));
}

export interface SecurityAuditReport {
  readonly agencHome: string;
  readonly findings: readonly SecurityFinding[];
  readonly criticalCount: number;
  readonly warnCount: number;
  readonly fixedCount: number;
}

export interface SecurityAuditOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly applyFixes?: boolean;
}

export async function buildSecurityAuditReport(
  options: SecurityAuditOptions = {},
): Promise<SecurityAuditReport> {
  const env = options.env ?? process.env;
  const agencHome = resolveAgencHome(env);
  const loaded = await loadConfig({ home: agencHome, onWarn: () => {} });
  const ctx: SecurityAuditContext = {
    env,
    agencHome,
    configExists: loaded.exists,
    ...(loaded.parseError !== undefined
      ? { configParseError: loaded.parseError }
      : {}),
    ...(loaded.config.permissions?.default_mode !== undefined ||
    loaded.config.permissions?.defaultMode !== undefined
      ? {
          defaultPermissionMode:
            loaded.config.permissions?.default_mode ??
            loaded.config.permissions?.defaultMode,
        }
      : {}),
    applyFixes: options.applyFixes === true,
  };
  const findings = runSecurityChecks(ctx);
  return {
    agencHome,
    findings,
    criticalCount: findings.filter(
      (f) => f.severity === "critical" && f.fixed !== true,
    ).length,
    warnCount: findings.filter((f) => f.severity === "warn").length,
    fixedCount: findings.filter((f) => f.fixed === true).length,
  };
}

export function securityAuditExitCode(report: SecurityAuditReport): number {
  return report.criticalCount > 0 ? 1 : 0;
}

const SEVERITY_GLYPH: Record<SecuritySeverity, string> = {
  ok: "✓",
  warn: "⚠",
  critical: "✗",
};

export function formatSecurityAuditText(report: SecurityAuditReport): string {
  const lines: string[] = [];
  lines.push("AgenC security audit");
  lines.push("");
  lines.push(`  Home: ${report.agencHome}`);
  lines.push("");
  for (const finding of report.findings) {
    const glyph =
      finding.fixed === true ? "✓" : SEVERITY_GLYPH[finding.severity];
    lines.push(
      `  ${glyph} ${finding.title}${finding.fixed === true ? " (fixed)" : ""}`,
    );
    if (finding.severity !== "ok" && finding.fixed !== true) {
      lines.push(`      ${finding.detail}`);
      if (finding.remediation !== undefined) {
        lines.push(`      fix: ${finding.remediation}`);
      }
    }
  }
  lines.push("");
  if (report.criticalCount > 0) {
    lines.push(
      `  ${report.criticalCount} critical finding(s).` +
        ` Re-run with --fix to apply safe permission fixes; env/config findings need the listed manual fix.`,
    );
  } else if (report.warnCount > 0) {
    lines.push(`  No critical findings (${report.warnCount} warning(s)).`);
  } else {
    lines.push("  All checks passed.");
  }
  return lines.join("\n");
}

export function formatSecurityAuditSummaryLine(
  report: SecurityAuditReport,
): string {
  if (report.criticalCount > 0) {
    return `security audit: ${report.criticalCount} CRITICAL finding(s) — run 'agenc security audit' for details`;
  }
  if (report.warnCount > 0) {
    return `security audit: ok (${report.warnCount} warning(s) — 'agenc security audit')`;
  }
  return "security audit: all checks passed";
}

export type AgenCSecurityCliCommand =
  | { readonly kind: "audit"; readonly json: boolean; readonly fix: boolean }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function formatAgenCSecurityCliHelpText(): string {
  return [
    "agenc security — audit local exposure and blast radius",
    "",
    "Usage:",
    "  agenc security audit          Check daemon exposure, file permissions,",
    "                                config integrity, and permission-mode",
    "                                blast radius; exit 1 on critical findings",
    "  agenc security audit --fix    Also apply safe permission fixes",
    "                                (chmod 700/600 on AgenC state; never edits",
    "                                config or environment)",
    "  agenc security audit --json   Emit the report as JSON",
    "",
    "Options:",
    "  -h, --help  Show this help text",
  ].join("\n");
}

export function parseAgenCSecurityCliArgs(
  argv: readonly string[],
): AgenCSecurityCliCommand | null {
  if (argv[0] !== "security") return null;
  const rest = argv.slice(1);
  if (rest[0] === "--help" || rest[0] === "-h" || rest.length === 0) {
    return { kind: "help", text: formatAgenCSecurityCliHelpText() };
  }
  if (rest[0] !== "audit") {
    return {
      kind: "error",
      message: `unknown security subcommand '${rest[0]}' (expected: audit)`,
    };
  }
  let json = false;
  let fix = false;
  for (const arg of rest.slice(1)) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCSecurityCliHelpText() };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--fix") {
      fix = true;
      continue;
    }
    return {
      kind: "error",
      message: `security audit does not accept argument '${arg}'`,
    };
  }
  return { kind: "audit", json, fix };
}

export interface SecurityCliDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export async function runAgenCSecurityCli(
  command: AgenCSecurityCliCommand,
  deps: SecurityCliDeps = {},
): Promise<number> {
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  switch (command.kind) {
    case "help":
      stdout(command.text);
      return 0;
    case "error":
      stderr(`agenc: ${command.message}`);
      return 1;
    case "audit": {
      const report = await buildSecurityAuditReport({
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        applyFixes: command.fix,
      });
      stdout(
        command.json
          ? JSON.stringify(report, null, 2)
          : formatSecurityAuditText(report),
      );
      return securityAuditExitCode(report);
    }
  }
}
