import type {
  AgentDefinition,
  WorkspaceAgentDefinitionsResult,
} from "../tools/AgentTool/loadAgentsDir.js";
import { requireAgentDefinitionRoleFingerprint } from "../tools/AgentTool/loadAgentsDir.js";
import {
  agentRoleFingerprint,
  assertAgentRoleWorkspaceMatches,
  listBuiltInAgentRoles,
  listAgentRoles,
  listRegisteredAgentRoles,
  type AgentReasoningEffort,
  type AgentRole,
  type AgentRoleWorkspace,
} from "./role.js";
import { canonicalAgentRoleName } from "./role-presentation.js";

const BUILT_IN_AGENT_ROLE_NAMES = new Set(
  listBuiltInAgentRoles().map((role) => canonicalAgentRoleName(role.name)),
);

type SessionAgentDefinitions = Pick<
  WorkspaceAgentDefinitionsResult,
  "agentRoleWorkspaceId"
> & {
  readonly activeAgents: readonly unknown[];
};

type CatalogEntry = {
  readonly role: AgentRole;
  readonly fingerprint: string;
};

export class AgentRoleCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRoleCatalogError";
  }
}

/**
 * Immutable executable-role snapshot owned by one runtime session.
 *
 * Markdown and plugin discovery happen before this object is constructed. The
 * control plane only resolves from these captured definitions, so schema,
 * spawn, and resume cannot observe a different home, config, or later daemon
 * session.
 */
export class AgentRoleCatalog {
  private readonly entries: ReadonlyMap<string, CatalogEntry>;

  constructor(
    readonly workspace: AgentRoleWorkspace,
    definitions?: SessionAgentDefinitions,
  ) {
    if (definitions !== undefined) {
      assertAgentRoleWorkspaceMatches(
        workspace,
        definitions.agentRoleWorkspaceId,
      );
    }

    const entries = new Map<string, CatalogEntry>();
    if (definitions === undefined || definitions.activeAgents.length === 0) {
      for (const role of listAgentRoles(workspace)) {
        entries.set(role.name, {
          role,
          fingerprint: agentRoleFingerprint(role),
        });
      }
    } else {
      const builtInRoles = new Map(
        listBuiltInAgentRoles().map((role) => [role.name, role]),
      );
      const programmaticRoles = new Map(
        listRegisteredAgentRoles(workspace).map((role) => [role.name, role]),
      );
      for (const candidate of definitions.activeAgents) {
        const definition = requireAgentDefinition(candidate);
        if (isRepositoryControlledBuiltinOverride(definition)) continue;
        if (entries.has(definition.agentType)) {
          throw new AgentRoleCatalogError(
            `Duplicate agent type in session catalog: ${definition.agentType}`,
          );
        }
        // Built-ins and explicit programmatic registrations already are exact
        // executable roles. Keep every field (configFile, serviceTier,
        // nickname candidates, and future role-only metadata) rather than
        // round-tripping them through the narrower markdown definition shape.
        const directRole = definition.source === "built-in"
          ? builtInRoles.get(definition.agentType)
          : definition.source === "flagSettings" &&
              definition.baseDir === "programmatic"
            ? programmaticRoles.get(definition.agentType)
            : undefined;
        const role = directRole ?? roleFromDefinition(definition);
        entries.set(role.name, {
          role,
          fingerprint: directRole === undefined
            ? requireAgentDefinitionRoleFingerprint(definition)
            : agentRoleFingerprint(directRole),
        });
      }
    }

    if (!entries.has("default")) {
      throw new AgentRoleCatalogError(
        "Session agent catalog is missing the default agent role",
      );
    }
    this.entries = entries;
    Object.freeze(this);
  }

  list(): readonly AgentRole[] {
    return Object.freeze(
      [...this.entries.values()].map((entry) => entry.role),
    );
  }

  get(name: string): AgentRole | undefined {
    return this.getExact(name) ?? this.getExact(canonicalAgentRoleName(name));
  }

  getExact(name: string): AgentRole | undefined {
    return this.entries.get(name)?.role;
  }

  require(name: string | undefined): AgentRole {
    const role = name === undefined ? this.getExact("default") : this.get(name);
    if (role === undefined) {
      throw new AgentRoleCatalogError(`unknown agent_type '${name ?? "default"}'`);
    }
    return role;
  }

  fingerprint(role: AgentRole): string {
    const entry = this.entries.get(role.name);
    if (entry === undefined || entry.role !== role) {
      throw new AgentRoleCatalogError(
        `Agent role does not belong to this session catalog: ${role.name}`,
      );
    }
    return entry.fingerprint;
  }
}

function requireAgentDefinition(value: unknown): AgentDefinition {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Partial<AgentDefinition>).agentType !== "string" ||
    (value as Partial<AgentDefinition>).agentType?.trim().length === 0 ||
    typeof (value as Partial<AgentDefinition>).whenToUse !== "string" ||
    typeof (value as Partial<AgentDefinition>).source !== "string" ||
    typeof (value as Partial<AgentDefinition>).getSystemPrompt !== "function"
  ) {
    throw new AgentRoleCatalogError(
      "Session agent catalog contains an invalid executable definition",
    );
  }
  return value as AgentDefinition;
}

function isRepositoryControlledBuiltinOverride(
  definition: AgentDefinition,
): boolean {
  const repositoryControlled =
    definition.source === "projectSettings" ||
    (definition.source === "plugin" && definition.repositoryControlled === true);
  if (!repositoryControlled) return false;
  const canonical = canonicalAgentRoleName(definition.agentType);
  return BUILT_IN_AGENT_ROLE_NAMES.has(canonical);
}

function roleFromDefinition(definition: AgentDefinition): AgentRole {
  const reasoningEffort = asAgentReasoningEffort(definition.effort);
  const systemPrompt = definition.getSystemPrompt();
  const config = Object.freeze({
    description: definition.whenToUse,
    systemPrompt,
    ...(definition.tools !== undefined
      ? { allowlist: Object.freeze([...definition.tools]) }
      : {}),
    ...(definition.disallowedTools !== undefined
      ? { disallowlist: Object.freeze([...definition.disallowedTools]) }
      : {}),
    ...(definition.model !== undefined && definition.model !== "inherit"
      ? { model: definition.model }
      : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(definition.background === true ? { background: true } : {}),
  });
  const source = definition.source === "plugin"
    ? "plugin"
    : definition.source === "built-in"
      ? "built-in"
      : definition.source === "userSettings"
        ? "userSettings"
        : definition.source === "projectSettings"
          ? "projectSettings"
          : definition.source === "policySettings"
            ? "policySettings"
            : "programmatic";
  return Object.freeze({
    name: definition.agentType,
    source,
    config,
  });
}

function asAgentReasoningEffort(
  value: AgentDefinition["effort"],
): AgentReasoningEffort | undefined {
  return value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}
