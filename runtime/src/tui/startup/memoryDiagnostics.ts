import {
  getLargeMemoryFiles,
  getMemoryFiles,
  MAX_MEMORY_CHARACTER_COUNT,
  type MemoryFileInfo,
} from "../../memory/index.js";
import { getDisplayPath } from "../../utils/file.js";
import { formatNumber } from "../../utils/format.js";

export function formatLargeMemoryDiagnostics(
  files: MemoryFileInfo[],
): string[] {
  return getLargeMemoryFiles(files).map((file) => {
    const displayPath = getDisplayPath(file.path);
    return `Large ${displayPath} will impact performance (${formatNumber(file.content.length)} chars > ${formatNumber(MAX_MEMORY_CHARACTER_COUNT)})`;
  });
}

export async function buildMemoryDiagnostics(): Promise<string[]> {
  return formatLargeMemoryDiagnostics(await getMemoryFiles());
}
