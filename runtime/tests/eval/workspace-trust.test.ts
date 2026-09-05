import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

  it("keeps every entry when two runners trust different workspaces at once", () => {
    const { home, workspace } = freshRoot();
    const second = join(workspace, "..", "ws2");
    mkdirSync(second);
    // Two processes, each trusting its own workspace against the same home.
    const script = `import { trustWorkspace } from ${JSON.stringify(new URL("../../scripts/eval/workspace-trust.mjs", import.meta.url).href)};
      for (let i = 0; i < 20; i += 1) trustWorkspace({ agencHome: process.argv[1], workspace: process.argv[2] });`;
    const runners = [workspace, second].map((ws) =>
      spawn(process.execPath, ["--input-type=module", "-e", script, home, ws], { stdio: "inherit" }));
    return Promise.all(runners.map((child) => new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`runner exited ${code}`))));
    }))).then(() => {
      const record = JSON.parse(readFileSync(join(home, "trusted-projects.json"), "utf8"));
      const paths = record.trustedProjects.map((entry: { path: string }) => entry.path).sort();
      expect(paths).toEqual([realpathSync(second), realpathSync(workspace)].sort());
      expect(existsSync(join(home, "trusted-projects.json.lock"))).toBe(false);
    });
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
