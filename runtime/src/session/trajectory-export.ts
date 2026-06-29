import {
  closeSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  serializeRolloutItem,
  type RolloutItem,
} from "./rollout-item.js";

export const AGENC_TRAJECTORY_EXPORT_PATH_ENV = "AGENC_TRAJECTORY_EXPORT_PATH";
export const AGENC_TRAJECTORY_EXPORT_DIR_ENV = "AGENC_TRAJECTORY_EXPORT_DIR";
export const TRAJECTORY_EXPORT_SCHEMA_VERSION = 1;

export interface TrajectoryExportRecord {
  readonly schemaVersion: number;
  readonly exportedAtUnixMs: number;
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly item: unknown;
}

export interface TrajectoryExportSink {
  readonly enabled: boolean;
  readonly path?: string;
  writeItems(items: readonly RolloutItem[]): void;
  close(): void;
}

const DISABLED_TRAJECTORY_EXPORT: TrajectoryExportSink = Object.freeze({
  enabled: false,
  writeItems: () => {},
  close: () => {},
});

export interface CreateTrajectoryExportSinkOptions {
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly env?: NodeJS.ProcessEnv;
}

class FileTrajectoryExportSink implements TrajectoryExportSink {
  readonly enabled = true;
  readonly path: string;
  private fd: number | null;
  private disabled = false;

  constructor(path: string, private readonly sessionId: string, private readonly rolloutPath: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a", 0o600);
  }

  writeItems(items: readonly RolloutItem[]): void {
    if (this.disabled || this.fd === null || items.length === 0) return;
    try {
      const lines = items
        .map((item) => `${JSON.stringify(this.recordFor(item))}\n`)
        .join("");
      writeSync(this.fd, lines);
    } catch {
      this.disabled = true;
    }
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // Best-effort local export must not affect session shutdown.
    } finally {
      this.fd = null;
    }
  }

  private recordFor(item: RolloutItem): TrajectoryExportRecord {
    return {
      schemaVersion: TRAJECTORY_EXPORT_SCHEMA_VERSION,
      exportedAtUnixMs: Date.now(),
      sessionId: this.sessionId,
      rolloutPath: this.rolloutPath,
      item: JSON.parse(serializeRolloutItem(item)) as unknown,
    };
  }
}

export function createTrajectoryExportSink(
  options: CreateTrajectoryExportSinkOptions,
): TrajectoryExportSink {
  const path = resolveTrajectoryExportPath(options);
  if (path === undefined) return DISABLED_TRAJECTORY_EXPORT;
  try {
    return new FileTrajectoryExportSink(path, options.sessionId, options.rolloutPath);
  } catch {
    return DISABLED_TRAJECTORY_EXPORT;
  }
}

function resolveTrajectoryExportPath(
  options: CreateTrajectoryExportSinkOptions,
): string | undefined {
  const env = options.env ?? process.env;
  const explicitPath = env[AGENC_TRAJECTORY_EXPORT_PATH_ENV]?.trim();
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    if (isExistingDirectory(resolved)) {
      return join(resolved, `${safeSessionFileName(options.sessionId)}.jsonl`);
    }
    return resolved;
  }
  const dir = env[AGENC_TRAJECTORY_EXPORT_DIR_ENV]?.trim();
  if (!dir) return undefined;
  return join(resolve(dir), `${safeSessionFileName(options.sessionId)}.jsonl`);
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeSessionFileName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "session";
}
