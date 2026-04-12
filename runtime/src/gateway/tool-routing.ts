/**
 * Tool routing — claude_code-shaped static allowed tools (Cut 4.2).
 *
 * Replaces the previous 1,848-LOC `ToolRouter` machinery whose entire
 * job was per-phase narrowing of the tool set during planner-driven
 * turns. claude_code exposes a single static tool list per query, so
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
