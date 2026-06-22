import { parsePatch } from "../apply-patch/parser.js";
import type { Tool } from "../types.js";
import { resolveRuntimePathTarget } from "./paths.js";

export interface ApplyPatchRuntimeWriteAnalysis {
  readonly targets: readonly string[];
  readonly indeterminate: boolean;
}

export function analyzeApplyPatchRuntimeWrites(
  tool: Tool,
  args: Record<string, unknown>,
  cwd: string,
): ApplyPatchRuntimeWriteAnalysis | null {
  if (tool.name !== "apply_patch") return null;
  const patch = typeof args["input"] === "string"
    ? args["input"]
    : typeof args["patch"] === "string"
      ? args["patch"]
      : undefined;
  if (patch === undefined || patch.trim().length === 0) {
    return { targets: [], indeterminate: true };
  }
  try {
    const parsed = parsePatch(patch);
    const targets = new Set<string>();
    for (const hunk of parsed.hunks) {
      targets.add(resolveRuntimePathTarget(hunk.path, cwd));
      if (hunk.kind === "update" && hunk.movePath !== null) {
        targets.add(resolveRuntimePathTarget(hunk.movePath, cwd));
      }
    }
    return { targets: [...targets], indeterminate: targets.size === 0 };
  } catch {
    return { targets: [], indeterminate: true };
  }
}
