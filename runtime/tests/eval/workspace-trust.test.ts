import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { trustWorkspace } from "../../scripts/eval/workspace-trust.mjs";

const NOW = () => new Date("2026-09-04T10:00:00Z");

function freshRoot(): { home: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "eval-trust-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  return { home: join(root, "home"), workspace };
}

describe("trustWorkspace", () => {
  it("writes a version-1 record with the canonical workspace into a fresh home", () => {
    const { home, workspace } = freshRoot();
    const result = trustWorkspace({ agencHome: home, workspace, now: NOW });
    const record = JSON.parse(readFileSync(join(home, "trusted-projects.json"), "utf8"));
    expect(record).toEqual({
      version: 1,
      trustedProjects: [{ path: realpathSync(workspace), trustedAt: "2026-09-04T10:00:00.000Z" }],
    });
    expect(result.path).toBe(realpathSync(workspace));
    if (process.platform !== "win32") expect(statSync(result.file).mode & 0o077).toBe(0);
  });

  it("keeps other entries and extra fields, and replaces its own entry", () => {
    const { home, workspace } = freshRoot();
    mkdirSync(home, { recursive: true });
    const file = join(home, "trusted-projects.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      trustedProjects: [
        { path: "/somewhere/else", trustedAt: "2026-01-01T00:00:00.000Z" },
        { path: realpathSync(workspace), trustedAt: "2026-01-02T00:00:00.000Z" },
      ],
      projectMcpServerChoices: [{ path: "/somewhere/else", rejectedServers: ["x"] }],
    }));
    trustWorkspace({ agencHome: home, workspace, now: NOW });
    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(record.trustedProjects).toEqual([
      { path: "/somewhere/else", trustedAt: "2026-01-01T00:00:00.000Z" },
      { path: realpathSync(workspace), trustedAt: "2026-09-04T10:00:00.000Z" },
    ]);
    expect(record.projectMcpServerChoices).toEqual([{ path: "/somewhere/else", rejectedServers: ["x"] }]);
  });

  it("replaces an unreadable record instead of failing", () => {
    const { home, workspace } = freshRoot();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "trusted-projects.json"), "not json");
    trustWorkspace({ agencHome: home, workspace, now: NOW });
    const record = JSON.parse(readFileSync(join(home, "trusted-projects.json"), "utf8"));
    expect(record.version).toBe(1);
    expect(record.trustedProjects).toHaveLength(1);
  });
});
