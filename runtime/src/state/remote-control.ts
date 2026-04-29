import type { StateSqliteDriver } from "./sqlite-driver.js";

interface RemoteControlRow {
  readonly value_json: string;
}

export class RemoteControlStorage {
  constructor(
    private readonly driver: StateSqliteDriver,
    private readonly projectKey: string,
  ) {}

  get<T = unknown>(namespace: string, key: string): T | undefined {
    const row = this.driver
      .prepareState<[string, string, string], RemoteControlRow>(
        `SELECT value_json
         FROM remote_control_storage
         WHERE project_key = ? AND namespace = ? AND key = ?`,
      )
      .get(this.projectKey, namespace, key);
    return row === undefined ? undefined : (JSON.parse(row.value_json) as T);
  }

  set(namespace: string, key: string, value: unknown): void {
    const now = new Date().toISOString();
    this.driver
      .prepareState(
        `INSERT INTO remote_control_storage (
          project_key, namespace, key, value_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_key, namespace, key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at`,
      )
      .run(this.projectKey, namespace, key, JSON.stringify(value), now, now);
  }

  delete(namespace: string, key: string): void {
    this.driver
      .prepareState<[string, string, string]>(
        `DELETE FROM remote_control_storage
         WHERE project_key = ? AND namespace = ? AND key = ?`,
      )
      .run(this.projectKey, namespace, key);
  }
}
