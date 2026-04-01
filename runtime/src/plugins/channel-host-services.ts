import { join } from "node:path";
import type { MemoryBackend } from "../memory/types.js";
import { AgentIdentityManager } from "../memory/agent-identity.js";
import { SocialMemoryManager } from "../memory/social-memory.js";
import { ProceduralMemory } from "../memory/procedural.js";
import { SharedMemoryBackend } from "../memory/shared-memory.js";
import { DailyLogManager } from "../memory/structured.js";
import { MemoryTraceLogger } from "../memory/trace-logger.js";
import type { Logger } from "../utils/logger.js";

export interface ConcordiaMemoryHostServices {
  readonly memoryBackend: MemoryBackend;
  readonly identityManager: AgentIdentityManager;
  readonly socialMemory: SocialMemoryManager;
  readonly proceduralMemory: ProceduralMemory;
  readonly sharedMemory: SharedMemoryBackend;
  readonly traceLogger: MemoryTraceLogger;
  readonly dailyLogManager?: DailyLogManager;
}

export type ChannelHostServices = Readonly<Record<string, unknown>> & {
  readonly concordia_memory?: ConcordiaMemoryHostServices;
};

export function createChannelHostServices(params: {
  readonly memoryBackend: MemoryBackend | null;
  readonly logger: Logger;
  readonly workspacePath?: string;
}): ChannelHostServices | undefined {
  if (!params.memoryBackend) {
    return undefined;
  }

  return {
    concordia_memory: {
      memoryBackend: params.memoryBackend,
      identityManager: new AgentIdentityManager({
        memoryBackend: params.memoryBackend,
        logger: params.logger,
      }),
      socialMemory: new SocialMemoryManager({
        memoryBackend: params.memoryBackend,
        logger: params.logger,
      }),
      proceduralMemory: new ProceduralMemory({
        memoryBackend: params.memoryBackend,
        logger: params.logger,
      }),
      sharedMemory: new SharedMemoryBackend({
        memoryBackend: params.memoryBackend,
        logger: params.logger,
      }),
      traceLogger: new MemoryTraceLogger(params.logger),
      dailyLogManager: params.workspacePath
        ? new DailyLogManager(join(params.workspacePath, "logs"))
        : undefined,
    },
  };
}
