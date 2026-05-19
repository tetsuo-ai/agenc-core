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

  append(entry: IndexedLogEntry): void {
    const sanitized = redactSecretsInValue(entry) as IndexedLogEntry;
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
