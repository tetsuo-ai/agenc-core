import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelBackedInitPrompt,
  runModelBackedProjectGuide,
  validateInitGuideContent,
} from "./init-runner.js";

function validGuideContent(): string {
  return [
    "# Repository Guidelines",
    "",
    "## Project Structure & Module Organization",
    "- runtime/",
    "",
    "## Build, Test, and Development Commands",
    "- npm run build",
    "",
    "## Coding Style & Naming Conventions",
    "- TypeScript uses strict typing.",
    "",
    "## Testing Guidelines",
    "- npm test",
    "",
    "## Commit & Pull Request Guidelines",
    "- Use Conventional Commits.",
  ].join("\n");
}

describe("init-runner", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("requires the canonical init headings", () => {
    expect(validateInitGuideContent("# Repository Guidelines\n")).toContain(
      "Project Structure",
    );
    expect(validateInitGuideContent(validGuideContent())).toBeNull();
  });

  it("builds a prompt grounded in repository evidence", () => {
    const prompt = buildModelBackedInitPrompt({
      workspaceRoot: "/repo",
      filePath: "/repo/AGENC.md",
      force: true,
      minimumDelegatedInvestigations: 3,
      evidence: {
        rootEntries: ["README.md", "src/"],
        keyFiles: [{ path: "README.md", content: "# Demo repo" }],
        subdirectories: [{ path: "src/", entries: ["main.c"] }],
        recentCommitSubjects: ["feat(core): add init"],
      },
    });

    expect(prompt).toContain("## Project Structure & Module Organization");
    expect(prompt).toContain("Root entries:");
    expect(prompt).toContain("Recent commit subjects:");
  });

  it("skips when AGENC.md already exists and force is false", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-init-runner-skip-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "AGENC.md"), validGuideContent(), "utf-8");

    const result = await runModelBackedProjectGuide({
      workspaceRoot: workspace,
      sessionId: "init-session",
    });

    expect(result.status).toBe("skipped");
    expect(result.attempts).toBe(0);
  });

  it("writes the guide deterministically from discovered repo evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-init-runner-ok-"));
    workspaces.push(workspace);
    writeFileSync(
      join(workspace, "README.md"),
      "# Demo Repo\n\nUse npm run build.",
      "utf-8",
    );
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { build: "vite build", test: "vitest run" } }),
      "utf-8",
    );
    const result = await runModelBackedProjectGuide({
      workspaceRoot: workspace,
      sessionId: "init-session",
    });

    expect(result.status).toBe("created");
    expect(result.attempts).toBe(1);
    expect(result.delegatedInvestigations).toBe(0);
    expect(result.filePath).toBe(join(workspace, "AGENC.md"));
    expect(result.content).toContain("# Repository Guidelines");
    expect(readFileSync(join(workspace, "AGENC.md"), "utf-8")).toContain(
      "# Repository Guidelines",
    );
    expect(result.content).toContain("npm run build");
    expect(result.content).toContain("npm run test");
  });

  it("accepts grounded discovery for minimal repos that only contain PLAN.md", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-init-runner-plan-only-"));
    workspaces.push(workspace);
    writeFileSync(
      join(workspace, "PLAN.md"),
      "# Shell Plan\n\n## Build\n- cmake",
      "utf-8",
    );
    const result = await runModelBackedProjectGuide({
      workspaceRoot: workspace,
      sessionId: "init-session",
    });

    expect(result.status).toBe("created");
    expect(result.attempts).toBe(1);
    expect(result.content).toContain("# Repository Guidelines");
    expect(result.content).toContain("PLAN.md");
    // Previously this asserted the output contained the word "future", which
    // came from the hard-coded string "PLAN.md references a future CMake-based
    // build, but no CMakeLists.txt exists in the repository yet." That string
    // was removed on 2026-04-06 along with the PLAN.md filename special-casing
    // in init-runner.ts — runtime behavior must not depend on any particular
    // filename.
  });

  it("renders planned structure from tree-style PLAN.md without double bullets or repo-root noise", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-init-runner-tree-plan-"));
    workspaces.push(workspace);
    writeFileSync(
      join(workspace, "PLAN.md"),
      [
        "## Directory Structure",
        "```",
        "agenc-shell/",
        "├── CMakeLists.txt",
        "├── src/",
        "│   ├── main.c",
        "│   ├── input.c",
        "│   └── shell.h",
        "└── build/",
        "```",
      ].join("\n"),
      "utf-8",
    );

    const result = await runModelBackedProjectGuide({
      workspaceRoot: workspace,
      sessionId: "init-session",
    });

    expect(result.content).toContain("PLAN.md describes planned future structure including CMakeLists.txt, src/, main.c, input.c, shell.h, build/");
    expect(result.content).not.toContain("- -");
    expect(result.content).not.toContain("including -");
    expect(result.content).not.toContain("including agenc-shell/");
  });

  it("records progress events while synthesizing the guide", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-init-runner-progress-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "README.md"), "# Demo Repo", "utf-8");
    const progress = vi.fn();

    const result = await runModelBackedProjectGuide({
      workspaceRoot: workspace,
      sessionId: "init-session",
      onProgress: progress,
    });

    expect(result.status).toBe("created");
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "start" }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "evidence_collected" }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "guide_synthesized" }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "file_written" }),
    );
  });
});
