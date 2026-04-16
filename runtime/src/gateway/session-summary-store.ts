import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { MemoryBackend } from "../memory/types.js";
import type { WebChatSessionStore } from "../channels/webchat/session-store.js";
import { KeyedAsyncQueue } from "../utils/keyed-async-queue.js";
import type { InteractiveContextSummaryRef } from "./interactive-context.js";

const DEFAULT_SESSION_MEMORY_ROOT = join(homedir(), ".agenc", "projects");
const SUMMARY_FILENAME = "summary.md";

interface SessionSummaryStoreConfig {
  readonly rootDir?: string;
  readonly sessionStore?: Pick<WebChatSessionStore, "loadSession">;
  readonly memoryBackend?: MemoryBackend;
}

function hashOwnerKey(ownerKey: string): string {
  return createHash("sha256").update(ownerKey).digest("hex");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class SessionSummaryStore {
  private readonly rootDir: string;
  private readonly queue: KeyedAsyncQueue;
  private readonly sessionStore?: Pick<WebChatSessionStore, "loadSession">;
  private readonly memoryBackend?: MemoryBackend;

  constructor(config: SessionSummaryStoreConfig = {}) {
    this.rootDir = config.rootDir ?? DEFAULT_SESSION_MEMORY_ROOT;
    this.queue = new KeyedAsyncQueue();
    this.sessionStore = config.sessionStore;
    this.memoryBackend = config.memoryBackend;
  }

  private resolveSummaryPath(ownerKeyHash: string, sessionId: string): string {
    return join(
      this.rootDir,
      ownerKeyHash,
      sessionId,
      "session-memory",
      SUMMARY_FILENAME,
    );
  }

  async load(
    ownerKeyHash: string,
    sessionId: string,
  ): Promise<string | undefined> {
    try {
      const content = await readFile(
        this.resolveSummaryPath(ownerKeyHash, sessionId),
        "utf8",
      );
      return content;
    } catch {
      return undefined;
    }
  }

  async compareAndSet(params: {
    ownerKeyHash: string;
    sessionId: string;
    ownerSessionId: string;
    expectedBoundarySeq?: number;
    expectedTranscriptNextSeq?: number;
    content: string;
    contentHash?: string;
  }): Promise<InteractiveContextSummaryRef> {
    const queueKey = `${params.ownerKeyHash}:${params.sessionId}`;
    return this.queue.run(queueKey, async () => {
      const summaryPath = this.resolveSummaryPath(
        params.ownerKeyHash,
        params.sessionId,
      );
      const nextHash = params.contentHash ?? hashContent(params.content);
      const currentContent = await this.load(params.ownerKeyHash, params.sessionId);
      const transcriptNextSeq = params.expectedTranscriptNextSeq ?? 0;
      const boundarySeq = params.expectedBoundarySeq ?? 0;
      if (currentContent !== undefined && hashContent(currentContent) === nextHash) {
        return {
          ownerSessionId: params.ownerSessionId,
          path: summaryPath,
          boundarySeq,
          transcriptNextSeq,
          updatedAt: Date.now(),
          contentHash: nextHash,
        };
      }
      await mkdir(dirname(summaryPath), { recursive: true });
      const tempPath = `${summaryPath}.${Date.now().toString(36)}.tmp`;
      await writeFile(tempPath, params.content, "utf8");
      await rename(tempPath, summaryPath);
      return {
        ownerSessionId: params.ownerSessionId,
        path: summaryPath,
        boundarySeq,
        transcriptNextSeq,
        updatedAt: Date.now(),
        contentHash: nextHash,
      };
    });
  }

  async clear(ownerKeyHash: string, sessionId: string): Promise<void> {
    await this.queue.run(`${ownerKeyHash}:${sessionId}`, async () => {
      await rm(this.resolveSummaryPath(ownerKeyHash, sessionId), {
        force: true,
      }).catch(() => undefined);
      await rm(join(this.rootDir, ownerKeyHash, sessionId), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    });
  }

  async gcOrphans(): Promise<void> {
    const ownerDirs = await readdir(this.rootDir, { withFileTypes: true }).catch(
      () => [],
    );
    for (const ownerDir of ownerDirs) {
      if (!ownerDir.isDirectory()) {
        continue;
      }
      const ownerPath = join(this.rootDir, ownerDir.name);
      const sessionDirs = await readdir(ownerPath, { withFileTypes: true }).catch(
        () => [],
      );
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) {
          continue;
        }
        const sessionId = sessionDir.name;
        const sessionExists = this.sessionStore
          ? Boolean(await this.sessionStore.loadSession(sessionId))
          : false;
        if (sessionExists) {
          continue;
        }
        const replayExists = this.memoryBackend
          ? Boolean(
              await this.memoryBackend.get(`webchat:replay-state:${sessionId}`),
            )
          : false;
        if (replayExists) {
          continue;
        }
        const transcriptExists = this.memoryBackend
          ? Boolean(
              await this.memoryBackend.get(`transcript:v1:${sessionId}`),
            )
          : false;
        if (transcriptExists) {
          continue;
        }
        await rm(join(ownerPath, sessionId), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
      const remaining = await readdir(ownerPath).catch(() => []);
      if (remaining.length === 0) {
        await rm(ownerPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }
}

export function buildSessionSummaryOwnerKeyHash(ownerKey: string): string {
  return hashOwnerKey(ownerKey);
}

export async function sessionSummaryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
