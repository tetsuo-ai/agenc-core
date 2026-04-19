/**
 * Tool routing — static allowed tools (Cut 4.2).
 *
 * Replaces the previous 1,848-LOC `ToolRouter` machinery whose entire
 * job was per-phase narrowing of the tool set during planner-driven
 * turns. The runtime now exposes a single static tool list per query, so
 * the runtime no longer maintains per-cluster routing caches, schema
 * cost ledgers, or invalidation signals.
 *
 * The `ToolRoutingDecision` shape is preserved so existing trace
 * serialization, channel-wiring callbacks, and chat-executor routing
 * summaries keep their structural shape during the transition.
 *
 * Most turns still rely on the static full tool catalog, but we keep a
 * tiny lexical router for cases where the broad catalog repeatedly
 * causes the model to drift to the wrong read tool. Marketplace surface
 * inspection is one of those cases: overview / tasks / skills /
 * governance / disputes / reputation prompts should use
 * `agenc.inspectMarketplace` rather than the lower-level list/get tools.
 *
 * @module
 */

import {
  getShellProfilePreferredToolNames,
  type SessionShellProfile,
} from "./shell-profile.js";
import type { ToolCatalogEntry } from "../tools/types.js";
import type { SessionWorkflowStage } from "./workflow-state.js";

export interface ToolRoutingDecision {
  readonly routedToolNames: readonly string[];
  readonly expandedToolNames: readonly string[];
  readonly diagnostics: {
    readonly cacheHit: boolean;
    readonly clusterKey: string;
    readonly confidence: number;
    readonly invalidatedReason?: string;
    readonly totalToolCount: number;
    readonly routedToolCount: number;
    readonly expandedToolCount: number;
    readonly schemaCharsFull: number;
    readonly schemaCharsRouted: number;
    readonly schemaCharsExpanded: number;
    readonly schemaCharsSaved: number;
  };
}

const MARKETPLACE_INSPECT_TOOL = "agenc.inspectMarketplace";

const MARKETPLACE_CONTEXT_RE = /\bmarketplace\b/i;
const MARKETPLACE_READ_VERB_RE =
  /\b(?:inspect|show|summarize|summary|review|browse|list|top)\b/i;
const MARKETPLACE_SURFACE_RE =
  /\b(?:overview|surface|surfaces|tasks?|skills?|governance|proposals?|disputes?|reputation|counts?|available)\b/i;
const MARKETPLACE_MUTATION_RE =
  /\b(?:create|claim|complete|cancel|purchase|buy|install|rate|register|resolve|submit|file)\b/i;
const BROWSER_INTENT_RE =
  /\b(?:browser|playwright|screenshot|web page|website|navigate|click|type into|form|dom)\b/i;
const RESEARCH_INTENT_RE =
  /\b(?:research|sources?|citations?|evidence|compare|investigate|browse the web|look up)\b/i;
const REMOTE_INTENT_RE =
  /\b(?:remote job|remote session|callback|polling|ssh|remote debugging|remote worker)\b/i;
const SANDBOX_INTENT_RE =
  /\b(?:sandbox|container|docker|isolated environment)\b/i;
const OPERATOR_INTENT_RE =
  /\b(?:daemon|session list|approvals?|permissions|connector|marketplace|operator|runtime control)\b/i;

const FAMILY_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  browser: ["playwright.", "browser_", "system.browse", "system.extractLinks", "system.htmlToMarkdown"],
  research: ["system.research", "system.http", "system.browse", "browser_", "playwright."],
  remote: ["system.remoteJob", "system.remoteSession"],
  sandbox: ["system.sandbox"],
  operator: ["agenc.", "social.", "wallet."],
};

const ALWAYS_INLINE_TOOL_NAMES = new Set([
  "system.searchTools",
  "execute_with_agent",
  "coordinator",
  "task.create",
  "task.list",
  "task.get",
  "task.update",
  // Read-only marketplace browse surfaces — inexpensive schemas, often
  // the first thing the model reaches for, and they bootstrap further
  // discovery via `system.searchTools("select:agenc.<name>")`.
  "agenc.inspectMarketplace",
  "agenc.listTasks",
  "agenc.getTask",
  "agenc.listSkills",
  "agenc.getSkill",
  "agenc.getAgent",
]);

const DEFERRED_NAME_PREFIXES = [
  "mcp.",
  "mcp:",
  "system.remoteJob",
  "system.remoteSession",
  "system.sandbox",
  "system.server",
  "system.process",
  "system.research",
  // Heavy I/O surfaces — default-coding-agent has no reason to pay for
  // these every call. Discoverable via `system.searchTools` when needed.
  "system.http",
  "system.browserSession",
  "system.browserTransfer",
  "system.browserAction",
  "system.calendar",
  "system.email",
  "system.pdf",
  "system.officeDocument",
  "system.spreadsheet",
  "system.sqlite",
  "system.symbol",
  "system.gitWorktree",
  "system.applescript",
  "system.jxa",
  "system.evaluateJs",
  "system.notification",
  "system.screenshot",
  "system.exportPdf",
  // `agenc.*` marketplace/governance/reputation mutations — large schemas,
  // rarely needed for coding. Read-only browse tools are kept inline
  // via ALWAYS_INLINE_TOOL_NAMES above.
  "agenc.",
  "social.",
  "wallet.",
];

const DEFERRED_NAME_PATTERNS = [
  /^playwright\.browser_(?:session|attach|connect|transfer|share|handoff|close|tabs?)/i,
  /^browser_(?:session|attach|connect|transfer|share|handoff|close|tabs?)/i,
];

function uniqueToolNames(toolNames: readonly string[]): readonly string[] {
  return Array.from(
    new Set(toolNames.map((toolName) => toolName.trim()).filter(Boolean)),
  );
}

function isDeferredToolName(toolName: string): boolean {
  if (ALWAYS_INLINE_TOOL_NAMES.has(toolName)) {
    return false;
  }
  return (
    DEFERRED_NAME_PREFIXES.some((prefix) => toolName.startsWith(prefix)) ||
    DEFERRED_NAME_PATTERNS.some((pattern) => pattern.test(toolName))
  );
}

function isDeferredCatalogEntry(entry: ToolCatalogEntry): boolean {
  if (ALWAYS_INLINE_TOOL_NAMES.has(entry.name)) {
    return false;
  }
  // Explicit registrant-set marker wins over heuristics — tool factories
  // that know their surface is specialist (marketplace mutations,
  // browser sessions, HTTP, etc.) can opt in directly without relying
  // on the name-prefix / family / source probes below.
  if (entry.metadata.deferred === true) {
    return true;
  }
  if (entry.metadata.hiddenByDefault || entry.metadata.source === "mcp") {
    return true;
  }
  if (entry.metadata.family === "operator" && entry.metadata.mutating) {
    return true;
  }
  return isDeferredToolName(entry.name);
}

/**
 * Names of mutating tools the model may NOT invoke while the session
 * workflow stage is `"plan"`. Strictly read/search/browse/think tools
 * remain available so the model can explore the workspace and produce
 * a concrete plan.
 *
 * `workflow.enterPlan` and `workflow.exitPlan` are explicitly allowed
 * so the model can transition in and out of plan mode (the exit path
 * does not itself flip to implement — it records the plan for operator
 * approval and keeps the stage in `"plan"`).
 *
 * Mirrors the reference runtime's plan-mode edit-guard.
 */
const PLAN_MODE_ALWAYS_ALLOWED = new Set([
  "workflow.enterPlan",
  "workflow.exitPlan",
  "TodoWrite",
  "task.create",
  "task.list",
  "task.get",
  "task.update",
  "execute_with_agent",
  "system.searchTools",
]);

/**
 * Explicit deny list of tools known to mutate workspace / environment
 * state. Used by plan-mode filtering because the tool registrations in
 * `src/tools/` do NOT reliably populate `metadata.mutating = true` — at
 * the time of writing only `TodoWrite` declares that flag, so relying
 * purely on `entry.metadata.mutating !== true` lets every filesystem
 * write through. Keep this list synchronized with the actual mutating
 * surfaces; anything not present here is treated as read-only in plan
 * mode.
 */
const PLAN_MODE_DENY_BY_NAME = new Set([
  "system.writeFile",
  "system.editFile",
  "system.appendFile",
  "system.mkdir",
  "system.move",
  "system.delete",
  "system.bash",
]);

function isPlanModeAllowedEntry(entry: ToolCatalogEntry): boolean {
  if (PLAN_MODE_ALWAYS_ALLOWED.has(entry.name)) return true;
  if (PLAN_MODE_DENY_BY_NAME.has(entry.name)) return false;
  return entry.metadata.mutating !== true;
}

export function buildAdvertisedToolBundle(params: {
  readonly toolCatalog: readonly ToolCatalogEntry[];
  readonly providerNativeToolNames?: readonly string[];
  readonly shellProfile?: SessionShellProfile;
  readonly discoveredToolNames?: readonly string[];
  readonly explicitAllowedToolNames?: readonly string[];
  /**
   * Current session workflow stage. When `"plan"`, mutating tools are
   * hidden from the advertised bundle so the model physically cannot
   * invoke them — enforcing the plan-mode contract at the catalog
   * boundary instead of relying on the model to honor a prompt
   * instruction.
   */
  readonly workflowStage?: SessionWorkflowStage;
}): readonly string[] {
  if (params.explicitAllowedToolNames && params.explicitAllowedToolNames.length > 0) {
    return uniqueToolNames(params.explicitAllowedToolNames);
  }

  const planMode = params.workflowStage === "plan";
  const catalog = planMode
    ? params.toolCatalog.filter(isPlanModeAllowedEntry)
    : params.toolCatalog;
  const profile = params.shellProfile ?? "general";
  const inlineCatalogToolNames = catalog
    .filter((entry) => !isDeferredCatalogEntry(entry))
    .map((entry) => entry.name);
  const preferredInlineToolNames = getShellProfilePreferredToolNames({
    profile,
    availableToolNames: inlineCatalogToolNames,
  });
  const effectiveInlineToolNames =
    preferredInlineToolNames.length > 0
      ? preferredInlineToolNames
      : inlineCatalogToolNames;
  const providerNativeToolNames = (params.providerNativeToolNames ?? []).filter(
    (toolName) => !isDeferredToolName(toolName),
  );
  const discoveredToolNames = (params.discoveredToolNames ?? []).filter(
    (toolName) =>
      params.toolCatalog.some((entry) => entry.name === toolName) ||
      (params.providerNativeToolNames ?? []).includes(toolName),
  );
  return uniqueToolNames([
    ...effectiveInlineToolNames,
    ...providerNativeToolNames,
    ...discoveredToolNames,
  ]);
}

function estimateToolSchemaChars(toolNames: readonly string[]): number {
  return toolNames.reduce((total, toolName) => total + toolName.length, 0);
}

function buildSingleToolDecision(params: {
  availableToolNames: readonly string[];
  routedToolName: string;
  clusterKey: string;
  confidence?: number;
}): ToolRoutingDecision | undefined {
  const { availableToolNames, routedToolName, clusterKey } = params;
  if (!availableToolNames.includes(routedToolName)) {
    return undefined;
  }

  const schemaCharsFull = estimateToolSchemaChars(availableToolNames);
  const schemaCharsRouted = estimateToolSchemaChars([routedToolName]);

  return {
    routedToolNames: [routedToolName],
    expandedToolNames: [routedToolName],
    diagnostics: {
      cacheHit: false,
      clusterKey,
      confidence: params.confidence ?? 1,
      totalToolCount: availableToolNames.length,
      routedToolCount: 1,
      expandedToolCount: 1,
      schemaCharsFull,
      schemaCharsRouted,
      schemaCharsExpanded: schemaCharsRouted,
      schemaCharsSaved: Math.max(0, schemaCharsFull - schemaCharsRouted),
    },
  };
}

function isMarketplaceInspectPrompt(content: string): boolean {
  const normalized = content.trim();
  if (!MARKETPLACE_CONTEXT_RE.test(normalized)) {
    return false;
  }
  if (MARKETPLACE_MUTATION_RE.test(normalized)) {
    return false;
  }
  return MARKETPLACE_READ_VERB_RE.test(normalized) ||
    MARKETPLACE_SURFACE_RE.test(normalized);
}

function collectFamilyExpansionToolNames(params: {
  readonly content: string;
  readonly availableToolNames: readonly string[];
}): readonly string[] {
  const families: string[] = [];
  if (BROWSER_INTENT_RE.test(params.content)) families.push("browser");
  if (RESEARCH_INTENT_RE.test(params.content)) families.push("research");
  if (REMOTE_INTENT_RE.test(params.content)) families.push("remote");
  if (SANDBOX_INTENT_RE.test(params.content)) families.push("sandbox");
  if (OPERATOR_INTENT_RE.test(params.content)) families.push("operator");
  if (families.length === 0) return [];

  const expanded = new Set<string>();
  for (const family of families) {
    for (const prefix of FAMILY_PREFIXES[family] ?? []) {
      for (const toolName of params.availableToolNames) {
        if (toolName === prefix || toolName.startsWith(prefix)) {
          expanded.add(toolName);
        }
      }
    }
  }
  return [...expanded];
}

export function buildStaticToolRoutingDecision(params: {
  content: string;
  availableToolNames: readonly string[];
  shellProfile?: SessionShellProfile;
}): ToolRoutingDecision | undefined {
  const {
    content,
    availableToolNames,
    shellProfile,
  } = params;
  if (content.trim().length === 0 || availableToolNames.length === 0) {
    return undefined;
  }

  if (isMarketplaceInspectPrompt(content)) {
    return buildSingleToolDecision({
      availableToolNames,
      routedToolName: MARKETPLACE_INSPECT_TOOL,
      clusterKey: "marketplace-inspect",
    });
  }

  if (shellProfile && shellProfile !== "general") {
    const preferredToolNames = getShellProfilePreferredToolNames({
      profile: shellProfile,
      availableToolNames,
    });
    const familyExpansionToolNames = collectFamilyExpansionToolNames({
      content,
      availableToolNames,
    });
    const expandedToolNames = Array.from(
      new Set([...preferredToolNames, ...familyExpansionToolNames]),
    );
    if (
      preferredToolNames.length > 0 &&
      preferredToolNames.length < availableToolNames.length
    ) {
      const schemaCharsFull = estimateToolSchemaChars(availableToolNames);
      const schemaCharsRouted = estimateToolSchemaChars(preferredToolNames);
      const schemaCharsExpanded = estimateToolSchemaChars(expandedToolNames);
      return {
        routedToolNames: preferredToolNames,
        expandedToolNames,
        diagnostics: {
          cacheHit: false,
          clusterKey:
            familyExpansionToolNames.length > 0
              ? `shell-profile:${shellProfile}:expanded`
              : `shell-profile:${shellProfile}`,
          confidence: familyExpansionToolNames.length > 0 ? 0.8 : 0.72,
          totalToolCount: availableToolNames.length,
          routedToolCount: preferredToolNames.length,
          expandedToolCount: expandedToolNames.length,
          schemaCharsFull,
          schemaCharsRouted,
          schemaCharsExpanded,
          schemaCharsSaved: Math.max(0, schemaCharsFull - schemaCharsRouted),
        },
      };
    }
  }

  return undefined;
}
