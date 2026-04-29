/**
 * Context injection extracted from `ChatExecutor` (Phase F PR-7
 * E4 of the plan in TODO.MD).
 *
 * `injectContext` is the single best-effort seam that pulls durable
 * or session-scoped context (skills, identity, semantic memory,
 * learning, progress) out of an arbitrary provider and pushes the
 * budgeted result onto the ctx message history. It handles both
 * classic (`inject` / `retrieve`) and detailed (`injectDetailed` /
 * `retrieveDetailed`) provider shapes, including the skill plugin's
 * trusted/untrusted split and the memory retriever's curated entry
 * trace payload.
 *
 * Threaded as a free function that takes the ctx, the provider, the
 * live messages + sections arrays, the target section, and a
 * dependency struct carrying the executor's prompt budget config.
 *
 * @module
 */

import { truncateText } from "./chat-executor-text.js";
import { emitExecutionTrace } from "./chat-executor-ctx-helpers.js";
import { getContextSectionMaxChars } from "./chat-executor-config.js";
import type { PromptSection } from "./prompt-envelope.js";
import type {
  DetailedSkillInjectionResult,
  SkillInjector,
  MemoryRetriever,
  ExecutionContext,
} from "./chat-executor-types.js";
import type {
  PromptBudgetConfig,
  PromptBudgetSection,
} from "./prompt-budget.js";

interface DetailedMemoryTraceEntry {
  readonly role?: string;
  readonly source?: string;
  readonly provenance?: string;
  readonly combinedScore?: number;
}

interface DetailedMemoryRetrievalResult {
  readonly content: string | undefined;
  readonly entries?: readonly DetailedMemoryTraceEntry[];
  readonly curatedIncluded?: boolean;
  readonly estimatedTokens?: number;
}

interface DetailedMemoryRetriever extends MemoryRetriever {
  retrieveDetailed(
    message: string,
    sessionId: string,
  ): Promise<DetailedMemoryRetrievalResult>;
}

interface DetailedSkillInjector extends SkillInjector {
  injectDetailed(
    message: string,
    sessionId: string,
  ): Promise<DetailedSkillInjectionResult>;
}

function isDetailedMemoryRetriever(
  provider: SkillInjector | MemoryRetriever | undefined,
): provider is DetailedMemoryRetriever {
  return (
    !!provider &&
    "retrieveDetailed" in provider &&
    typeof provider.retrieveDetailed === "function"
  );
}

function isDetailedSkillInjector(
  provider: SkillInjector | MemoryRetriever | undefined,
): provider is DetailedSkillInjector {
  return (
    !!provider &&
    "injectDetailed" in provider &&
    typeof provider.injectDetailed === "function"
  );
}

/**
 * Dependency struct for `injectContext`. Currently just the prompt
 * budget config — the section max-char derivation reads the memory
 * role contracts off of it.
 */
export interface ContextInjectionDependencies {
  readonly promptBudget: PromptBudgetConfig;
}

export interface CollectedContextSection {
  readonly section: PromptSection;
  readonly budgetSection: PromptBudgetSection;
  readonly role: "system" | "user";
}

/**
 * Best-effort context collection. Supports both SkillInjector
 * (`.inject()` / `.injectDetailed()`) and MemoryRetriever
 * (`.retrieve()` / `.retrieveDetailed()`) interfaces. Failure is
 * non-blocking: a failed collection emits a trace event with
 * `error: "context_injection_failed"` and returns an empty result.
 *
 * Phase F extraction (PR-7, E4). Previously
 * `ChatExecutor.injectContext`.
 */
export async function collectContextSections(
  ctx: ExecutionContext,
  provider: SkillInjector | MemoryRetriever | undefined,
  message: string,
  sessionId: string,
  section: PromptBudgetSection,
  deps: ContextInjectionDependencies,
): Promise<readonly CollectedContextSection[]> {
  if (!provider) return [];
  const isSkillInjector = "inject" in provider;
  const providerKind = isSkillInjector ? "skill" : "memory";
  try {
    const detailedSkillResult =
      providerKind === "skill" && isDetailedSkillInjector(provider)
        ? await provider.injectDetailed(message, sessionId)
        : undefined;
    const detailedMemoryResult =
      providerKind === "memory" && isDetailedMemoryRetriever(provider)
        ? await provider.retrieveDetailed(message, sessionId)
        : undefined;
    const sectionMaxChars = getContextSectionMaxChars(
      deps.promptBudget,
      section,
    );
    const context =
      providerKind === "skill"
        ? (detailedSkillResult?.content ??
          await (provider as SkillInjector).inject(message, sessionId))
        : (detailedMemoryResult?.content ??
          await (provider as MemoryRetriever).retrieve(message, sessionId));
    const hasDetailedSkillSplit =
      providerKind === "skill" &&
      (typeof detailedSkillResult?.trustedContent === "string" ||
        typeof detailedSkillResult?.untrustedContent === "string");
    const truncatedTrustedContext =
      providerKind === "skill" &&
        typeof detailedSkillResult?.trustedContent === "string" &&
        detailedSkillResult.trustedContent.length > 0
        ? truncateText(detailedSkillResult.trustedContent, sectionMaxChars)
        : undefined;
    const truncatedUntrustedContext =
      providerKind === "skill" &&
        typeof detailedSkillResult?.untrustedContent === "string" &&
        detailedSkillResult.untrustedContent.length > 0
        ? truncateText(detailedSkillResult.untrustedContent, sectionMaxChars)
        : undefined;
    const truncatedContext = (!hasDetailedSkillSplit) &&
        typeof context === "string" &&
        context.length > 0
      ? truncateText(context, sectionMaxChars)
      : undefined;
    const collected: CollectedContextSection[] = [];
    if (truncatedTrustedContext) {
      collected.push({
        role: "system",
        budgetSection: section,
        section: {
          source: `${providerKind}_trusted`,
          content: truncatedTrustedContext,
        },
      });
    }
    if (truncatedUntrustedContext) {
      collected.push({
        role: "user",
        budgetSection: "user",
        section: {
          source: `${providerKind}_untrusted`,
          content: truncatedUntrustedContext,
        },
      });
    }
    if (truncatedContext) {
      collected.push({
        role: "system",
        budgetSection: section,
        section: {
          source: providerKind === "memory" ? section : providerKind,
          content: truncatedContext,
        },
      });
    }
    const injectedChars =
      collected.reduce(
        (sum, entry) => sum + entry.section.content.length,
        0,
      );
    emitExecutionTrace(ctx, {
      type: "context_injected",
      phase: "initial",
      callIndex: ctx.callIndex,
      payload: {
        providerKind,
        section,
        injected: collected.length > 0,
        originalChars: typeof context === "string" ? context.length : 0,
        injectedChars,
        ...(detailedSkillResult
          ? {
              trustedOriginalChars:
                detailedSkillResult.trustedContent?.length ?? 0,
              trustedInjectedChars:
                truncatedTrustedContext?.length ?? 0,
              untrustedOriginalChars:
                detailedSkillResult.untrustedContent?.length ?? 0,
              untrustedInjectedChars:
                truncatedUntrustedContext?.length ?? 0,
            }
          : {}),
        ...(detailedMemoryResult
          ? {
              curatedIncluded: detailedMemoryResult.curatedIncluded ?? false,
              estimatedTokens: detailedMemoryResult.estimatedTokens ?? 0,
              entries: (detailedMemoryResult.entries ?? []).slice(0, 8).map(
                (entry) => ({
                  role: entry.role ?? "unknown",
                  source: entry.source ?? "unknown",
                  provenance: entry.provenance ?? "unknown",
                  score: typeof entry.combinedScore === "number"
                    ? Number(entry.combinedScore.toFixed(4))
                    : undefined,
                }),
              ),
            }
          : {}),
      },
    });
    return collected;
  } catch {
    emitExecutionTrace(ctx, {
      type: "context_injected",
      phase: "initial",
      callIndex: ctx.callIndex,
      payload: {
        providerKind,
        section,
        injected: false,
        error: "context_injection_failed",
      },
    });
    return [];
  }
}
