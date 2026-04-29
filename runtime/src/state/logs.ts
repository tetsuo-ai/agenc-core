import type { StateSqliteDriver } from "./sqlite-driver.js";

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
    this.driver
      .prepareLogs(
        `INSERT INTO logs (
          timestamp, level, scope, thread_id, event_type, message, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.timestamp,
        entry.level,
        entry.scope ?? null,
        entry.threadId ?? null,
        entry.eventType ?? null,
        entry.message,
        JSON.stringify(entry.payload ?? {}),
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
