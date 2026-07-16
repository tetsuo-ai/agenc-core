/**
 * CLI surface for `agenc permissions list/approve/revoke`.
 *
 * The no-target `list`, `approve`, and `revoke` paths manage the current
 * workspace's persisted permission rules. Targeted `--session` or `--agent`
 * calls go through the daemon JSON-RPC surface so operators can inspect and
 * resolve live background-agent permission requests without opening the TUI.
 */

import { cwd as processCwd } from "node:process";
import {
  createAgenCJsonLineDaemonRequestClient,
  defaultEnsureDaemonReady,
  type AgenCJsonLineDaemonRequestClient,
} from "../app-server/agent-cli.js";
import type {
  PermissionGrant,
  PermissionListParams,
  PermissionListResult,
  ToolApproveParams,
  ToolDecisionResult,
  ToolDenyParams,
} from "../app-server/protocol/index.js";
import {
  addPermissionRulesToSettings,
  deletePermissionRule,
  initializeToolPermissionContext,
  type DiskEnv,
} from "./settings.js";
import {
  createPermissionAuditFileLogger,
  recordPermissionAuditEvent,
  type PermissionAuditErrorHandler,
  type PermissionAuditLogger,
} from "./permission-audit-log.js";
import {
  type EditablePermissionRuleSource,
  type PermissionRule,
} from "./types.js";
import { parseRuleString, serializeRuleValue } from "./rules.js";
import { permissionGrantsFromToolPermissionContext } from "./permission-grants.js";

export type AgenCPermissionsCliCommand =
  | {
      readonly kind: "list";
      readonly target: PermissionListTarget | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "approveRule";
      readonly rule: string;
      readonly destination: EditablePermissionRuleSource;
    }
  | {
      readonly kind: "revokeRule";
      readonly rule: string;
      readonly destination: EditablePermissionRuleSource;
    }
  | {
      readonly kind: "approveRequest";
      readonly sessionId: string;
      readonly requestId: string;
      readonly scope?: ToolApproveParams["scope"];
    }
  | {
      readonly kind: "revokeRequest";
      readonly sessionId: string;
      readonly requestId: string;
      readonly reason?: string;
    }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export type PermissionListTarget =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "session"; readonly sessionId: string };

export interface AgenCPermissionsCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCPermissionsCliDaemonClient {
  listPermissions(params?: PermissionListParams): Promise<PermissionListResult>;
  approveTool(params: ToolApproveParams): Promise<ToolDecisionResult>;
  revokeTool(params: ToolDenyParams): Promise<ToolDecisionResult>;
}

export interface AgenCPermissionsCliOptions {
  readonly client?: AgenCPermissionsCliDaemonClient;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly io?: AgenCPermissionsCliIo;
  readonly ensureDaemonReady?: () => Promise<void>;
  readonly permissionAuditLogger?: PermissionAuditLogger;
  readonly onPermissionAuditError?: PermissionAuditErrorHandler;
}

const PERSIST_TARGETS: Readonly<Record<string, EditablePermissionRuleSource>> =
  Object.freeze({
    user: "userSettings",
    project: "projectSettings",
    local: "localSettings",
  });

type ApprovalScope = NonNullable<ToolApproveParams["scope"]>;

const APPROVE_SCOPES: readonly ApprovalScope[] = Object.freeze([
  "once",
  "session",
  "agent",
] as const);

export function formatAgenCPermissionsCliHelpText(): string {
  return [
    "Usage: agenc permissions <command>",
    "",
    "Commands:",
    "  list [--json] [--agent <id>|--session <id>]",
    "  approve [--persist user] <rule>",
    "  revoke [--persist <user|project|local>] <rule>",
    "  approve --session <id> [--scope <once|session|agent>] <request-id>",
    "  revoke --session <id> [--reason <text>] <request-id>",
    "",
    "Examples:",
    "  agenc permissions list",
    "  agenc permissions approve --persist user 'Read(./src/**)'",
    "  agenc permissions approve --session session_123 call_456",
    "  agenc permissions revoke --session session_123 call_456",
  ].join("\n");
}

export function parseAgenCPermissionsCliArgs(
  argv: readonly string[],
): AgenCPermissionsCliCommand | null {
  if (argv[0] !== "permissions") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCPermissionsCliHelpText() };
  }
  const args = argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { kind: "help", text: formatAgenCPermissionsCliHelpText() };
  }
  if (action === "list") return parseListArgs(args);
  if (action === "approve") return parseApproveArgs(args);
  if (action === "revoke") return parseRevokeArgs(args);
  return { kind: "error", message: `unknown permissions command: ${action}` };
}

export async function runAgenCPermissionsCli(
  command: AgenCPermissionsCliCommand,
  options: AgenCPermissionsCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCPermissionsCliHelpText()}\n`);
      return 1;
    case "list":
      return runPermissionsList(command, io, options);
    case "approveRule":
      return runPermissionRuleApproval(command, io, options);
    case "revokeRule":
      return runPermissionRuleRevoke(command, io, options);
    case "approveRequest":
      return runPermissionRequestApproval(command, io, options);
    case "revokeRequest":
      return runPermissionRequestRevoke(command, io, options);
  }
}

export function formatAgenCPermissionGrantList(
  result: PermissionListResult,
): string {
  if (result.permissions.length === 0) return "No permissions";
  return [
    ["id", "subject", "action", "scope", "granted_at", "expires_at"].join(
      "\t",
    ),
    ...result.permissions.map(formatPermissionGrantRow),
  ].join("\n");
}

function parseListArgs(
  args: readonly string[],
): AgenCPermissionsCliCommand {
  let json = false;
  let target: PermissionListTarget | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    const agent = readValueFlag(args, i, "--agent");
    if (agent !== null) {
      if (agent.value.length === 0) {
        return { kind: "error", message: "permissions list --agent requires an id" };
      }
      if (target !== null) {
        return {
          kind: "error",
          message: "permissions list accepts only one target",
        };
      }
      target = { kind: "agent", agentId: agent.value };
      i = agent.nextIndex;
      continue;
    }
    const session = readValueFlag(args, i, "--session");
    if (session !== null) {
      if (session.value.length === 0) {
        return {
          kind: "error",
          message: "permissions list --session requires an id",
        };
      }
      if (target !== null) {
        return {
          kind: "error",
          message: "permissions list accepts only one target",
        };
      }
      target = { kind: "session", sessionId: session.value };
      i = session.nextIndex;
      continue;
    }
    return {
      kind: "error",
      message: `permissions list does not accept argument '${arg}'`,
    };
  }
  return { kind: "list", target, json };
}

function parseApproveArgs(
  args: readonly string[],
): AgenCPermissionsCliCommand {
  const parsed = parseRuleOrRequestArgs(args, "approve");
  if (parsed.kind === "request") {
    return {
      kind: "approveRequest",
      sessionId: parsed.sessionId,
      requestId: parsed.value,
      ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
    };
  }
  if (parsed.kind === "error") return parsed;
  if (parsed.destination !== "userSettings") {
    return {
      kind: "error",
      message:
        "repository files cannot store permission approvals; use --persist user or approve a live request with --session",
    };
  }
  return {
    kind: "approveRule",
    rule: parsed.value,
    destination: parsed.destination,
  };
}

function parseRevokeArgs(
  args: readonly string[],
): AgenCPermissionsCliCommand {
  const parsed = parseRuleOrRequestArgs(args, "revoke");
  if (parsed.kind === "request") {
    return {
      kind: "revokeRequest",
      sessionId: parsed.sessionId,
      requestId: parsed.value,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    };
  }
  if (parsed.kind === "error") return parsed;
  return {
    kind: "revokeRule",
    rule: parsed.value,
    destination: parsed.destination,
  };
}

type ParsedRuleOrRequest =
  | {
      readonly kind: "rule";
      readonly value: string;
      readonly destination: EditablePermissionRuleSource;
    }
  | {
      readonly kind: "request";
      readonly value: string;
      readonly sessionId: string;
      readonly scope?: ToolApproveParams["scope"];
      readonly reason?: string;
    }
  | Extract<AgenCPermissionsCliCommand, { readonly kind: "error" }>;

function parseRuleOrRequestArgs(
  args: readonly string[],
  command: "approve" | "revoke",
): ParsedRuleOrRequest {
  let destination: EditablePermissionRuleSource = "userSettings";
  let sessionId: string | null = null;
  let scope: ApprovalScope | undefined;
  let reason: string | undefined;
  let sawPersist = false;
  let sawSession = false;
  let sawScope = false;
  let sawReason = false;
  const values: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const persist = readValueFlag(args, i, "--persist");
    if (persist !== null) {
      if (sawPersist) {
        return {
          kind: "error",
          message: `permissions ${command} accepts --persist only once`,
        };
      }
      sawPersist = true;
      const target = PERSIST_TARGETS[persist.value];
      if (target === undefined) {
        return {
          kind: "error",
          message: `permissions ${command} --persist must be user, project, or local`,
        };
      }
      destination = target;
      i = persist.nextIndex;
      continue;
    }
    const session = readValueFlag(args, i, "--session");
    if (session !== null) {
      if (sawSession) {
        return {
          kind: "error",
          message: `permissions ${command} accepts --session only once`,
        };
      }
      sawSession = true;
      if (session.value.length === 0) {
        return {
          kind: "error",
          message: `permissions ${command} --session requires an id`,
        };
      }
      sessionId = session.value;
      i = session.nextIndex;
      continue;
    }
    const parsedScope = readValueFlag(args, i, "--scope");
    if (parsedScope !== null) {
      if (command !== "approve") {
        return {
          kind: "error",
          message: "permissions revoke does not accept --scope",
        };
      }
      if (sawScope) {
        return {
          kind: "error",
          message: "permissions approve accepts --scope only once",
        };
      }
      sawScope = true;
      if (!isApproveScope(parsedScope.value)) {
        return {
          kind: "error",
          message: "permissions approve --scope must be once, session, or agent",
        };
      }
      scope = parsedScope.value;
      i = parsedScope.nextIndex;
      continue;
    }
    const parsedReason = readValueFlag(args, i, "--reason");
    if (parsedReason !== null) {
      if (command !== "revoke") {
        return {
          kind: "error",
          message: "permissions approve does not accept --reason",
        };
      }
      if (sawReason) {
        return {
          kind: "error",
          message: "permissions revoke accepts --reason only once",
        };
      }
      sawReason = true;
      reason = parsedReason.value;
      i = parsedReason.nextIndex;
      continue;
    }
    values.push(arg);
  }

  const value = values.join(" ").trim();
  if (value.length === 0) {
    return {
      kind: "error",
      message:
        sessionId === null
          ? `permissions ${command} requires a rule`
          : `permissions ${command} requires a request id`,
    };
  }
  if (sessionId !== null) {
    if (sawPersist) {
      return {
        kind: "error",
        message: `permissions ${command} cannot combine --session and --persist`,
      };
    }
    return {
      kind: "request",
      value,
      sessionId,
      ...(scope !== undefined ? { scope } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  if (scope !== undefined || reason !== undefined) {
    return {
      kind: "error",
      message: `permissions ${command} --scope/--reason require --session`,
    };
  }
  return { kind: "rule", value, destination };
}

async function runPermissionsList(
  command: Extract<AgenCPermissionsCliCommand, { readonly kind: "list" }>,
  io: AgenCPermissionsCliIo,
  options: AgenCPermissionsCliOptions,
): Promise<number> {
  try {
    const result =
      command.target === null
        ? await listLocalPermissions(options)
        : await listDaemonPermissions(command.target, options);
    io.stdout.write(
      command.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatAgenCPermissionGrantList(result)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runPermissionRuleApproval(
  command: Extract<AgenCPermissionsCliCommand, { readonly kind: "approveRule" }>,
  io: AgenCPermissionsCliIo,
  options: AgenCPermissionsCliOptions,
): Promise<number> {
  try {
    if (command.destination !== "userSettings") {
      throw new Error(
        "repository files cannot store permission approvals; use --persist user or approve a live request with --session",
      );
    }
    const ruleValue = parseRuleOrThrow(command.rule);
    const applied = await addPermissionRulesToSettings({
      destination: command.destination,
      behavior: "allow",
      rules: [ruleValue],
      env: diskEnvFromOptions(options),
    });
    if (!applied) {
      throw new Error("permission rules are managed by policy");
    }
    await recordPermissionAuditEvent(
      permissionAuditLoggerFromOptions(options),
      {
        eventKind: "rule_change",
        decision: "approved",
        source: "permissions-cli",
        subjectType: "rule",
        rule: serializeRuleValue(ruleValue),
        destination: command.destination,
        reasonCode: "local_rule_approved",
        metadata: { destination: command.destination },
      },
      options.onPermissionAuditError,
    );
    io.stdout.write(
      `Approved ${serializeRuleValue(ruleValue)} in ${command.destination}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runPermissionRuleRevoke(
  command: Extract<AgenCPermissionsCliCommand, { readonly kind: "revokeRule" }>,
  io: AgenCPermissionsCliIo,
  options: AgenCPermissionsCliOptions,
): Promise<number> {
  try {
    const ruleValue = parseRuleOrThrow(command.rule);
    const removed = await deletePermissionRule({
      destination: command.destination,
      rule: {
        source: command.destination,
        ruleBehavior: "allow",
        ruleValue,
      } satisfies PermissionRule,
      env: diskEnvFromOptions(options),
    });
    if (!removed) {
      throw new Error(
        `permission rule not found in ${command.destination}: ${serializeRuleValue(ruleValue)}`,
      );
    }
    await recordPermissionAuditEvent(
      permissionAuditLoggerFromOptions(options),
      {
        eventKind: "rule_change",
        decision: "revoked",
        source: "permissions-cli",
        subjectType: "rule",
        rule: serializeRuleValue(ruleValue),
        destination: command.destination,
        reasonCode: "local_rule_revoked",
        metadata: { destination: command.destination },
      },
      options.onPermissionAuditError,
    );
    io.stdout.write(
      `Revoked ${serializeRuleValue(ruleValue)} from ${command.destination}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runPermissionRequestApproval(
  command: Extract<AgenCPermissionsCliCommand, { readonly kind: "approveRequest" }>,
  io: AgenCPermissionsCliIo,
  options: AgenCPermissionsCliOptions,
): Promise<number> {
  try {
    await ensureDaemon(options);
    const client = options.client ?? createDefaultPermissionsClient(options);
    const result = await client.approveTool({
      sessionId: command.sessionId,
      requestId: command.requestId,
      ...(command.scope !== undefined ? { scope: command.scope } : {}),
    });
    io.stdout.write(`${result.requestId}\tapproved\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runPermissionRequestRevoke(
  command: Extract<AgenCPermissionsCliCommand, { readonly kind: "revokeRequest" }>,
  io: AgenCPermissionsCliIo,
  options: AgenCPermissionsCliOptions,
): Promise<number> {
  try {
    await ensureDaemon(options);
    const client = options.client ?? createDefaultPermissionsClient(options);
    const result = await client.revokeTool({
      sessionId: command.sessionId,
      requestId: command.requestId,
      ...(command.reason !== undefined ? { reason: command.reason } : {}),
    });
    io.stdout.write(`${result.requestId}\trevoked\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function listLocalPermissions(
  options: AgenCPermissionsCliOptions,
): Promise<PermissionListResult> {
  const { toolPermissionContext } = await initializeToolPermissionContext({
    env: diskEnvFromOptions(options),
  });
  return {
    permissions: permissionGrantsFromToolPermissionContext(
      toolPermissionContext,
    ),
  };
}

async function listDaemonPermissions(
  target: PermissionListTarget,
  options: AgenCPermissionsCliOptions,
): Promise<PermissionListResult> {
  await ensureDaemon(options);
  const client = options.client ?? createDefaultPermissionsClient(options);
  return client.listPermissions(
    target.kind === "agent"
      ? { agentId: target.agentId }
      : { sessionId: target.sessionId },
  );
}

function createDefaultPermissionsClient(
  options: AgenCPermissionsCliOptions,
): AgenCPermissionsCliDaemonClient {
  const requestClient: AgenCJsonLineDaemonRequestClient =
    createAgenCJsonLineDaemonRequestClient({ env: options.env });
  return {
    listPermissions: (params = {}) =>
      requestClient.request("permission.list", params),
    approveTool: (params) => requestClient.request("tool.approve", params),
    revokeTool: (params) => requestClient.request("tool.deny", params),
  };
}

async function ensureDaemon(options: AgenCPermissionsCliOptions): Promise<void> {
  await (options.ensureDaemonReady ?? defaultEnsureDaemonReady(options.env))();
}

function diskEnvFromOptions(options: AgenCPermissionsCliOptions): DiskEnv {
  return {
    home: options.home ?? options.env?.HOME,
    cwd: options.cwd ?? processCwd(),
  };
}

function permissionAuditLoggerFromOptions(
  options: AgenCPermissionsCliOptions,
): PermissionAuditLogger {
  if (options.permissionAuditLogger !== undefined) {
    return options.permissionAuditLogger;
  }
  return createPermissionAuditFileLogger({
    env: envForPermissionAudit(options),
  });
}

function envForPermissionAudit(
  options: AgenCPermissionsCliOptions,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(options.env ?? {}),
    ...(options.home !== undefined ? { HOME: options.home } : {}),
  };
}

function parseRuleOrThrow(rule: string) {
  const parsed = parseRuleString(rule);
  if (parsed === null) {
    throw new Error(`Invalid permission rule: ${rule}`);
  }
  return parsed;
}

function readValueFlag(
  args: readonly string[],
  index: number,
  flag: string,
): { readonly value: string; readonly nextIndex: number } | null {
  const arg = args[index]!;
  const prefix = `${flag}=`;
  if (arg.startsWith(prefix)) {
    return { value: arg.slice(prefix.length).trim(), nextIndex: index };
  }
  if (arg !== flag) return null;
  const value = args[index + 1];
  if (typeof value !== "string" || value.startsWith("-")) {
    return { value: "", nextIndex: index };
  }
  return { value: value.trim(), nextIndex: index + 1 };
}

function isApproveScope(value: string): value is ApprovalScope {
  return APPROVE_SCOPES.includes(value as ApprovalScope);
}

function formatPermissionGrantRow(grant: PermissionGrant): string {
  return [
    formatPermissionCell(grant.permissionId),
    formatPermissionCell(grant.subject),
    formatPermissionCell(grant.action),
    formatPermissionCell(grant.scope ?? "-"),
    formatPermissionCell(grant.grantedAt ?? "-"),
    formatPermissionCell(grant.expiresAt ?? "-"),
  ].join("\t");
}

function formatPermissionCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ");
}
