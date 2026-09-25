import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Import boundary for the remaining `src/utils/permissions/` compatibility
 * helpers.
 *
 * Permission settings loading, persistence, mode transitions, and generic
 * rule mutation are canonical under `src/permissions/`. Some older tool
 * implementations still import presentation and tool-specific evaluation
 * helpers from `src/utils/permissions/`. This test freezes that compatibility
 * surface: its importer set must only shrink, never grow.
 *
 * If this fails because you ADDED an importer: import from `src/permissions/`
 * instead. If it fails because you REMOVED one (migration progress): delete
 * that path from BASELINE below — thank you.
 */

// Frozen snapshot of files under src/ (excluding tests) that import from
// `utils/permissions/`. Re-baselined 2026-09-20: the donor stack shrank by ten
// during the 0.18.0 cycle, and the detector below now matches real import and
// re-export specifiers instead of any occurrence of the path, so a doc comment
// that merely names a donor module no longer counts as an importer.
const BASELINE: readonly string[] = [
  "memory/agencmd.ts",
  "tasks/InProcessTeammateTask/types.ts",
  "tools.ts",
  "tools/AgentTool/agentToolUtils.ts",
  "tools/BashTool/bashCommandHelpers.ts",
  "tools/BashTool/bashPermissions.ts",
  "tools/BashTool/bashSecurity.ts",
  "tools/BashTool/modeValidation.ts",
  "tools/BashTool/pathValidation.ts",
  "tools/BashTool/prompt.ts",
  "tools/BashTool/readOnlyValidation.ts",
  "tools/BashTool/sedValidation.ts",
  "tools/BashTool/utils.ts",
  "tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts",
  "tools/FileWriteTool/FileWriteTool.ts",
  "tools/PowerShellTool/modeValidation.ts",
  "tools/PowerShellTool/pathValidation.ts",
  "tools/PowerShellTool/powershellPermissions.ts",
  "tools/SyntheticOutputTool/SyntheticOutputTool.ts",
  "tools/Tool.ts",
  "tools/WebSearchTool/WebSearchTool.ts",
  "tools/shared/spawnMultiAgent.ts",
  "tui/hooks/useSwarmPermissionPoller.ts",
  "tui/pathDisplay.ts",
  "tui/permission-types.ts",
  "tui/state/AppStateStore.ts",
  "types/hooks.ts",
];

const SRC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
);

function currentDonorImporters(): string[] {
  // `git grep` is fast and respects the working tree; fall back to empty on
  // any failure rather than masking a real regression as a crash.
  let raw = "";
  try {
    // Match the specifier of a real import / re-export / require, not a
    // mention of the path in prose: several canonical modules document which
    // donor list they mirror, and that is not a dependency.
    raw = execFileSync(
      "git",
      [
        "grep",
        "-lE",
        "(from|import|require\\()[[:space:]]*['\"][^'\"]*utils/permissions/",
        "--",
        "*.ts",
      ],
      { cwd: SRC_DIR, encoding: "utf8" },
    );
  } catch (error) {
    // git grep exits 1 when there are no matches; treat as empty.
    const status = (error as { status?: number }).status;
    if (status !== 1) throw error;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith(".test.ts"))
    .sort();
}

describe("utils/permissions compatibility import boundary", () => {
  it("gains no new importers (the donor stack may only shrink)", () => {
    const current = currentDonorImporters();
    const baseline = new Set<string>(BASELINE);
    const added = current.filter((file) => !baseline.has(file));
    expect(
      added,
      `New imports of the src/utils/permissions compatibility helpers are not allowed — ` +
        `import from src/permissions/ instead, or finish the consolidation. New importers:\n` +
        added.map((f) => `  - src/${f}`).join("\n"),
    ).toEqual([]);
  });
});
