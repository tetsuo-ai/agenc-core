import type { ToolCatalogEntry } from "../tools/types.js";
import type { AgentDefinition } from "./agent-loader.js";
import {
  getShellProfilePreferredToolNames,
  type SessionShellProfile,
} from "./shell-profile.js";

export type ShellAgentRoleSource = "curated" | "built-in" | "project" | "user";

export type ShellAgentTrustLabel =
  | "runtime"
  | "project-local"
  | "user-local";

export type ShellAgentToolBundleName =
  | "inherit"
  | "coding-core"
  | "docs-core"
  | "research-evidence"
  | "verification-probes"
  | "operator-core"
  | "marketplace-core"
  | "browser-test"
  | "remote-debug";

export interface ShellAgentRoleDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: ShellAgentRoleSource;
  readonly trustLabel: ShellAgentTrustLabel;
  readonly curated: boolean;
  readonly definitionName?: string;
  readonly defaultShellProfile: SessionShellProfile;
  readonly defaultToolBundle: ShellAgentToolBundleName;
  readonly mutating: boolean;
  readonly worktreeEligible: boolean;
}

interface CuratedShellAgentRoleDefinition {
  readonly descriptor: ShellAgentRoleDescriptor;
  readonly systemPrompt: string;
}

export interface ResolvedShellAgentRole {
  readonly descriptor: ShellAgentRoleDescriptor;
  readonly systemPrompt?: string;
  readonly toolNames?: readonly string[];
  readonly shellProfile: SessionShellProfile;
  readonly toolBundle: ShellAgentToolBundleName;
}

const CURATED_ROLE_DEFINITIONS: readonly CuratedShellAgentRoleDefinition[] = [
  {
    descriptor: {
      id: "coding",
      displayName: "Coding",
      description: "Bounded implementation child for repo-local code changes.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "coding",
      defaultToolBundle: "coding-core",
      mutating: true,
      worktreeEligible: true,
    },
    systemPrompt:
      "You are a coding child agent. Execute one bounded implementation objective inside the assigned workspace scope. " +
      "Prefer inspect-edit-verify loops, stay within the declared file and tool scope, and report concrete outputs instead of narrating every step.",
  },
  {
    descriptor: {
      id: "docs",
      displayName: "Docs",
      description: "Documentation and examples child for concise user-facing edits.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "documentation",
      defaultToolBundle: "docs-core",
      mutating: true,
      worktreeEligible: true,
    },
    systemPrompt:
      "You are a documentation child agent. Focus on docs, examples, onboarding text, and explanation-oriented file edits. " +
      "Keep wording precise, verify referenced commands or paths when they matter, and avoid widening scope into unrelated product work.",
  },
  {
    descriptor: {
      id: "research",
      displayName: "Research",
      description: "Read-only evidence-gathering child for source-backed investigation.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "research",
      defaultToolBundle: "research-evidence",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a research child agent. Gather evidence from code, docs, browser, and structured runtime surfaces before concluding. " +
      "Do not mutate project files unless the parent explicitly widens your scope.",
  },
  {
    descriptor: {
      id: "verify",
      displayName: "Verify",
      description: "Verifier child that tries to disprove an implementation with concrete checks.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "validation",
      defaultToolBundle: "verification-probes",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a verifier child agent. Your job is to test whether the claimed implementation actually holds up. " +
      "Use probes, logs, direct artifact inspection, and bounded runtime checks. Do not edit project files.",
  },
  {
    descriptor: {
      id: "operator",
      displayName: "Operator",
      description: "Runtime operations child for daemon, approvals, MCP, plugin, and session workflows.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "operator",
      defaultToolBundle: "operator-core",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are an operator child agent. Focus on runtime control-plane tasks such as sessions, approvals, MCP, plugins, connectors, and daemon health. " +
      "Prefer structured runtime surfaces over ad hoc shell commands when both can solve the task.",
  },
  {
    descriptor: {
      id: "marketplace",
      displayName: "Marketplace",
      description: "Marketplace/operator child for protocol task, skill, reputation, and governance surfaces.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "operator",
      defaultToolBundle: "marketplace-core",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a marketplace child agent. Focus on AgenC marketplace, reputation, dispute, and governance surfaces. " +
      "Use the structured market and operator tool surfaces instead of broad repo edits unless the parent explicitly assigns them.",
  },
  {
    descriptor: {
      id: "browser-testing",
      displayName: "Browser Testing",
      description: "Browser-grounded QA child for UI and flow validation.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "validation",
      defaultToolBundle: "browser-test",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a browser-testing child agent. Validate UI and workflow behavior with browser-grounded inspection and repo context. " +
      "Collect findings and evidence; do not mutate project files unless the parent explicitly assigns a fix phase.",
  },
  {
    descriptor: {
      id: "remote-debugging",
      displayName: "Remote Debugging",
      description: "Remote session and job debugging child for bounded operational diagnosis.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "validation",
      defaultToolBundle: "remote-debug",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a remote-debugging child agent. Investigate remote sessions, jobs, logs, and linked repo context to isolate concrete failures. " +
      "Bias toward evidence collection and diagnosis over speculative fixes.",
  },
] as const;

function titleCaseToken(value: string): string {
  return value
    .split(/[-_:\s]+/u)
    .filter((entry) => entry.length > 0)
    .map((entry) => entry[0]!.toUpperCase() + entry.slice(1))
    .join(" ");
}

function inferShellProfileFromDefinition(
  definition: AgentDefinition,
): SessionShellProfile {
  const corpus = `${definition.name} ${definition.description} ${definition.tools.join(" ")}`.toLowerCase();
  if (/\bverify|verification|probe\b/.test(corpus)) {
    return "validation";
  }
  if (/\boperator|daemon|approval|connector|mcp|marketplace|wallet|social\b/.test(corpus)) {
    return "operator";
  }
  if (/\bdoc|readme|example|guide|onboard\b/.test(corpus)) {
    return "documentation";
  }
  if (/\bresearch|explore|browse|source|evidence\b/.test(corpus)) {
    return "research";
  }
  if (/\bwritefile|appendfile|editfile|applypatch|bash\b/.test(corpus)) {
    return "coding";
  }
  return "general";
}

function inferToolBundleFromDefinition(
  definition: AgentDefinition,
): ShellAgentToolBundleName {
  const corpus = `${definition.name} ${definition.description} ${definition.tools.join(" ")}`.toLowerCase();
  if (/\bverify|verification|probe\b/.test(corpus)) {
    return "verification-probes";
  }
  if (/\boperator|daemon|approval|connector|mcp\b/.test(corpus)) {
    return "operator-core";
  }
  if (/\bmarketplace|reputation|governance|dispute\b/.test(corpus)) {
    return "marketplace-core";
  }
  if (/\bplaywright|browser_\b|browser\b/.test(corpus)) {
    return "browser-test";
  }
  if (/\bremotejob|remotesession|remote\b/.test(corpus)) {
    return "remote-debug";
  }
  if (/\bdoc|readme|example|guide\b/.test(corpus)) {
    return "docs-core";
  }
  if (/\bresearch|explore|browse|evidence\b/.test(corpus)) {
    return "research-evidence";
  }
  if (/\bwritefile|appendfile|editfile|applypatch|bash\b/.test(corpus)) {
    return "coding-core";
  }
  return "inherit";
}

function toRoleSource(
  source: AgentDefinition["source"],
): Extract<ShellAgentRoleSource, "built-in" | "project" | "user"> {
  if (source === "project") return "project";
  if (source === "user") return "user";
  return "built-in";
}

function toTrustLabel(
  source: ShellAgentRoleSource,
): ShellAgentTrustLabel {
  if (source === "project") return "project-local";
  if (source === "user") return "user-local";
  return "runtime";
}

function toDefinitionRoleId(definition: AgentDefinition): string {
  if (definition.source === "project") {
    return `project:${definition.name}`;
  }
  if (definition.source === "user") {
    return `user:${definition.name}`;
  }
  return definition.name;
}

function includesPrefix(
  name: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some((prefix) => name === prefix || name.startsWith(prefix));
}

function collectNamedTools(
  availableToolNames: readonly string[],
  exactNames: readonly string[] = [],
  prefixes: readonly string[] = [],
): readonly string[] {
  return Array.from(
    new Set(
      availableToolNames.filter((toolName) =>
        exactNames.includes(toolName) || includesPrefix(toolName, prefixes)
      ),
    ),
  );
}

function resolveToolBundleToolNames(params: {
  readonly bundle: ShellAgentToolBundleName;
  readonly availableToolNames: readonly string[];
}): readonly string[] | undefined {
  const { bundle, availableToolNames } = params;
  if (bundle === "inherit") {
    return undefined;
  }
  if (bundle === "coding-core") {
    return getShellProfilePreferredToolNames({
      profile: "coding",
      availableToolNames,
    });
  }
  if (bundle === "docs-core") {
    return Array.from(
      new Set([
        ...getShellProfilePreferredToolNames({
          profile: "documentation",
          availableToolNames,
        }),
        ...collectNamedTools(availableToolNames, [
          "system.readFile",
          "system.readFileRange",
          "system.writeFile",
          "system.appendFile",
          "system.editFile",
          "system.applyPatch",
          "system.searchFiles",
          "system.grep",
          "system.repoInventory",
          "system.searchTools",
        ]),
      ]),
    );
  }
  if (bundle === "research-evidence") {
    return Array.from(
      new Set([
        ...getShellProfilePreferredToolNames({
          profile: "research",
          availableToolNames,
        }),
        ...collectNamedTools(availableToolNames, [
          "system.readFile",
          "system.readFileRange",
          "system.listDir",
          "system.searchFiles",
          "system.grep",
          "system.repoInventory",
          "system.symbolSearch",
          "system.symbolDefinition",
          "system.symbolReferences",
          "system.searchTools",
        ]),
      ]),
    );
  }
  if (bundle === "verification-probes") {
    return collectNamedTools(
      availableToolNames,
      [
        "system.readFile",
        "system.readFileRange",
        "system.listDir",
        "system.stat",
        "system.searchFiles",
        "system.grep",
        "system.repoInventory",
        "verification.listProbes",
        "verification.runProbe",
        "task.list",
        "task.get",
        "system.searchTools",
      ],
    );
  }
  if (bundle === "operator-core") {
    return getShellProfilePreferredToolNames({
      profile: "operator",
      availableToolNames,
    });
  }
  if (bundle === "marketplace-core") {
    return Array.from(
      new Set([
        ...getShellProfilePreferredToolNames({
          profile: "operator",
          availableToolNames,
        }),
        ...collectNamedTools(availableToolNames, [], ["agenc."]),
      ]),
    );
  }
  if (bundle === "browser-test") {
    return collectNamedTools(
      availableToolNames,
      [
        "system.readFile",
        "system.readFileRange",
        "system.listDir",
        "system.searchFiles",
        "system.grep",
        "system.repoInventory",
        "system.searchTools",
      ],
      ["playwright.", "browser_"],
    );
  }
  if (bundle === "remote-debug") {
    return collectNamedTools(
      availableToolNames,
      [
        "system.readFile",
        "system.readFileRange",
        "system.listDir",
        "system.searchFiles",
        "system.grep",
        "system.repoInventory",
        "system.searchTools",
      ],
      ["system.remoteJob", "system.remoteSession"],
    );
  }
  return undefined;
}

function intersectTools(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  const allowed = new Set(right);
  const intersection = left.filter((toolName) => allowed.has(toolName));
  return intersection.length > 0 ? intersection : [];
}

export function listCuratedShellAgentRoles(): readonly ShellAgentRoleDescriptor[] {
  return CURATED_ROLE_DEFINITIONS.map((entry) => entry.descriptor);
}

export function buildShellAgentRoleCatalog(params: {
  readonly definitions: readonly AgentDefinition[];
}): readonly ShellAgentRoleDescriptor[] {
  const curated = CURATED_ROLE_DEFINITIONS.map((entry) => entry.descriptor);
  const builtinDefinitions: ShellAgentRoleDescriptor[] = [];
  const projectDefinitions: ShellAgentRoleDescriptor[] = [];
  const userDefinitions: ShellAgentRoleDescriptor[] = [];

  for (const definition of params.definitions) {
    const source = toRoleSource(definition.source);
    const descriptor: ShellAgentRoleDescriptor = {
      id: toDefinitionRoleId(definition),
      displayName: titleCaseToken(definition.name),
      description: definition.description || `${titleCaseToken(definition.name)} agent`,
      source,
      trustLabel: toTrustLabel(source),
      curated: false,
      definitionName: definition.name,
      defaultShellProfile: inferShellProfileFromDefinition(definition),
      defaultToolBundle: inferToolBundleFromDefinition(definition),
      mutating: definition.tools.some((toolName) =>
        [
          "system.writeFile",
          "system.appendFile",
          "system.editFile",
          "system.applyPatch",
          "desktop.text_editor",
          "desktop.bash",
          "system.bash",
        ].includes(toolName)
      ),
      worktreeEligible: definition.tools.some((toolName) =>
        [
          "system.writeFile",
          "system.appendFile",
          "system.editFile",
          "system.applyPatch",
          "desktop.text_editor",
          "desktop.bash",
          "system.bash",
        ].includes(toolName)
      ),
    };
    if (source === "project") {
      projectDefinitions.push(descriptor);
    } else if (source === "user") {
      userDefinitions.push(descriptor);
    } else {
      builtinDefinitions.push(descriptor);
    }
  }

  return [...curated, ...builtinDefinitions, ...projectDefinitions, ...userDefinitions];
}

export function resolveShellAgentRole(params: {
  readonly roleId: string;
  readonly definitions: readonly AgentDefinition[];
  readonly toolCatalog: readonly ToolCatalogEntry[];
  readonly toolBundleOverride?: ShellAgentToolBundleName;
  readonly shellProfileOverride?: SessionShellProfile;
}): ResolvedShellAgentRole | undefined {
  const curated = CURATED_ROLE_DEFINITIONS.find(
    (entry) => entry.descriptor.id === params.roleId,
  );
  const availableToolNames = params.toolCatalog.map((entry) => entry.name);
  if (curated) {
    const toolBundle =
      params.toolBundleOverride ?? curated.descriptor.defaultToolBundle;
    return {
      descriptor: curated.descriptor,
      systemPrompt: curated.systemPrompt,
      shellProfile:
        params.shellProfileOverride ?? curated.descriptor.defaultShellProfile,
      toolBundle,
      toolNames: resolveToolBundleToolNames({
        bundle: toolBundle,
        availableToolNames,
      }),
    };
  }

  const definition = params.definitions.find(
    (entry) => toDefinitionRoleId(entry) === params.roleId,
  );
  if (!definition) {
    return undefined;
  }
  const source = toRoleSource(definition.source);
  const descriptor: ShellAgentRoleDescriptor = {
    id: toDefinitionRoleId(definition),
    displayName: titleCaseToken(definition.name),
    description: definition.description || `${titleCaseToken(definition.name)} agent`,
    source,
    trustLabel: toTrustLabel(source),
    curated: false,
    definitionName: definition.name,
    defaultShellProfile: inferShellProfileFromDefinition(definition),
    defaultToolBundle: inferToolBundleFromDefinition(definition),
    mutating: definition.tools.some((toolName) =>
      [
        "system.writeFile",
        "system.appendFile",
        "system.editFile",
        "system.applyPatch",
        "desktop.text_editor",
        "desktop.bash",
        "system.bash",
      ].includes(toolName)
    ),
    worktreeEligible: definition.tools.some((toolName) =>
      [
        "system.writeFile",
        "system.appendFile",
        "system.editFile",
        "system.applyPatch",
        "desktop.text_editor",
        "desktop.bash",
        "system.bash",
      ].includes(toolName)
    ),
  };
  const toolBundle =
    params.toolBundleOverride ?? descriptor.defaultToolBundle;
  const bundledToolNames = resolveToolBundleToolNames({
    bundle: toolBundle,
    availableToolNames,
  });
  const toolNames = definition.tools.length > 0
    ? intersectTools(
        definition.tools,
        bundledToolNames ?? definition.tools,
      )
    : bundledToolNames;
  return {
    descriptor,
    systemPrompt: definition.body.trim().length > 0 ? definition.body.trim() : undefined,
    shellProfile:
      params.shellProfileOverride ?? descriptor.defaultShellProfile,
    toolBundle,
    toolNames,
  };
}
