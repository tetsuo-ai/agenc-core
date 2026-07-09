/**
 * HEARTBEAT.md reader (TODO task 14). Reads the workspace HEARTBEAT.md fresh on
 * each tick (so edits take effect without a restart); returns null when absent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { HeartbeatFileReader } from "./types.js";

export const HEARTBEAT_FILENAME = "HEARTBEAT.md";

export class WorkspaceHeartbeatFileReader implements HeartbeatFileReader {
  readonly #path: string;

  constructor(workspaceDir: string) {
    this.#path = join(workspaceDir, HEARTBEAT_FILENAME);
  }

  read(): string | null {
    if (!existsSync(this.#path)) return null;
    try {
      return readFileSync(this.#path, "utf8");
    } catch {
      return null;
    }
  }
}
