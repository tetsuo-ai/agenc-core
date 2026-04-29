import type { MemoryBackend } from "../memory/types.js";
import type { EffectRecord } from "./effects.js";
import { migrateEffectRecord } from "./migrations.js";

const EFFECT_KEY_PREFIX = "workflow:effect:";
const EFFECT_IDEMPOTENCY_KEY_PREFIX = "workflow:effect:idempotency:";
const EFFECT_SESSION_INDEX_PREFIX = "workflow:effect:index:session:";
const EFFECT_RUN_INDEX_PREFIX = "workflow:effect:index:run:";
const EFFECT_PIPELINE_INDEX_PREFIX = "workflow:effect:index:pipeline:";

export interface EffectStorage {
  save(record: EffectRecord): Promise<void>;
  get(effectId: string): Promise<EffectRecord | undefined>;
  getByIdempotencyKey(idempotencyKey: string): Promise<EffectRecord | undefined>;
  listBySession(sessionId: string, limit?: number): Promise<readonly EffectRecord[]>;
  listByRun(runId: string, limit?: number): Promise<readonly EffectRecord[]>;
  listByPipeline(
    pipelineId: string,
    limit?: number,
  ): Promise<readonly EffectRecord[]>;
}

export class MemoryBackendEffectStorage implements EffectStorage {
  constructor(
    private readonly backend: MemoryBackend,
    private readonly ttlMs = 30 * 24 * 60 * 60_000,
  ) {}

  async save(record: EffectRecord): Promise<void> {
    const migrated = migrateEffectRecord(record).value;
    await this.backend.set(this.effectKey(record.id), migrated, this.ttlMs);
    await this.backend.set(
      this.idempotencyKey(migrated.idempotencyKey),
      migrated.id,
      this.ttlMs,
    );
    await Promise.all([
      this.appendIndex(this.sessionIndexKey(migrated.scope.sessionId), migrated.id),
      migrated.scope.runId
        ? this.appendIndex(this.runIndexKey(migrated.scope.runId), migrated.id)
        : Promise.resolve(),
      migrated.scope.pipelineId
        ? this.appendIndex(
            this.pipelineIndexKey(migrated.scope.pipelineId),
            migrated.id,
          )
        : Promise.resolve(),
    ]);
  }

  async get(effectId: string): Promise<EffectRecord | undefined> {
    const record = await this.backend.get<EffectRecord>(this.effectKey(effectId));
    if (!record) {
      return undefined;
    }
    const migration = migrateEffectRecord(record);
    if (migration.migrated) {
      await this.save(migration.value);
    }
    return migration.value;
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EffectRecord | undefined> {
    const effectId = await this.backend.get<string>(
      this.idempotencyKey(idempotencyKey),
    );
    if (!effectId) {
      return undefined;
    }
    return this.get(effectId);
  }

  async listBySession(
    sessionId: string,
    limit?: number,
  ): Promise<readonly EffectRecord[]> {
    return this.listFromIndex(this.sessionIndexKey(sessionId), limit);
  }

  async listByRun(
    runId: string,
    limit?: number,
  ): Promise<readonly EffectRecord[]> {
    return this.listFromIndex(this.runIndexKey(runId), limit);
  }

  async listByPipeline(
    pipelineId: string,
    limit?: number,
  ): Promise<readonly EffectRecord[]> {
    return this.listFromIndex(this.pipelineIndexKey(pipelineId), limit);
  }

  private async listFromIndex(
    key: string,
    limit?: number,
  ): Promise<readonly EffectRecord[]> {
    const ids = await this.backend.get<string[]>(key);
    if (!ids || ids.length === 0) {
      return [];
    }
    const selected =
      typeof limit === "number" && limit > 0 ? ids.slice(-limit) : ids;
    const records = await Promise.all(selected.map((id) => this.get(id)));
    return records
      .filter((record): record is EffectRecord => record !== undefined)
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  private async appendIndex(key: string, effectId: string): Promise<void> {
    const existing = (await this.backend.get<string[]>(key)) ?? [];
    if (!existing.includes(effectId)) {
      await this.backend.set(key, [...existing, effectId], this.ttlMs);
    }
  }

  private effectKey(effectId: string): string {
    return `${EFFECT_KEY_PREFIX}${effectId}`;
  }

  private idempotencyKey(idempotencyKey: string): string {
    return `${EFFECT_IDEMPOTENCY_KEY_PREFIX}${idempotencyKey}`;
  }

  private sessionIndexKey(sessionId: string): string {
    return `${EFFECT_SESSION_INDEX_PREFIX}${sessionId}`;
  }

  private runIndexKey(runId: string): string {
    return `${EFFECT_RUN_INDEX_PREFIX}${runId}`;
  }

  private pipelineIndexKey(pipelineId: string): string {
    return `${EFFECT_PIPELINE_INDEX_PREFIX}${pipelineId}`;
  }
}
