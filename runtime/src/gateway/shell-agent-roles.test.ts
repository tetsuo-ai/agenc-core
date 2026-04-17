import { describe, expect, it } from "vitest";

import type { ToolCatalogEntry } from "../tools/types.js";
import { resolveShellAgentRole } from "./shell-agent-roles.js";

function makeCatalogEntry(name: string): ToolCatalogEntry {
  return {
    name,
    metadata: {
      source: "builtin",
      hiddenByDefault: false,
      mutating: false,
    },
  };
}

function makeCatalog(names: readonly string[]): readonly ToolCatalogEntry[] {
  return names.map(makeCatalogEntry);
}

describe("resolveShellAgentRole(verify)", () => {
  it("returns the adversarial verifier prompt, not a stub", () => {
    const resolved = resolveShellAgentRole({
      roleId: "verify",
      definitions: [],
      toolCatalog: makeCatalog(["system.bash", "system.readFile"]),
    });

    expect(resolved).toBeDefined();
    const prompt = resolved?.systemPrompt ?? "";
    expect(prompt).toContain("verification specialist");
    expect(prompt).toContain("try to break it");
    expect(prompt).toContain("Command run:");
    expect(prompt).toContain("Output observed:");
    expect(prompt).toContain("VERDICT: PASS");
    expect(prompt).toContain("VERDICT: FAIL");
    expect(prompt).toContain("VERDICT: PARTIAL");
    expect(prompt).toContain("DO NOT MODIFY");
  });

  it("keeps the verify descriptor as read-only and worktree-ineligible", () => {
    const resolved = resolveShellAgentRole({
      roleId: "verify",
      definitions: [],
      toolCatalog: makeCatalog(["system.readFile"]),
    });

    expect(resolved?.descriptor.mutating).toBe(false);
    expect(resolved?.descriptor.worktreeEligible).toBe(false);
  });
});

describe("verification-probes bundle", () => {
  const probeCatalog = makeCatalog([
    "system.readFile",
    "system.listDir",
    "system.stat",
    "system.grep",
    "system.bash",
    "system.httpGet",
    "system.httpPost",
    "system.httpFetch",
    "system.browse",
    "system.browserAction",
    "system.browserSessionStart",
    "task.list",
    "task.get",
    "task.create",
    "task.update",
    "system.writeFile",
    "system.editFile",
    "system.appendFile",
    "playwright.browser_navigate",
    "playwright.browser_snapshot",
    "mcp.browser.browser_navigate",
    "system.searchTools",
  ]);

  it("includes system.bash so the verifier can run builds and tests", () => {
    const resolved = resolveShellAgentRole({
      roleId: "verify",
      definitions: [],
      toolCatalog: probeCatalog,
    });
    expect(resolved?.toolNames).toContain("system.bash");
  });

  it("includes HTTP probe tools for backend/API verification", () => {
    const resolved = resolveShellAgentRole({
      roleId: "verify",
      definitions: [],
      toolCatalog: probeCatalog,
    });
    expect(resolved?.toolNames).toContain("system.httpFetch");
    expect(resolved?.toolNames).toContain("system.httpGet");
    expect(resolved?.toolNames).toContain("system.httpPost");
  });

  it("includes browser + playwright tools when available", () => {
    const resolved = resolveShellAgentRole({
      roleId: "verify",
      definitions: [],
      toolCatalog: probeCatalog,
    });
    const names = resolved?.toolNames ?? [];
    expect(names.some((name) => name.startsWith("playwright."))).toBe(true);
    expect(names.some((name) => name.startsWith("mcp.browser."))).toBe(true);
    expect(names.some((name) => name.startsWith("system.browser"))).toBe(true);
  });

  it("excludes project-mutating write tools", () => {
    const resolved = resolveShellAgentRole({
      roleId: "verify",
      definitions: [],
      toolCatalog: probeCatalog,
    });
    const names = resolved?.toolNames ?? [];
    expect(names).not.toContain("system.writeFile");
    expect(names).not.toContain("system.editFile");
    expect(names).not.toContain("system.appendFile");
    expect(names).not.toContain("task.create");
    expect(names).not.toContain("task.update");
  });
});
