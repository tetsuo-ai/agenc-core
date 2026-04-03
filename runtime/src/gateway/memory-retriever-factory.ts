/**
 * Factory for creating memory retrievers from gateway config.
 *
 * Extracts memory retriever creation logic from daemon.ts into a focused
 * module: semantic pipeline (embedding + vector store + ingestion) and
 * fallback basic-history retriever.
 *
 * Gate 3 — prerequisite reduction for planner/pipeline cross-cut.
 */

import { join } from "node:path";
import type { MemoryRetriever } from "../llm/chat-executor-types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import type { HookDispatcher } from "./hooks.js";
import type { GatewayConfig } from "./types.js";
import { createEmbeddingProvider } from "../memory/embeddings.js";
import { InMemoryVectorStore } from "../memory/vector-store.js";
import { SqliteVectorBackend } from "../memory/sqlite/vector-backend.js";
import { SemanticMemoryRetriever } from "../memory/retriever.js";
import {
  MemoryIngestionEngine,
  createIngestionHooks,
} from "../memory/ingestion.js";
import { CuratedMemoryManager, DailyLogManager, NoopEntityExtractor } from "../memory/structured.js";
import { LLMEntityExtractor } from "../memory/llm-entity-extractor.js";
import { sanitizeDelegatedAssistantEnvironmentSummary } from "../utils/delegated-scope-trust.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Semantic memory retriever defaults. */
export const SEMANTIC_MEMORY_DEFAULTS = {
  MAX_TOKEN_BUDGET: 2000,
  MAX_RESULTS: 5,
  RECENCY_WEIGHT: 0.3,
  RECENCY_HALF_LIFE_MS: 86_400_000,
  HYBRID_VECTOR_WEIGHT: 0.7,
  HYBRID_KEYWORD_WEIGHT: 0.3,
} as const;

const MIN_LEARNING_CONFIDENCE = 0.5;
const BASIC_MAX_ENTRIES = 10;
const BASIC_MAX_ENTRY_CHARS = 1_000;
const BASIC_MAX_TOTAL_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

export interface CreateMemoryRetrieversParams {
  config: GatewayConfig;
  hooks: HookDispatcher;
  memoryBackend: MemoryBackend;
  /** Resolved host workspace path for semantic memory. */
  workspacePath: string;
  logger: Logger;
  /** Optional LLM provider for entity extraction (Phase 3). */
  llmProvider?: import("../llm/types.js").LLMProvider;
}

export interface MemoryRetrieversResult {
  memoryRetriever: MemoryRetriever;
  learningProvider: MemoryRetriever;
}

// ---------------------------------------------------------------------------
// Vector DB path resolution
// ---------------------------------------------------------------------------

function resolveVectorDbPath(_workspacePath: string): string | undefined {
  // Use a single global vector DB at ~/.agenc/vectors.db so memories
  // are accessible across all workspaces.  The daemon serves sessions
  // from many workspaces but only opens one vector backend, so a
  // per-workspace DB makes memories invisible to other workspaces.
  try {
    const { existsSync, mkdirSync } = require("node:fs");
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const vectorDir = join(home, ".agenc");
    if (!existsSync(vectorDir)) {
      mkdirSync(vectorDir, { recursive: true });
    }
    return join(vectorDir, "vectors.db");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Create memory retriever + learning provider from gateway config.
 * Uses semantic pipeline (embedding + vector store + ingestion) when an
 * embedding provider is available, falls back to basic history retriever.
 */
export async function createMemoryRetrievers(
  params: CreateMemoryRetrieversParams,
): Promise<MemoryRetrieversResult> {
  const { config, hooks, memoryBackend, workspacePath, logger } = params;

  const embeddingProvider = await createEmbeddingProvider({
    preferred: config.memory?.embeddingProvider,
    apiKey: config.memory?.embeddingApiKey ?? config.llm?.apiKey,
    baseUrl: config.memory?.embeddingBaseUrl,
    model: config.memory?.embeddingModel,
  });
  const isSemanticAvailable = embeddingProvider.name !== "noop";

  const memoryRetriever = isSemanticAvailable
    ? await createSemanticRetriever(embeddingProvider, hooks, workspacePath, logger, params)
    : createBasicHistoryRetriever(memoryBackend);

  if (!isSemanticAvailable) {
    logger.info(
      "Semantic memory unavailable — using basic history retriever",
    );
  }

  return {
    memoryRetriever,
    learningProvider: createLearningRetriever(memoryBackend, workspacePath),
  };
}

// ---------------------------------------------------------------------------
// Semantic memory retriever
// ---------------------------------------------------------------------------

async function createSemanticRetriever(
  embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>>,
  hooks: HookDispatcher,
  workspacePath: string,
  logger: Logger,
  params: CreateMemoryRetrieversParams,
): Promise<MemoryRetriever> {
  // Use SqliteVectorBackend for persistent vector storage.
  // Per TODO Phase 1: vectors must survive daemon restarts.
  // The vector DB is stored alongside the memory DB as a sibling file.
  const vectorDbPath = resolveVectorDbPath(workspacePath);
  const vectorStore = vectorDbPath
    ? new SqliteVectorBackend({
        dbPath: vectorDbPath,
        dimension: embeddingProvider.dimension,
      })
    : new InMemoryVectorStore({
        dimension: embeddingProvider.dimension,
      });

  const curatedMemoryPath = join(workspacePath, "MEMORY.md");
  const dailyLogPath = join(workspacePath, "logs");
  const curatedMemory = new CuratedMemoryManager(curatedMemoryPath);
  const logManager = new DailyLogManager(dailyLogPath);

  // Phase 3: enable entity extraction when LLM provider is available.
  // Uses substring grounding + low default confidence (skeptic findings).
  const entityExtractor = params.llmProvider
    ? new LLMEntityExtractor({ llmProvider: params.llmProvider, logger })
    : new NoopEntityExtractor();
  const enableEntityExtraction = params.llmProvider !== undefined;

  const ingestionEngine = new MemoryIngestionEngine({
    embeddingProvider,
    vectorStore,
    logManager,
    curatedMemory,
    entityExtractor,
    generateSummaries: false,
    enableDailyLogs: true,
    enableEntityExtraction,
    logger,
  });

  const ingestionHooks = createIngestionHooks(ingestionEngine, logger);
  for (const hook of ingestionHooks) {
    hooks.on(hook);
  }

  logger.info(
    `Semantic memory enabled (embedding: ${embeddingProvider.name}, dim: ${embeddingProvider.dimension}, workspace: ${workspacePath}, curatedMemoryPath: ${curatedMemoryPath}, dailyLogPath: ${dailyLogPath})`,
  );

  return new SemanticMemoryRetriever({
    vectorBackend: vectorStore,
    embeddingProvider,
    curatedMemory,
    maxTokenBudget: SEMANTIC_MEMORY_DEFAULTS.MAX_TOKEN_BUDGET,
    maxResults: SEMANTIC_MEMORY_DEFAULTS.MAX_RESULTS,
    recencyWeight: SEMANTIC_MEMORY_DEFAULTS.RECENCY_WEIGHT,
    recencyHalfLifeMs: SEMANTIC_MEMORY_DEFAULTS.RECENCY_HALF_LIFE_MS,
    hybridVectorWeight: SEMANTIC_MEMORY_DEFAULTS.HYBRID_VECTOR_WEIGHT,
    hybridKeywordWeight: SEMANTIC_MEMORY_DEFAULTS.HYBRID_KEYWORD_WEIGHT,
    // Phase 2: workspace scoping ensures retrieval isolation
    workspaceId: workspacePath || undefined,
    logger,
  });
}

// ---------------------------------------------------------------------------
// Basic history retriever (fallback when no embedding provider)
// ---------------------------------------------------------------------------

export function createBasicHistoryRetriever(
  memoryBackend: MemoryBackend,
): MemoryRetriever {
  return {
    async retrieve(
      _message: string,
      sessionId: string,
    ): Promise<string | undefined> {
      try {
        const entries = await memoryBackend.getThread(sessionId, BASIC_MAX_ENTRIES);
        if (entries.length === 0) return undefined;
        const lines: string[] = [];
        let used = 0;
        for (const entry of entries) {
          const shouldSuppressDelegatedEnvironmentFact =
            entry.metadata?.delegatedScopeContainsEnvironmentFact === true &&
            entry.metadata?.delegatedScopeTrust !== "trusted_authoritative";
          if (shouldSuppressDelegatedEnvironmentFact) {
            continue;
          }
          const normalized = sanitizeDelegatedAssistantEnvironmentSummary(
            entry.content.trim(),
          );
          const clipped =
            normalized.length > BASIC_MAX_ENTRY_CHARS
              ? normalized.slice(0, BASIC_MAX_ENTRY_CHARS - 3) + "..."
              : normalized;
          const line = `[${entry.role}] ${clipped}`;
          if (used + line.length > BASIC_MAX_TOTAL_CHARS) break;
          lines.push(line);
          used += line.length;
        }
        if (lines.length === 0) return undefined;
        return "# Recent Memory\n\n" + lines.join("\n");
      } catch {
        return undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Learning provider (reads learned patterns from KV store)
// ---------------------------------------------------------------------------

export function createLearningRetriever(
  memoryBackend: MemoryBackend,
  workspacePath?: string,
): MemoryRetriever {
  // Phase 2B: scope learning key by workspace to prevent cross-workspace leakage.
  // Security finding C-1: global learning:latest leaked between workspaces.
  const learningKey = workspacePath
    ? `${workspacePath}:learning:latest`
    : "learning:latest";
  return {
    async retrieve(): Promise<string | undefined> {
      if (!memoryBackend) return undefined;
      try {
        const learning = await memoryBackend.get<{
          patterns: Array<{
            type: string;
            description: string;
            lesson: string;
            confidence: number;
          }>;
          strategies: Array<{
            name: string;
            description: string;
            steps: string[];
          }>;
          preferences: Record<string, string>;
        }>(learningKey);
        if (!learning) return undefined;

        const parts: string[] = [];
        const lessons = (learning.patterns ?? [])
          .filter((pattern) => pattern.confidence >= MIN_LEARNING_CONFIDENCE)
          .slice(0, 10)
          .map((pattern) => `- ${pattern.lesson}`);
        if (lessons.length > 0) parts.push("Lessons:\n" + lessons.join("\n"));

        const strategies = (learning.strategies ?? [])
          .slice(0, 5)
          .map((strategy) => `- ${strategy.name}: ${strategy.description}`);
        if (strategies.length > 0) {
          parts.push("Strategies:\n" + strategies.join("\n"));
        }

        const preferences = Object.entries(learning.preferences ?? {})
          .slice(0, 5)
          .map(([key, value]) => `- ${key}: ${value}`);
        if (preferences.length > 0) {
          parts.push("Preferences:\n" + preferences.join("\n"));
        }

        if (parts.length === 0) return undefined;
        return "## Learned Patterns\n\n" + parts.join("\n\n");
      } catch {
        return undefined;
      }
    },
  };
}
