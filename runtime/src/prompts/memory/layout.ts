/**
 * AgenC durable memory v2 layout.
 *
 * The layout intentionally follows AgenC runtime's progressive-disclosure shape
 * while keeping the current AgenC memory directory compatible:
 *
 *   memory_summary.md       small routing summary
 *   MEMORY.md               searchable handbook/index
 *   raw_memories.md         append-only extracted raw memory notes
 *   entries/                frontmatter memory files
 *   rollout_summaries/      evidence-backed session summaries
 *   skills/                 reusable procedures
 *   extensions/             optional source-specific memory inputs
 *
 * @module
 */

import { join } from "node:path";

export const MEMORY_SUMMARY_FILENAME = "memory_summary.md";
export const MEMORY_INDEX_FILENAME = "MEMORY.md";
export const RAW_MEMORIES_FILENAME = "raw_memories.md";
export const MEMORY_ENTRIES_DIRNAME = "entries";
export const ROLLOUT_SUMMARIES_DIRNAME = "rollout_summaries";
export const MEMORY_SKILLS_DIRNAME = "skills";
export const MEMORY_EXTENSIONS_DIRNAME = "extensions";

export interface MemoryLayout {
  readonly root: string;
  readonly memorySummaryPath: string;
  readonly memoryMdPath: string;
  readonly rawMemoriesPath: string;
  readonly entriesDir: string;
  readonly rolloutSummariesDir: string;
  readonly skillsDir: string;
  readonly extensionsDir: string;
}

export function memoryLayout(memoryDir: string): MemoryLayout {
  return {
    root: memoryDir,
    memorySummaryPath: join(memoryDir, MEMORY_SUMMARY_FILENAME),
    memoryMdPath: join(memoryDir, MEMORY_INDEX_FILENAME),
    rawMemoriesPath: join(memoryDir, RAW_MEMORIES_FILENAME),
    entriesDir: join(memoryDir, MEMORY_ENTRIES_DIRNAME),
    rolloutSummariesDir: join(memoryDir, ROLLOUT_SUMMARIES_DIRNAME),
    skillsDir: join(memoryDir, MEMORY_SKILLS_DIRNAME),
    extensionsDir: join(memoryDir, MEMORY_EXTENSIONS_DIRNAME),
  };
}

