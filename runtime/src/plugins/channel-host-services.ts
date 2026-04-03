import { dirname, join } from "node:path";
import type { GatewayConfig } from "../gateway/types.js";
import { createMemoryBackend } from "../gateway/memory-backend-factory.js";
import { AgentIdentityManager } from "../memory/agent-identity.js";
import { MemoryGraph } from "../memory/graph.js";
import { createEmbeddingProvider } from "../memory/embeddings.js";
import {
  MemoryIngestionEngine,
  type TurnIngestionMetadata,
} from "../memory/ingestion.js";
import { ProceduralMemory } from "../memory/procedural.js";
import { SemanticMemoryRetriever } from "../memory/retriever.js";
import { SharedMemoryBackend } from "../memory/shared-memory.js";
import { SocialMemoryManager } from "../memory/social-memory.js";
import { CuratedMemoryManager, DailyLogManager } from "../memory/structured.js";
import { SqliteVectorBackend } from "../memory/sqlite/vector-backend.js";
import { MemoryTraceLogger } from "../memory/trace-logger.js";
import { resolveWorldVectorDbPath } from "../memory/world-db-resolver.js";
import { runReflection } from "../memory/reflection.js";
import { runConsolidation, runRetention } from "../memory/consolidation.js";
import { createSingleLLMProvider } from "../gateway/llm-provider-manager.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";

const DEFAULT_CONCORDIA_GM_MODEL = "grok-4-1-fast-non-reasoning";

interface ConcordiaProcedureRecord {
  readonly name: string;
  readonly trigger: string;
  readonly steps: readonly string[];
  readonly workspaceId?: string;
}

interface ConcordiaProcedureResult {
  readonly name: string;
  readonly trigger: string;
  readonly steps: readonly string[];
  readonly confidence: number;
}

interface ConcordiaMemoryEntryLike {
  readonly id: string;
  readonly role?: string;
}

interface ConcordiaRetrieverResult {
  readonly content?: string;
  readonly estimatedTokens: number;
  readonly entries: readonly {
    readonly entry: ConcordiaMemoryEntryLike;
    readonly role: string;
  }[];
}

export interface ConcordiaWorldMemoryHostServices {
  readonly memoryBackend: MemoryBackend;
  readonly identityManager: AgentIdentityManager;
  readonly socialMemory: SocialMemoryManager;
  readonly proceduralMemory: {
    record(input: ConcordiaProcedureRecord): Promise<unknown>;
    retrieve(
      triggerText: string,
      workspaceId?: string,
    ): Promise<readonly ConcordiaProcedureResult[]>;
    formatForPrompt(
      procedures: ReadonlyArray<ConcordiaProcedureResult>,
    ): string;
  };
  readonly graph: {
    upsertNode(input: {
      content: string;
      sessionId?: string;
      tags?: string[];
      entityName?: string;
      entityType?: string;
      workspaceId?: string;
      metadata?: Record<string, unknown>;
      provenance: Array<{
        type: string;
        sourceId: string;
        description?: string;
        metadata?: Record<string, unknown>;
      }>;
    }): Promise<{
      id: string;
      content: string;
      entityName?: string;
      entityType?: string;
    }>;
    findByEntity(
      name: string,
      workspaceId?: string,
    ): Promise<Array<{
      id: string;
      content: string;
      entityName?: string;
      entityType?: string;
    }>>;
    getRelatedEntities(
      nodeId: string,
      depth?: number,
    ): Promise<Array<{
      id: string;
      content: string;
      entityName?: string;
    }>>;
    updateEdge(edgeId: string, update: { validUntil?: number }): Promise<void>;
    addEdge(params: {
      sourceId: string;
      targetId: string;
      type: string;
      content?: string;
      validFrom?: number;
      validUntil?: number;
    }): Promise<unknown>;
  };
  readonly sharedMemory: {
    writeFact(params: {
      scope: "user" | "organization" | "capability";
      content: string;
      author: string;
      userId?: string;
      visibility?: "private" | "shared" | "world-visible" | "lineage-shared";
      lineageId?: string | null;
      trustSource?: "system" | "agent" | "user" | "external";
      confidence?: number;
      provenance?: readonly {
        type: string;
        source: "system" | "agent" | "user" | "external";
        source_id: string;
        simulation_id?: string | null;
        lineage_id?: string | null;
        parent_simulation_id?: string | null;
        world_id?: string | null;
        workspace_id?: string | null;
        event_id?: string | null;
        timestamp: number;
        metadata?: Record<string, unknown> | null;
      }[];
      authorization?: {
        mode: "auto" | "requires-user-authorization" | "requires-system-authorization";
        approved: boolean;
        approved_by?: string | null;
        approved_at?: number | null;
        reason?: string | null;
      };
    }): Promise<{
      id?: string;
      content: string;
      author: string;
      userId?: string;
      visibility?: "private" | "shared" | "world-visible" | "lineage-shared";
      trust?: {
        source: "system" | "agent" | "user" | "external";
        score: number;
        confidence: number;
        threshold: number;
      } | null;
      provenance?: readonly {
        type: string;
        source: "system" | "agent" | "user" | "external";
        source_id: string;
        simulation_id?: string | null;
        lineage_id?: string | null;
        parent_simulation_id?: string | null;
        world_id?: string | null;
        workspace_id?: string | null;
        event_id?: string | null;
        timestamp: number;
        metadata?: Record<string, unknown> | null;
      }[];
      authorization?: {
        mode: "auto" | "requires-user-authorization" | "requires-system-authorization";
        approved: boolean;
        approved_by?: string | null;
        approved_at?: number | null;
        reason?: string | null;
      } | null;
    }>;
    getFacts(
      scope: "user" | "organization" | "capability",
      userId?: string,
      options?: {
        readonly lineageId?: string | null;
        readonly minTrustScore?: number;
        readonly allowedVisibilities?: readonly ("private" | "shared" | "world-visible" | "lineage-shared")[];
      },
    ): Promise<Array<{
      id?: string;
      content: string;
      author: string;
      userId?: string;
      visibility?: "private" | "shared" | "world-visible" | "lineage-shared";
      trust?: {
        source: "system" | "agent" | "user" | "external";
        score: number;
        confidence: number;
        threshold: number;
      } | null;
      provenance?: readonly {
        type: string;
        source: "system" | "agent" | "user" | "external";
        source_id: string;
        simulation_id?: string | null;
        lineage_id?: string | null;
        parent_simulation_id?: string | null;
        world_id?: string | null;
        workspace_id?: string | null;
        event_id?: string | null;
        timestamp: number;
        metadata?: Record<string, unknown> | null;
      }[];
      authorization?: {
        mode: "auto" | "requires-user-authorization" | "requires-system-authorization";
        approved: boolean;
        approved_by?: string | null;
        approved_at?: number | null;
        reason?: string | null;
      } | null;
    }>>;
  };
  readonly traceLogger: MemoryTraceLogger;
  readonly dailyLogManager?: {
    append(sessionId: string, entry: {
      timestamp: number;
      type: string;
      step?: number;
      actingAgent?: string;
      content: string;
    }): Promise<void>;
  };
  readonly ingestionEngine?: {
    ingestTurn(
      sessionId: string,
      userMessage: string,
      agentResponse: string,
      metadata?: TurnIngestionMetadata,
    ): Promise<void>;
  };
  readonly retriever?: {
    retrieve(message: string, sessionId: string): Promise<string | undefined>;
    retrieveDetailed(
      message: string,
      sessionId: string,
    ): Promise<ConcordiaRetrieverResult>;
  };
  readonly lifecycle?: {
    reflectAgent(input: {
      agentId: string;
      sessionId: string;
      workspaceId?: string;
    }): Promise<boolean>;
    consolidate(input?: {
      workspaceId?: string;
    }): Promise<{
      processed: number;
      consolidated: number;
      skippedDuplicates: number;
      durationMs: number;
    } | null>;
    retain(): Promise<{
      expiredDeleted: number;
      logsDeleted: number;
    }>;
  };
  readonly vectorDbPath?: string;
}

export interface ConcordiaCheckpointSceneCursorMetadata {
  readonly scene_index: number;
  readonly scene_round: number;
  readonly current_scene_name?: string | null;
}

export interface ConcordiaCheckpointRuntimeCursorMetadata {
  readonly current_step: number;
  readonly start_step: number;
  readonly max_steps: number;
  readonly last_acting_agent?: string | null;
  readonly last_step_outcome?: string | null;
  readonly engine_type?: string | null;
}

export interface ConcordiaCheckpointReplayCursorMetadata {
  readonly replay_cursor: number;
  readonly replay_event_count: number;
  readonly last_event_id?: string | null;
  readonly resume_behavior?: string | null;
  readonly source_step?: number;
}

export interface ConcordiaCheckpointWorldStateRefsMetadata {
  readonly source: string;
  readonly gm_state_key?: string | null;
  readonly entity_state_keys: readonly string[];
  readonly authoritative_snapshot_ref?: string | null;
}

export interface ConcordiaCheckpointSubsystemStateMetadata {
  readonly resumed: readonly string[];
  readonly reset: readonly string[];
}

export interface ConcordiaCheckpointStatusMetadata {
  readonly checkpoint_id: string;
  readonly checkpoint_path: string;
  readonly schema_version: number;
  readonly world_id: string;
  readonly workspace_id: string;
  readonly simulation_id: string;
  readonly lineage_id?: string | null;
  readonly parent_simulation_id?: string | null;
  readonly step: number;
  readonly timestamp: number;
  readonly max_steps: number;
  readonly scene_cursor: ConcordiaCheckpointSceneCursorMetadata | null;
  readonly runtime_cursor: ConcordiaCheckpointRuntimeCursorMetadata;
  readonly replay_cursor: ConcordiaCheckpointReplayCursorMetadata;
  readonly world_state_refs: ConcordiaCheckpointWorldStateRefsMetadata;
  readonly memory_namespace_refs?: Record<string, unknown>;
  readonly subsystem_state: ConcordiaCheckpointSubsystemStateMetadata;
}

export interface ConcordiaCheckpointMetadata {
  readonly checkpointId?: string | null;
  readonly checkpointPath?: string | null;
  readonly checkpointSchemaVersion?: number | null;
  readonly checkpointSimulationId?: string | null;
  readonly checkpointLineageId?: string | null;
  readonly checkpointParentSimulationId?: string | null;
  readonly checkpointWorldId?: string | null;
  readonly checkpointWorkspaceId?: string | null;
  readonly resumedFromStep?: number | null;
  readonly sceneCursor?: ConcordiaCheckpointSceneCursorMetadata | null;
  readonly runtimeCursor?: ConcordiaCheckpointRuntimeCursorMetadata | null;
  readonly replayCursor?: ConcordiaCheckpointReplayCursorMetadata | null;
  readonly worldStateRefs?: ConcordiaCheckpointWorldStateRefsMetadata | null;
  readonly subsystemRestore?: ConcordiaCheckpointSubsystemStateMetadata | null;
  readonly checkpointStatus?: ConcordiaCheckpointStatusMetadata | null;
  readonly checkpointManifest?: Record<string, unknown> | null;
}

export interface ConcordiaMemoryHostServices {
  resolveWorldContext(input: {
    worldId: string;
    workspaceId: string;
    simulationId?: string;
    lineageId?: string | null;
    parentSimulationId?: string | null;
    effectiveStorageKey?: string;
    logStorageKey?: string;
    scopedWorkspaceId?: string;
    continuityMode?: "isolated" | "lineage_resume";
    checkpointMetadata?: ConcordiaCheckpointMetadata | null;
  }): Promise<ConcordiaWorldMemoryHostServices>;
}

export interface ConcordiaRuntimeHostServices {
  readonly llm: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly model?: string;
    readonly baseUrl?: string;
  };
  readonly defaults?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly model?: string;
    readonly baseUrl?: string;
  };
}

export type ChannelHostServices = Readonly<Record<string, unknown>> & {
  readonly concordia_memory?: ConcordiaMemoryHostServices;
  readonly concordia_runtime?: ConcordiaRuntimeHostServices;
};

export function createChannelHostServices(params: {
  readonly config: GatewayConfig;
  readonly logger: Logger;
}): ChannelHostServices | undefined {
  const services: Record<string, unknown> = {};

  if (params.config.llm) {
    services.concordia_runtime = {
      llm: {
        provider: params.config.llm.provider,
        apiKey: params.config.llm.apiKey,
        model: params.config.llm.model,
        baseUrl: params.config.llm.baseUrl,
      },
      defaults: {
        provider: params.config.llm.provider,
        apiKey: params.config.llm.apiKey,
        model: params.config.llm.provider === "grok"
          ? DEFAULT_CONCORDIA_GM_MODEL
          : params.config.llm.model,
        baseUrl: params.config.llm.baseUrl,
      },
    } satisfies ConcordiaRuntimeHostServices;
  }

  services.concordia_memory = createConcordiaMemoryHostServices(params);

  return services as ChannelHostServices;
}

function createConcordiaMemoryHostServices(params: {
  readonly config: GatewayConfig;
  readonly logger: Logger;
}): ConcordiaMemoryHostServices {
  const worldContexts = new Map<string, Promise<ConcordiaWorldMemoryHostServices>>();
  let sharedBackendPromise: Promise<MemoryBackend> | null = null;

  const getSharedBackend = async (): Promise<MemoryBackend> => {
    if (!sharedBackendPromise) {
      sharedBackendPromise = createMemoryBackend({
        config: params.config,
        logger: params.logger,
      });
    }
    return sharedBackendPromise;
  };

  return {
    async resolveWorldContext(input) {
      const effectiveStorageKey = input.effectiveStorageKey ?? input.worldId;
      const logStorageKey = input.logStorageKey ?? effectiveStorageKey;
      const scopedWorkspaceId = input.scopedWorkspaceId ?? input.workspaceId;
      const cacheKey = `${scopedWorkspaceId}::${effectiveStorageKey}::${logStorageKey}`;
      const existing = worldContexts.get(cacheKey);
      if (existing) {
        return existing;
      }

      const created = createConcordiaWorldContext({
        ...params,
        worldId: input.worldId,
        effectiveStorageKey,
        logStorageKey,
        workspaceId: input.workspaceId,
        scopedWorkspaceId,
        getSharedBackend,
      }).catch((error) => {
        worldContexts.delete(cacheKey);
        throw error;
      });
      worldContexts.set(cacheKey, created);
      return created;
    },
  };
}

async function createConcordiaWorldContext(params: {
  readonly config: GatewayConfig;
  readonly logger: Logger;
  readonly worldId: string;
  readonly effectiveStorageKey: string;
  readonly logStorageKey: string;
  readonly workspaceId: string;
  readonly scopedWorkspaceId: string;
  readonly getSharedBackend: () => Promise<MemoryBackend>;
}): Promise<ConcordiaWorldMemoryHostServices> {
  const worldBackend = await createMemoryBackend({
    config: params.config,
    logger: params.logger,
    worldId: params.effectiveStorageKey,
  });
  const sharedBackend = await params.getSharedBackend();

  const identityManager = new AgentIdentityManager({
    memoryBackend: worldBackend,
    logger: params.logger,
  });
  const socialMemory = new SocialMemoryManager({
    memoryBackend: worldBackend,
    logger: params.logger,
  });
  const graph = new MemoryGraph(worldBackend);
  const traceLogger = new MemoryTraceLogger(params.logger);
  const sharedMemory = new SharedMemoryBackend({
    memoryBackend: sharedBackend,
    logger: params.logger,
  });
  const runtimeProceduralMemory = new ProceduralMemory({
    memoryBackend: worldBackend,
    logger: params.logger,
  });

  const vectorDbPath = resolveWorldVectorDbPath(params.effectiveStorageKey);
  const worldDir = dirname(vectorDbPath);
  const logDir = dirname(resolveWorldVectorDbPath(params.logStorageKey));
  const curatedMemory = new CuratedMemoryManager(join(worldDir, "MEMORY.md"));
  const runtimeDailyLogManager = new DailyLogManager(join(logDir, "logs"));

  const embeddingProvider = await createEmbeddingProvider({
    preferred: params.config.memory?.embeddingProvider,
    apiKey: params.config.memory?.embeddingApiKey ?? params.config.llm?.apiKey,
    baseUrl: params.config.memory?.embeddingBaseUrl,
    model: params.config.memory?.embeddingModel,
  });
  const reflectionProviderPromise = params.config.llm
    ? createSingleLLMProvider(params.config.llm, [], params.logger)
    : Promise.resolve(null);
  const vectorStore = new SqliteVectorBackend({
    dbPath: vectorDbPath,
    dimension: embeddingProvider.dimension,
  });

  let ingestionEngine:
    | ConcordiaWorldMemoryHostServices["ingestionEngine"]
    | undefined;
  let retriever: ConcordiaWorldMemoryHostServices["retriever"] | undefined;

  if (embeddingProvider.name !== "noop") {
    const semanticRetriever = new SemanticMemoryRetriever({
      vectorBackend: vectorStore,
      embeddingProvider,
      curatedMemory,
      workspaceId: params.scopedWorkspaceId,
      logger: params.logger,
    });
    const engine = new MemoryIngestionEngine({
      embeddingProvider,
      vectorStore,
      logManager: runtimeDailyLogManager,
      curatedMemory,
      generateSummaries: false,
      enableDailyLogs: true,
      enableEntityExtraction: false,
      logger: params.logger,
    });

    ingestionEngine = {
      ingestTurn(sessionId, userMessage, agentResponse, metadata) {
        return engine.ingestTurn(
          sessionId,
          userMessage,
          agentResponse,
          metadata,
        );
      },
    };

    retriever = {
      retrieve(message, sessionId) {
        return semanticRetriever.retrieve(message, sessionId);
      },
      async retrieveDetailed(message, sessionId) {
        const result = await semanticRetriever.retrieveDetailed(message, sessionId);
        return {
          content: result.content,
          estimatedTokens: result.estimatedTokens,
          entries: result.entries.map((entry) => ({
            entry: {
              id: entry.entry.id,
              role: entry.entry.role,
            },
            role: entry.role,
          })),
        };
      },
    };
  }

  const lifecycle: ConcordiaWorldMemoryHostServices["lifecycle"] = {
    async reflectAgent(input) {
      const llmProvider = await reflectionProviderPromise;
      if (!llmProvider) {
        return false;
      }
      const recentHistory = await worldBackend.getThread(input.sessionId, 20);
      const result = await runReflection({
        llmProvider,
        identityManager,
        agentId: input.agentId,
        workspaceId: input.workspaceId ?? params.scopedWorkspaceId,
        recentHistory: recentHistory.map((entry) => ({
          role: entry.role,
          content: entry.content,
        })),
        logger: params.logger,
      });
      return result !== null;
    },
    consolidate(input) {
      return runConsolidation(
        {
          memoryBackend: worldBackend,
          vectorStore,
          embeddingProvider,
          graph,
          logger: params.logger,
        },
        input?.workspaceId ?? params.scopedWorkspaceId,
      );
    },
    retain() {
      return runRetention({
        memoryBackend: worldBackend,
        logManager: runtimeDailyLogManager,
        logger: params.logger,
      });
    },
  };

  return {
    memoryBackend: worldBackend,
    identityManager,
    socialMemory,
    proceduralMemory: createProceduralMemoryAdapter(runtimeProceduralMemory),
    graph: createGraphAdapter(graph),
    sharedMemory: {
      async writeFact(input) {
        const fact = await sharedMemory.writeFact({
          scope: toSharedScope(input.scope),
          content: input.content,
          author: input.author,
          userId: input.userId,
          visibility: input.visibility,
          lineageId: input.lineageId ?? undefined,
          trustSource: input.trustSource,
          confidence: input.confidence,
          provenance: input.provenance?.map((source) => ({
            type: source.type,
            source: toConcordiaTrustSource(source.source),
            sourceId: source.source_id,
            simulationId: source.simulation_id,
            lineageId: source.lineage_id,
            parentSimulationId: source.parent_simulation_id,
            worldId: source.world_id,
            workspaceId: source.workspace_id,
            eventId: source.event_id,
            timestamp: source.timestamp,
            metadata: source.metadata ?? undefined,
          })),
          authorization: input.authorization ? {
            mode: input.authorization.mode,
            approved: input.authorization.approved,
            approvedBy: input.authorization.approved_by ?? undefined,
            approvedAt: input.authorization.approved_at ?? undefined,
            reason: input.authorization.reason ?? undefined,
          } : undefined,
          sourceWorldId: params.effectiveStorageKey,
        });
        return {
          id: fact.id,
          content: fact.content,
          author: fact.author,
          userId: fact.userId,
          visibility: fact.visibility,
          trust: {
            source: toConcordiaTrustSource(fact.trustSource),
            score: fact.trustScore,
            confidence: fact.confidence,
            threshold: 0.7,
          },
          provenance: fact.provenance.map((source) => ({
            type: source.type,
            source: toConcordiaTrustSource(source.source),
            source_id: source.sourceId,
            simulation_id: source.simulationId ?? null,
            lineage_id: source.lineageId ?? null,
            parent_simulation_id: source.parentSimulationId ?? null,
            world_id: source.worldId ?? null,
            workspace_id: source.workspaceId ?? null,
            event_id: source.eventId ?? null,
            timestamp: source.timestamp,
            metadata: source.metadata ?? null,
          })),
          authorization: {
            mode: fact.authorization.mode,
            approved: fact.authorization.approved,
            approved_by: fact.authorization.approvedBy ?? null,
            approved_at: fact.authorization.approvedAt ?? null,
            reason: fact.authorization.reason ?? null,
          },
        };
      },
      async getFacts(scope, userId, options) {
        const facts = await sharedMemory.getFacts(toSharedScope(scope), userId, 50, {
          lineageId: options?.lineageId,
          minTrustScore: options?.minTrustScore,
          allowedVisibilities: options?.allowedVisibilities,
        });
        return facts.map((fact) => ({
          id: fact.id,
          content: fact.content,
          author: fact.author,
          userId: fact.userId,
          visibility: fact.visibility,
          trust: {
            source: toConcordiaTrustSource(fact.trustSource),
            score: fact.trustScore,
            confidence: fact.confidence,
            threshold: 0.7,
          },
          provenance: fact.provenance.map((source) => ({
            type: source.type,
            source: toConcordiaTrustSource(source.source),
            source_id: source.sourceId,
            simulation_id: source.simulationId ?? null,
            lineage_id: source.lineageId ?? null,
            parent_simulation_id: source.parentSimulationId ?? null,
            world_id: source.worldId ?? null,
            workspace_id: source.workspaceId ?? null,
            event_id: source.eventId ?? null,
            timestamp: source.timestamp,
            metadata: source.metadata ?? null,
          })),
          authorization: {
            mode: fact.authorization.mode,
            approved: fact.authorization.approved,
            approved_by: fact.authorization.approvedBy ?? null,
            approved_at: fact.authorization.approvedAt ?? null,
            reason: fact.authorization.reason ?? null,
          },
        }));
      },
    },
    traceLogger,
    dailyLogManager: {
      append(sessionId, entry) {
        return runtimeDailyLogManager.append(
          sessionId,
          "assistant",
          formatSimulationDailyLogEntry(entry),
        );
      },
    },
    ingestionEngine,
    retriever,
    lifecycle,
    vectorDbPath,
  };
}

function createProceduralMemoryAdapter(
  runtimeProceduralMemory: ProceduralMemory,
): ConcordiaWorldMemoryHostServices["proceduralMemory"] {
  return {
    record(input) {
      return runtimeProceduralMemory.record({
        name: input.name,
        trigger: input.trigger,
        workspaceId: input.workspaceId,
        toolCalls: input.steps.map((step, index) => ({
          name: `simulation_step_${index + 1}`,
          args: { step },
          result: step,
        })),
      });
    },
    async retrieve(triggerText, workspaceId) {
      const entries = await runtimeProceduralMemory.retrieve(
        triggerText,
        workspaceId,
      );
      return entries.map((entry) => ({
        name: entry.name,
        trigger: entry.trigger,
        steps: entry.steps.map((step) => step.description),
        confidence: entry.confidence,
      }));
    },
    formatForPrompt(procedures) {
      return runtimeProceduralMemory.formatForPrompt(
        procedures.map((procedure) => ({
          id: procedure.name,
          name: procedure.name,
          trigger: procedure.trigger,
          steps: procedure.steps.map((step, index) => ({
            toolName: `simulation_step_${index + 1}`,
            argsPattern: JSON.stringify({ step }),
            description: step,
          })),
          successCount: 1,
          failureCount: 0,
          confidence: procedure.confidence,
          lastUsed: Date.now(),
          createdAt: Date.now(),
        })),
      );
    },
  };
}

function createGraphAdapter(
  graph: MemoryGraph,
): ConcordiaWorldMemoryHostServices["graph"] {
  return {
    async upsertNode(input) {
      const node = await graph.upsertNode({
        content: input.content,
        sessionId: input.sessionId,
        tags: input.tags,
        entityName: input.entityName,
        entityType: input.entityType,
        workspaceId: input.workspaceId,
        metadata: input.metadata,
        provenance: input.provenance.map((source) => ({
          type: source.type as Parameters<MemoryGraph["upsertNode"]>[0]["provenance"][number]["type"],
          sourceId: source.sourceId,
          description: source.description,
          metadata: source.metadata,
        })),
      });
      return {
        id: node.id,
        content: node.content,
        entityName: node.entityName,
        entityType: node.entityType,
      };
    },
    async findByEntity(name, workspaceId) {
      const result = await graph.findByEntity(name, workspaceId);
      return result.nodes.map((node) => ({
        id: node.id,
        content: node.content,
        entityName: node.entityName,
        entityType: node.entityType,
      }));
    },
    async getRelatedEntities(nodeId, depth) {
      const related = await graph.getRelatedEntities(nodeId, depth);
      return related.map((node) => ({
        id: node.id,
        content: node.content,
        entityName: node.entityName,
      }));
    },
    async updateEdge(edgeId, update) {
      await graph.updateEdge(edgeId, update);
    },
    addEdge(params) {
      return graph.addEdge({
        fromId: params.sourceId,
        toId: params.targetId,
        type: params.type as Parameters<MemoryGraph["addEdge"]>[0]["type"],
        metadata: params.content ? { content: params.content } : undefined,
        validFrom: params.validFrom,
        validUntil: params.validUntil,
      });
    },
  };
}

function formatSimulationDailyLogEntry(entry: {
  timestamp: number;
  type: string;
  step?: number;
  actingAgent?: string;
  content: string;
}): string {
  const parts = [`[simulation:${entry.type}]`];
  if (typeof entry.step === "number") {
    parts.push(`step=${entry.step}`);
  }
  if (entry.actingAgent) {
    parts.push(`agent=${entry.actingAgent}`);
  }
  return `${parts.join(" ")} ${entry.content}`.trim();
}

function toSharedScope(scope: string): "user" | "organization" | "capability" {
  if (scope === "organization" || scope === "capability" || scope === "user") {
    return scope;
  }
  return "user";
}

function toConcordiaTrustSource(source: string): "system" | "agent" | "user" | "external" {
  switch (source) {
    case "system":
    case "agent":
    case "user":
    case "external":
      return source;
    case "tool":
    case "unknown":
    default:
      return "external";
  }
}
