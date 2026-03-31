/**
 * Procedural memory — records and retrieves successful multi-step tool sequences.
 *
 * When an agent successfully completes a task (tool-grounded evidence), the tool
 * call chain is normalized and stored as a reusable procedure. Future similar
 * requests can retrieve relevant procedures as planner context.
 *
 * Research: R28 (MACLA hierarchical procedural memory, AAMAS 2026),
 * R37 (Mem^p step-by-step procedural memory), R4 (MIRIX procedural type)
 *
 * @module
 */

import { createHash, randomUUID } from "node:crypto";
import type { MemoryBackend } from "./types.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { Logger } from "../utils/logger.js";

/** A recorded procedure — a normalized sequence of tool steps. */
export interface ProceduralMemoryEntry {
  readonly id: string;
  readonly name: string;
  /** Natural language description of when this procedure applies. */
  readonly trigger: string;
  /** Ordered list of tool call patterns. */
  readonly steps: readonly ProceduralStep[];
  /** Number of times this procedure was used successfully. */
  readonly successCount: number;
  /** Number of times this procedure was attempted but failed. */
  readonly failureCount: number;
  /** Confidence score derived from success/failure ratio. */
  readonly confidence: number;
  /** Last time this procedure was used. */
  readonly lastUsed: number;
  /** Workspace scope. */
  readonly workspaceId?: string;
  readonly createdAt: number;
}

export interface ProceduralStep {
  readonly toolName: string;
  /** Normalized argument patterns (specific paths replaced with {workspace}/...). */
  readonly argsPattern: string;
  /** Human-readable description of what this step does. */
  readonly description: string;
}

export interface RecordProcedureInput {
  /** Brief name for the procedure. */
  readonly name: string;
  /** When to apply (natural language trigger). */
  readonly trigger: string;
  /** Raw tool call records from the successful execution. */
  readonly toolCalls: readonly {
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly result?: string;
    readonly isError?: boolean;
  }[];
  /** Workspace root for path normalization. */
  readonly workspacePath?: string;
  readonly workspaceId?: string;
}

export interface ProceduralMemoryConfig {
  readonly memoryBackend: MemoryBackend;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly logger?: Logger;
  /** KV key prefix. Default: "procedure:" */
  readonly keyPrefix?: string;
  /** Max stored procedures per workspace. Default: 100. */
  readonly maxProcedures?: number;
}

const DEFAULT_KEY_PREFIX = "procedure:";
const DEFAULT_MAX_PROCEDURES = 100;

/**
 * Procedural memory manager — records and retrieves tool sequence patterns.
 */
export class ProceduralMemory {
  private readonly backend: MemoryBackend;
  private readonly embedding: EmbeddingProvider | undefined;
  private readonly logger: Logger | undefined;
  private readonly keyPrefix: string;
  private readonly maxProcedures: number;

  constructor(config: ProceduralMemoryConfig) {
    this.backend = config.memoryBackend;
    this.embedding = config.embeddingProvider;
    this.logger = config.logger;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.maxProcedures = config.maxProcedures ?? DEFAULT_MAX_PROCEDURES;
  }

  /**
   * Record a successful tool sequence as a procedure.
   * Normalizes paths, deduplicates against existing procedures.
   */
  async record(input: RecordProcedureInput): Promise<ProceduralMemoryEntry | null> {
    if (input.toolCalls.length === 0) return null;

    // Filter to successful tool calls only
    const successfulCalls = input.toolCalls.filter((tc) => !tc.isError);
    if (successfulCalls.length === 0) return null;

    // Normalize tool call args (replace workspace paths with patterns)
    const steps: ProceduralStep[] = successfulCalls.map((tc) => ({
      toolName: tc.name,
      argsPattern: normalizeArgs(tc.args, input.workspacePath),
      description: `${tc.name}(${summarizeArgs(tc.args)})`,
    }));

    // Check for existing similar procedure
    const stepsHash = hashSteps(steps);
    const existingKey = `${this.keyPrefix}${input.workspaceId ?? "default"}:${stepsHash}`;
    const existing = await this.backend.get<ProceduralMemoryEntry>(existingKey);

    if (existing) {
      // Update success count
      const updated: ProceduralMemoryEntry = {
        ...existing,
        successCount: existing.successCount + 1,
        confidence: computeConfidence(existing.successCount + 1, existing.failureCount),
        lastUsed: Date.now(),
      };
      await this.backend.set(existingKey, updated);
      this.logger?.debug?.(`Procedural memory: updated "${existing.name}" (success: ${updated.successCount})`);
      return updated;
    }

    // Create new procedure
    const entry: ProceduralMemoryEntry = {
      id: randomUUID(),
      name: input.name,
      trigger: input.trigger,
      steps,
      successCount: 1,
      failureCount: 0,
      confidence: computeConfidence(1, 0),
      lastUsed: Date.now(),
      workspaceId: input.workspaceId,
      createdAt: Date.now(),
    };

    const key = `${this.keyPrefix}${input.workspaceId ?? "default"}:${stepsHash}`;
    await this.backend.set(key, entry);
    this.logger?.debug?.(`Procedural memory: recorded "${entry.name}" (${steps.length} steps)`);
    return entry;
  }

  /**
   * Record a failed procedure attempt.
   */
  async recordFailure(
    procedureId: string,
    workspaceId?: string,
  ): Promise<void> {
    const prefix = `${this.keyPrefix}${workspaceId ?? "default"}:`;
    const keys = await this.backend.listKeys(prefix);

    for (const key of keys) {
      const entry = await this.backend.get<ProceduralMemoryEntry>(key);
      if (entry?.id === procedureId) {
        const updated: ProceduralMemoryEntry = {
          ...entry,
          failureCount: entry.failureCount + 1,
          confidence: computeConfidence(entry.successCount, entry.failureCount + 1),
        };
        await this.backend.set(key, updated);
        break;
      }
    }
  }

  /**
   * Retrieve relevant procedures for a given task description.
   * Returns procedures sorted by relevance * confidence.
   */
  async retrieve(
    taskDescription: string,
    workspaceId?: string,
    limit = 3,
  ): Promise<ProceduralMemoryEntry[]> {
    const prefix = `${this.keyPrefix}${workspaceId ?? "default"}:`;
    const keys = await this.backend.listKeys(prefix);
    const candidates: Array<{
      entry: ProceduralMemoryEntry;
      relevance: number;
    }> = [];

    const queryTokens = new Set(
      taskDescription.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [],
    );

    for (const key of keys) {
      const entry = await this.backend.get<ProceduralMemoryEntry>(key);
      if (!entry || entry.confidence < 0.1) continue;

      // Compute relevance via token overlap
      const triggerTokens = new Set(
        entry.trigger.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [],
      );
      let overlap = 0;
      for (const t of queryTokens) {
        if (triggerTokens.has(t)) overlap++;
      }
      const relevance =
        queryTokens.size > 0 ? overlap / queryTokens.size : 0;

      if (relevance > 0) {
        candidates.push({ entry, relevance });
      }
    }

    // Sort by relevance * confidence
    candidates.sort(
      (a, b) =>
        b.relevance * b.entry.confidence - a.relevance * a.entry.confidence,
    );

    return candidates.slice(0, limit).map((c) => c.entry);
  }

  /**
   * Format procedures for prompt injection.
   */
  formatForPrompt(procedures: readonly ProceduralMemoryEntry[]): string {
    if (procedures.length === 0) return "";
    const lines = procedures.map((p) => {
      const steps = p.steps
        .map((s, i) => `  ${i + 1}. ${s.description}`)
        .join("\n");
      return `**${p.name}** (confidence: ${p.confidence.toFixed(2)}, used: ${p.successCount} times)\nTrigger: ${p.trigger}\nSteps:\n${steps}`;
    });
    return `## Previously Successful Approaches\n\n${lines.join("\n\n")}`;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeArgs(
  args: Record<string, unknown>,
  workspacePath?: string,
): string {
  const normalized = { ...args };
  if (workspacePath) {
    for (const [key, value] of Object.entries(normalized)) {
      if (typeof value === "string" && value.includes(workspacePath)) {
        normalized[key] = value.replace(workspacePath, "{workspace}");
      }
    }
  }
  return JSON.stringify(normalized);
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).slice(0, 3);
  return keys
    .map((k) => {
      const v = args[k];
      if (typeof v === "string" && v.length > 40) {
        return `${k}: "${v.slice(0, 37)}..."`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join(", ");
}

function hashSteps(steps: readonly ProceduralStep[]): string {
  const key = steps.map((s) => `${s.toolName}:${s.argsPattern}`).join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function computeConfidence(success: number, failure: number): number {
  const total = success + failure;
  if (total === 0) return 0.5;
  return Math.min(0.99, success / total);
}
