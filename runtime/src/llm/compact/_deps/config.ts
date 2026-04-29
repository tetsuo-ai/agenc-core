/**
 * Minimal config + memory-path surface compact needs. Gut runtime owns
 * the real config store at `runtime/src/config/`.
 */

import { join } from "node:path";

type MemoryType =
  | "User"
  | "Project"
  | "Local"
  | "Managed"
  | "AutoMem"
  | "TeamMem"
  | "user"
  | "feedback"
  | "project"
  | "reference";

interface GlobalConfig {
  readonly model: string;
  readonly autoCompactEnabled: boolean;
  readonly compactionMinShrinkRatio: number;
}

export function getGlobalConfig(): GlobalConfig {
  return {
    model: process.env.AGENC_MODEL ?? "grok-4-fast",
    autoCompactEnabled: process.env.AGENC_DISABLE_AUTO_COMPACT !== "1",
    compactionMinShrinkRatio: 0.7,
  };
}

function agencHome(): string {
  return (
    process.env.AGENC_HOME ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agenc")
  );
}

export function getMemoryPath(memoryType: MemoryType): string {
  return join(agencHome(), "memory", `${memoryType}.md`);
}
