import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { preflightDelegatedLocalFileScope } from "./delegated-scope-preflight.js";

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const path of TEMP_DIRS.splice(0, TEMP_DIRS.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("preflightDelegatedLocalFileScope", () => {
  it("rejects filesystem-capable delegated tool scopes that lack a structured executionContext", () => {
    const result = preflightDelegatedLocalFileScope({
      allowedTools: ["system.readFile"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "missing_execution_context",
    );
  });

  it("allows non-filesystem delegated tool scopes without a structured executionContext", () => {
    const result = preflightDelegatedLocalFileScope({
      allowedTools: ["system.browse"],
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects required source artifacts outside delegated read roots before spawn", () => {
    const result = preflightDelegatedLocalFileScope({
      workingDirectory: "/home/tetsuo/git/AgenC/agenc-core",
      executionContext: {
        version: "v1",
        workspaceRoot: "/home/tetsuo/git/AgenC/agenc-core",
        allowedReadRoots: ["/home/tetsuo/git/AgenC/agenc-core/src"],
        allowedWriteRoots: ["/home/tetsuo/git/AgenC/agenc-core"],
        requiredSourceArtifacts: ["/home/tetsuo/git/AgenC/agenc-core/PLAN.md"],
        targetArtifacts: ["/home/tetsuo/git/AgenC/agenc-core/TODO.MD"],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "required_source_outside_read_roots",
    );
  });

  it("rejects missing delegated workspaces when required source artifacts are declared", () => {
    const missingRoot = join(tmpdir(), `agenc-preflight-missing-${Date.now()}`);
    const result = preflightDelegatedLocalFileScope({
      workingDirectory: missingRoot,
      executionContext: {
        version: "v1",
        workspaceRoot: missingRoot,
        allowedReadRoots: [missingRoot],
        allowedWriteRoots: [missingRoot],
        requiredSourceArtifacts: [join(missingRoot, "PLAN.md")],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "workspace_root_missing_for_required_sources",
        "required_source_missing",
      ]),
    );
  });

  it("accepts canonical delegated contracts that already agree with the filesystem", () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "agenc-preflight-valid-"),
    );
    TEMP_DIRS.push(workspaceRoot);
    mkdirSync(join(workspaceRoot, "docs"), { recursive: true });
    writeFileSync(join(workspaceRoot, "PLAN.md"), "# plan\n", "utf8");

    const result = preflightDelegatedLocalFileScope({
      workingDirectory: workspaceRoot,
      executionContext: {
        version: "v1",
        workspaceRoot,
        allowedReadRoots: [workspaceRoot],
        allowedWriteRoots: [workspaceRoot],
        requiredSourceArtifacts: [join(workspaceRoot, "PLAN.md")],
        targetArtifacts: [join(workspaceRoot, "docs", "OUT.md")],
      },
    });

    expect(result).toEqual({ ok: true });
  });
});
