/**
 * Session tool policy: a fixed tool allowlist chosen by the client that
 * creates a daemon session (`agent.create` `toolPolicy`).
 *
 * The policy is enforced in three independent places so no single layer is
 * the only thing between a model and a forbidden tool:
 *   1. the tool registry never builds a tool outside `enabledTools`, so it is
 *      absent from the model-visible catalog AND from dispatch by name;
 *   2. the router refuses a call to such a name with an explicit message;
 *   3. the permission evaluator denies it as a bypass-immune unattended-policy
 *      rule (see `UnattendedPermissionPolicy.enabledTools`).
 *
 * It is persisted in the agent metadata under {@link TOOL_POLICY_METADATA_KEY}
 * so a restored session keeps exactly the policy it was created with.
 *
 * @module
 */

import { isPermissionMode, type PermissionMode } from "./types.js";

export interface SessionToolPolicy {
  /**
   * Exact dispatch names of the only tools the session may expose or run
   * (built-in names such as `FileRead`, MCP names such as `mcp.<server>.<tool>`).
   */
  readonly enabledTools: readonly string[];
  /**
   * The session permission mode may never become wider than it was at
   * creation, and permission rules / session-wide approvals that widen access
   * are refused.
   */
  readonly frozenPermissionMode?: boolean;
  /**
   * Whether MCP tools stay behind `system.searchTools` discovery. `false`
   * advertises the allowlisted MCP tools directly; omitted keeps the default.
   */
  readonly deferMcpTools?: boolean;
  /**
   * MCP dispatch names (`mcp.<server>.<tool>`, each also in `enabledTools`)
   * that the creating client vouches write nothing through Core: Core skips
   * filesystem target inference for them. It applies only to servers attached
   * to this session, never to configured or plugin servers, and only the
   * client that creates the session can set it.
   */
  readonly noFsWriteTools?: readonly string[];
}

/** Metadata key under which a session's policy is persisted and restored. */
export const TOOL_POLICY_METADATA_KEY = "toolPolicy";
/** Metadata key for the permission-mode ceiling of a frozen session. */
export const TOOL_POLICY_MODE_CEILING_METADATA_KEY = "toolPolicyModeCeiling";

/** Dispatch name of the tool that discovers deferred (MCP) tools. */
export const SEARCH_TOOLS_TOOL_NAME = "system.searchTools";
/** Dispatch name of the tool that loads skills. */
export const SKILL_TOOL_NAME = "Skill";
/**
 * An `enabledTools` entry `Skill:<name>` explicitly enables the one bundled
 * skill `<name>`. A bundled skill ships inside the runtime; a session with a
 * policy offers none of them unless it is named this way, and the `Skill`
 * tool itself must be enabled too.
 */
export const BUNDLED_SKILL_ENTRY_PREFIX = "Skill:";
/**
 * Bundled skills that no policy can enable. The kit installer tells the model
 * to download and run an installer script, which a session working through
 * untrusted content must never be able to reach.
 */
export const NEVER_ENABLED_BUNDLED_SKILLS: readonly string[] = Object.freeze([
  "agenc-marketplace-kit-installer",
]);

export const MAX_SESSION_TOOL_POLICY_TOOLS = 256;
const MAX_SESSION_TOOL_NAME_LENGTH = 128;
/**
 * Dispatch names are letters, digits and `_ . : -`: dots namespace built-ins
 * and MCP tools, colons appear in plugin-scoped MCP server ids.
 */
const SESSION_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const TOOL_POLICY_KEYS: ReadonlySet<string> = new Set([
  "enabledTools",
  "frozenPermissionMode",
  "deferMcpTools",
  "noFsWriteTools",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Describe the first problem with a candidate policy, or `undefined` when it
 * is well formed: non-empty, well-formed names, no duplicates, known keys.
 */
export function sessionToolPolicyIssue(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return "must be an object";
  for (const key of Object.keys(value)) {
    if (!TOOL_POLICY_KEYS.has(key)) return `does not accept '${key}'`;
  }
  const { enabledTools, frozenPermissionMode, deferMcpTools, noFsWriteTools } = value;
  if (!Array.isArray(enabledTools)) return "enabledTools must be an array of strings";
  if (enabledTools.length === 0) return "enabledTools must not be empty";
  if (enabledTools.length > MAX_SESSION_TOOL_POLICY_TOOLS) {
    return `enabledTools must have at most ${MAX_SESSION_TOOL_POLICY_TOOLS} entries`;
  }
  const seen = new Set<string>();
  for (const name of enabledTools) {
    if (typeof name !== "string") return "enabledTools must be an array of strings";
    if (
      name.length > MAX_SESSION_TOOL_NAME_LENGTH ||
      !SESSION_TOOL_NAME_PATTERN.test(name)
    ) {
      return `enabledTools entry ${JSON.stringify(name.slice(0, 64))} is not a well-formed tool name`;
    }
    if (seen.has(name)) return `enabledTools lists ${JSON.stringify(name)} more than once`;
    seen.add(name);
  }
  if (frozenPermissionMode !== undefined && typeof frozenPermissionMode !== "boolean") {
    return "frozenPermissionMode must be a boolean";
  }
  if (deferMcpTools !== undefined && typeof deferMcpTools !== "boolean") {
    return "deferMcpTools must be a boolean";
  }
  const tools = enabledTools as readonly string[];
  if (noFsWriteTools !== undefined) {
    if (!Array.isArray(noFsWriteTools)) return "noFsWriteTools must be an array of strings";
    const granted = new Set<string>();
    for (const name of noFsWriteTools) {
      if (typeof name !== "string") return "noFsWriteTools must be an array of strings";
      if (!/^mcp\.[^.]+\.[^.].*$/u.test(name)) {
        return `noFsWriteTools entry ${JSON.stringify(name.slice(0, 64))} is not an MCP tool name (mcp.<server>.<tool>)`;
      }
      if (!tools.includes(name)) return `noFsWriteTools entry ${JSON.stringify(name)} is not in enabledTools`;
      if (granted.has(name)) return `noFsWriteTools lists ${JSON.stringify(name)} more than once`;
      granted.add(name);
    }
  }
  const enabledSkills = tools.filter((name) => name.startsWith(BUNDLED_SKILL_ENTRY_PREFIX));
  for (const entry of enabledSkills) {
    const skill = entry.slice(BUNDLED_SKILL_ENTRY_PREFIX.length);
    if (skill.length === 0) return `enabledTools entry ${JSON.stringify(entry)} names no skill`;
    if (NEVER_ENABLED_BUNDLED_SKILLS.includes(skill)) {
      return `enabledTools entry ${JSON.stringify(entry)} is not allowed: that skill can never be enabled for a session with a toolPolicy`;
    }
  }
  if (enabledSkills.length > 0 && !tools.includes(SKILL_TOOL_NAME)) {
    return `enabledTools lists ${JSON.stringify(enabledSkills[0])} but not ${JSON.stringify(SKILL_TOOL_NAME)}, so no skill could be loaded`;
  }
  // MCP tools behind deferral are reached only through `system.searchTools`.
  // A policy that defers them, or that leaves deferral at its default while
  // naming MCP tools, and does not enable the search tool makes them
  // unreachable: refuse it instead of creating a session that cannot work.
  const defersMcpTools =
    deferMcpTools === true ||
    (deferMcpTools === undefined && tools.some((name) => name.startsWith("mcp.")));
  if (defersMcpTools && !tools.includes(SEARCH_TOOLS_TOOL_NAME)) {
    return (
      `enabledTools must include ${JSON.stringify(SEARCH_TOOLS_TOOL_NAME)} when MCP tools are deferred, ` +
      `or MCP tools could never be discovered; add it, or set deferMcpTools to false`
    );
  }
  return undefined;
}

/** Copy a validated policy into its frozen canonical shape. */
export function normalizeSessionToolPolicy(value: unknown): SessionToolPolicy {
  const issue = sessionToolPolicyIssue(value);
  if (issue !== undefined) throw new Error(`invalid toolPolicy: ${issue}`);
  const policy = value as SessionToolPolicy;
  return Object.freeze({
    enabledTools: Object.freeze([...policy.enabledTools]),
    ...(policy.frozenPermissionMode !== undefined
      ? { frozenPermissionMode: policy.frozenPermissionMode }
      : {}),
    ...(policy.deferMcpTools !== undefined
      ? { deferMcpTools: policy.deferMcpTools }
      : {}),
    ...(policy.noFsWriteTools !== undefined
      ? { noFsWriteTools: Object.freeze([...policy.noFsWriteTools]) }
      : {}),
  });
}

/**
 * The raw tool names of session MCP server `serverName` that the policy
 * vouches write nothing through Core, or `undefined` when it names none.
 */
export function sessionToolPolicyNoFsWriteTools(
  policy: SessionToolPolicy | undefined,
  serverName: string,
): readonly string[] | undefined {
  const prefix = `mcp.${serverName}.`;
  const tools = (policy?.noFsWriteTools ?? [])
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length));
  return tools.length === 0 ? undefined : Object.freeze(tools);
}

/**
 * Read the persisted policy out of agent metadata. An absent key means the
 * session has no policy. A present but malformed one throws: dropping it
 * would silently widen a restored session.
 */
export function sessionToolPolicyFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): SessionToolPolicy | undefined {
  const raw = metadata?.[TOOL_POLICY_METADATA_KEY];
  if (raw === undefined) return undefined;
  return normalizeSessionToolPolicy(raw);
}

/**
 * The permission-mode ceiling recorded for a frozen session. Absent means none
 * was recorded; an unrecognized value throws so a restore cannot lose it.
 */
export function retainedToolPolicyModeCeiling(
  metadata: Readonly<Record<string, unknown>> | undefined,
): PermissionMode | undefined {
  const raw = metadata?.[TOOL_POLICY_MODE_CEILING_METADATA_KEY];
  if (raw === undefined) return undefined;
  if (!isPermissionMode(raw)) {
    throw new Error("invalid toolPolicy permission mode ceiling");
  }
  return raw;
}

export function sessionToolPolicyAllowsTool(
  policy: SessionToolPolicy | undefined,
  toolName: string,
): boolean {
  return policy === undefined || policy.enabledTools.includes(toolName);
}

/**
 * Whether a session may offer or run the bundled skill `skillName`. Without a
 * policy every bundled skill is available. With one, a bundled skill needs an
 * explicit `Skill:<name>` entry beside the `Skill` tool, and the kit installer
 * is never available.
 */
export function sessionToolPolicyAllowsBundledSkill(
  policy: SessionToolPolicy | undefined,
  skillName: string,
): boolean {
  if (policy === undefined) return true;
  if (NEVER_ENABLED_BUNDLED_SKILLS.includes(skillName)) return false;
  return (
    policy.enabledTools.includes(SKILL_TOOL_NAME) &&
    policy.enabledTools.includes(`${BUNDLED_SKILL_ENTRY_PREFIX}${skillName}`)
  );
}

export function bundledSkillRefusalMessage(skillName: string): string {
  return `skill ${JSON.stringify(skillName)} is not enabled for this session`;
}

/**
 * The `/claim`, `/delegate`, `/proof`, `/settle` and `/stake` commands and the
 * marketplace CLI adapter behind them run a local binary against marketplace
 * data. A session with a policy has a fixed tool surface, so none of that is
 * part of it.
 */
export function sessionToolPolicyAllowsProtocolCommands(
  policy: SessionToolPolicy | undefined,
): boolean {
  return policy === undefined;
}

export const PROTOCOL_COMMANDS_REFUSAL_MESSAGE =
  "AgenC protocol commands are not available in a session with a toolPolicy. No command was executed.";

/** Whether two policies grant exactly the same authority. */
export function sameSessionToolPolicy(
  left: SessionToolPolicy,
  right: SessionToolPolicy,
): boolean {
  const leftNoFsWrite = left.noFsWriteTools ?? [];
  const rightNoFsWrite = right.noFsWriteTools ?? [];
  return (
    left.frozenPermissionMode === right.frozenPermissionMode &&
    left.deferMcpTools === right.deferMcpTools &&
    left.enabledTools.length === right.enabledTools.length &&
    left.enabledTools.every((name) => right.enabledTools.includes(name)) &&
    leftNoFsWrite.length === rightNoFsWrite.length &&
    leftNoFsWrite.every((name) => rightNoFsWrite.includes(name))
  );
}

export function toolPolicyRefusalMessage(toolName: string): string {
  return `tool ${JSON.stringify(toolName)} is not enabled for this session`;
}

// Higher rank = more authority. `plan` can only read; `dontAsk` refuses
// whatever would ask; `default`/`unattended`/`bubble` ask or pause; the rest
// run without asking for progressively more.
const PERMISSION_MODE_RANK: Readonly<Record<PermissionMode, number>> = {
  plan: 0,
  dontAsk: 1,
  default: 2,
  unattended: 2,
  bubble: 2,
  acceptEdits: 3,
  auto: 4,
  bypassPermissions: 5,
};

/** Whether switching from `ceiling` to `target` would grant more authority. */
export function isWiderPermissionMode(
  target: PermissionMode,
  ceiling: PermissionMode,
): boolean {
  return PERMISSION_MODE_RANK[target] > PERMISSION_MODE_RANK[ceiling];
}

export function frozenPermissionModeMessage(
  target: string,
  ceiling: string,
): string {
  return (
    `permission mode is frozen by this session's toolPolicy: cannot switch to ` +
    `${JSON.stringify(target)}, which is wider than ${JSON.stringify(ceiling)}`
  );
}
