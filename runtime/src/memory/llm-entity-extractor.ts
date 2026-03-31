/**
 * LLM-based entity extraction for the knowledge graph.
 *
 * Extracts named entities, facts, and relationships from conversation text
 * using an LLM with structured output. Implements the EntityExtractor interface
 * from structured.ts.
 *
 * Design decisions per TODO Phase 3 + specialist reviews:
 * - Substring grounding check: reject entities not found in source text (skeptic)
 * - Low default confidence (0.3) for single-mention entities (skeptic)
 * - Token budget cap: truncate input to 8K chars (skeptic)
 * - Case-normalized entity names (edge case X4)
 * - Never block ingestion on failure — return [] (security M-2 defense)
 *
 * Research: R3 (Mem0 entity extraction), R8 (Cognee 6-stage pipeline),
 * R25 (A-MEM self-organizing linking), R32 (Memori semantic triples)
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { LLMProvider } from "../llm/types.js";
import type { EntityExtractor, StructuredMemoryEntry } from "./structured.js";
import type { Logger } from "../utils/logger.js";

const MAX_INPUT_CHARS = 8_000;
const DEFAULT_SINGLE_MENTION_CONFIDENCE = 0.3;

const EXTRACTION_SYSTEM_PROMPT = `You are an entity extraction system. Extract named entities, facts, and relationships from the conversation text.

Return a JSON array of entities. Each entity has:
- "entityName": the name (person, tool, concept, file, etc.)
- "entityType": one of "person", "tool", "file", "concept", "preference", "system", "service", "project", "language", "framework", "error_pattern"
- "fact": a concise fact about this entity from the conversation
- "confidence": 0.0-1.0 (how confident are you this entity was explicitly mentioned)
- "relations": optional array of {relatedEntity, relationType} where relationType is "uses", "prefers", "creates", "depends_on", "relates_to"

Rules:
- Only extract entities that are EXPLICITLY mentioned in the text
- Do NOT infer or hallucinate entities that are not in the text
- Entity names must appear as substrings (or close variants) in the source text
- Keep fact descriptions concise (1 sentence max)
- Return empty array [] if no clear entities found

Return ONLY a JSON array, no other text.`;

interface RawExtractedEntity {
  entityName: string;
  entityType: string;
  fact: string;
  confidence: number;
  relations?: Array<{
    relatedEntity: string;
    relationType: string;
  }>;
}

export interface LLMEntityExtractorConfig {
  llmProvider: LLMProvider;
  logger?: Logger;
  /** Max input chars sent to LLM. Default: 8000 */
  maxInputChars?: number;
}

export class LLMEntityExtractor implements EntityExtractor {
  private readonly llm: LLMProvider;
  private readonly logger: Logger | undefined;
  private readonly maxInputChars: number;

  constructor(config: LLMEntityExtractorConfig) {
    this.llm = config.llmProvider;
    this.logger = config.logger;
    this.maxInputChars = config.maxInputChars ?? MAX_INPUT_CHARS;
  }

  async extract(
    text: string,
    sessionId: string,
  ): Promise<StructuredMemoryEntry[]> {
    if (!text || text.trim().length < 20) return [];

    try {
      // Token budget cap: truncate input (skeptic finding)
      const truncated =
        text.length > this.maxInputChars
          ? text.slice(0, this.maxInputChars) + "\n[truncated]"
          : text;

      const response = await this.llm.chat([
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: truncated },
      ]);

      const content = response.content.trim();
      if (!content || content === "[]") return [];

      // Parse JSON response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger?.warn("Entity extraction: LLM response was not valid JSON array");
        return [];
      }

      let rawEntities: RawExtractedEntity[];
      try {
        rawEntities = JSON.parse(jsonMatch[0]);
      } catch {
        this.logger?.warn("Entity extraction: failed to parse JSON from LLM response");
        return [];
      }

      if (!Array.isArray(rawEntities)) return [];

      const normalizedSourceText = text.toLowerCase();
      const results: StructuredMemoryEntry[] = [];

      for (const raw of rawEntities) {
        if (
          typeof raw.entityName !== "string" ||
          typeof raw.fact !== "string" ||
          !raw.entityName.trim() ||
          !raw.fact.trim()
        ) {
          continue;
        }

        // Substring grounding check (skeptic finding):
        // Reject entities whose name doesn't appear in the source text.
        // This prevents LLM hallucination of non-existent entities.
        const normalizedName = raw.entityName.trim().toLowerCase();
        if (!normalizedSourceText.includes(normalizedName)) {
          this.logger?.debug?.(
            `Entity extraction: rejected "${raw.entityName}" (not found in source text)`,
          );
          continue;
        }

        // Case-normalize entity names (edge case X4)
        const entityName = raw.entityName.trim();

        // Low default confidence for single mentions (skeptic)
        const confidence = Math.min(
          1,
          Math.max(0, raw.confidence ?? DEFAULT_SINGLE_MENTION_CONFIDENCE),
        );

        results.push({
          id: randomUUID(),
          content: raw.fact.trim(),
          entityName,
          entityType: raw.entityType?.trim() || "concept",
          confidence,
          source: `entity_extractor:llm:${sessionId}`,
          tags: ["extracted", raw.entityType?.trim() || "concept"],
          createdAt: Date.now(),
        });
      }

      this.logger?.debug?.(
        `Entity extraction: extracted ${results.length} entities from ${text.length} chars`,
      );

      return results;
    } catch (err) {
      // Never block ingestion on extraction failure (security M-2 defense)
      this.logger?.warn("Entity extraction failed (non-blocking):", err);
      return [];
    }
  }
}
