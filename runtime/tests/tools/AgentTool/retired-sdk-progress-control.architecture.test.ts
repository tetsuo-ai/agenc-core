import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

function source(path: string): string {
  return readFileSync(resolve(sourceRoot, path), "utf8");
}

describe("retired SDK agent-progress control architecture", () => {
  test("does not restore the uninitialized root flag or its dead helpers", () => {
    const retiredSymbols =
      /\b(?:sdkAgentProgressSummariesEnabled|getSdkAgentProgressSummariesEnabled|setSdkAgentProgressSummariesEnabled|getLastToolUseName)\b/u;
    const violations = sourceFiles(sourceRoot).flatMap((path) =>
      retiredSymbols.test(readFileSync(path, "utf8"))
        ? [relative(sourceRoot, path).replaceAll("\\", "/")]
        : [],
    );

    expect(violations).toEqual([]);
  });

  test("preserves coordinator and fork summarization authority", () => {
    const agentTool = source("tools/AgentTool/AgentTool.tsx");
    const resumeAgent = source("tools/AgentTool/resumeAgent.ts");
    const lifecycle = source("tools/AgentTool/agentToolUtils.ts");
    const liveGate = /isCoordinator(?:Mode\(\))?\s*\|\|\s*isForkSubagentEnabled\(\)/u;

    expect(agentTool).toMatch(liveGate);
    expect(resumeAgent).toMatch(liveGate);
    expect(lifecycle).toContain("enableSummarization");
    expect(lifecycle).toContain("startAgentSummarization({");
  });

  test("preserves AppState progress for agents that actually background", () => {
    const agentTool = source("tools/AgentTool/AgentTool.tsx");

    expect(agentTool).toMatch(
      /updateAsyncAgentProgress\(\s*backgroundedTaskId,\s*getProgressUpdate\(tracker\)/u,
    );
  });
});
