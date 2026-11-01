import type { StateSqliteDriver } from "./sqlite-driver.js";
import { redactSecretsInValue } from "../secrets/index.js";

export interface IndexedLogEntry {
  readonly timestamp: string;
  readonly level: string;
  readonly scope?: string;
  readonly threadId?: string;
  readonly eventType?: string;
  readonly message: string;
  readonly payload?: unknown;
}

export class LogsRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  /**
   * Index one entry of the JSONL error log. The index is for diagnostics:
   * nothing on a recovery or decision path reads it, so it commits at NORMAL
   * (`observational`) instead of an fsync on the path of the turn whose
   * warning it records. A process crash keeps it; a power loss before the
   * logs database's next checkpoint can drop the newest entries.
   */
  append(entry: IndexedLogEntry): void {
    const sanitized = redactSecretsInValue(entry) as IndexedLogEntry;
    this.driver.logsTransaction(() => {
      this.driver
        .prepareLogs(
          `INSERT INTO logs (
            timestamp, level, scope, thread_id, event_type, message, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sanitized.timestamp,
          sanitized.level,
          sanitized.scope ?? null,
          sanitized.threadId ?? null,
          sanitized.eventType ?? null,
          sanitized.message,
          JSON.stringify(sanitized.payload ?? {}),
        );
    }, "observational");
  }

  tryAppend(entry: IndexedLogEntry): boolean {
    try {
      this.append(entry);
      return true;
    } catch {
      return false;
    }
  }
}
