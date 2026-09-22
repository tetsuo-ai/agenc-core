/**
 * Closest-tool suggestions for unknown tool names.
 *
 * DeepSeek V4.1 Flash called tools by other harnesses' names (`Read` 7 times
 * in one run, `edit_file`). Core does not alias them; the unknown-tool error
 * names the closest tool the session can actually call, when the match is
 * clear, so the model can correct in one step.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildBootstrapToolRegistry } from "../../src/bin/bootstrap-tool-registry.js";
import {
  FOREIGN_TOOL_NAME_TARGETS,
  formatUnknownToolMessage,
  suggestAvailableToolName,
} from "../../src/tools/tool-name-suggestion.js";

let cachedCatalog: readonly string[] | undefined;

/**
 * The real default catalog, visible and deferred tools. Built inside a test
 * because tool construction reads the per-test provider scope.
 */
function productionCatalog(): readonly string[] {
  cachedCatalog ??= buildBootstrapToolRegistry({
    workspaceRoot: process.cwd(),
    agencHome: join(tmpdir(), "agenc-tool-name-suggestion"),
    mcpManager: {
      getTools: () => [],
      effectiveServers: async () => new Map(),
      toolPluginProvenance: async () => null,
    } as never,
    csvAgentJobsRepositories: {
      async withRepository(): Promise<never> {
        throw new Error("CSV repositories are not used by this test");
      },
    },
    getSession: () => null,
    emitWarning: () => {},
  }).tools.map((tool) => tool.name);
  return cachedCatalog;
}

describe("suggestAvailableToolName", () => {
  test.each([
    ["Read", "FileRead"],
    ["edit_file", "Edit"],
    ["write_file", "Write"],
    ["bash", "exec_command"],
    ["grep", "Grep"],
    ["Bash", "exec_command"],
    ["shell", "exec_command"],
    ["run_terminal_cmd", "exec_command"],
    ["execute_command", "exec_command"],
    ["read_file", "FileRead"],
    ["view_file", "FileRead"],
    ["replace", "Edit"],
    ["write_to_file", "Write"],
    ["multi_edit", "MultiEdit"],
    ["glob", "Glob"],
    ["grep_search", "Grep"],
    ["WebFetch", "web_fetch"],
    ["web_search", "WebSearch"],
    ["todo_write", "TodoWrite"],
    ["update_plan", "TodoWrite"],
    ["list_dir", "system.listDir"],
    ["LS", "system.listDir"],
    ["KillShell", "kill_process"],
  ])("names %s -> %s from the production catalog", (requested, expected) => {
    const catalog = productionCatalog();
    expect(catalog).not.toContain(requested);
    expect(suggestAvailableToolName(requested, catalog)).toBe(expected);
  });

  test("every tool it can point to is a real default tool", () => {
    const catalog = productionCatalog();
    for (const entry of FOREIGN_TOOL_NAME_TARGETS) {
      for (const tool of entry.tools) expect(catalog).toContain(tool);
    }
  });

  test("suggests only tools that are available", () => {
    expect(suggestAvailableToolName("Read", ["Grep", "Edit"])).toBeUndefined();
    expect(suggestAvailableToolName("bash", ["system.bash", "Grep"])).toBe("system.bash");
    expect(suggestAvailableToolName("list_dir", ["Glob"])).toBe("Glob");
    expect(suggestAvailableToolName("edit_file", [])).toBeUndefined();
  });

  test.each(["frobnicate", "search", "task", "exec", "run", "", "__"])(
    "has no clear match for %j",
    (requested) => {
      expect(suggestAvailableToolName(requested, productionCatalog())).toBeUndefined();
    },
  );

  test.each([
    // Multi-purpose editors: they also view, create or insert, or apply
    // several blocks per call, so no single tool is their counterpart.
    "str_replace_editor",
    "str_replace_based_edit_tool",
    "replace_in_file",
    "replace_file_content",
    // Names that mean different jobs in different harnesses.
    "search_files",
    "todo",
  ])("names no tool for the multi-purpose or ambiguous name %j", (requested) => {
    expect(suggestAvailableToolName(requested, productionCatalog())).toBeUndefined();
  });

  test("declines when the spelling matches more than one tool", () => {
    expect(suggestAvailableToolName("Webfetch", ["web_fetch", "WebFetch"])).toBeUndefined();
  });

  test("never answers a name that is itself available", () => {
    expect(suggestAvailableToolName("Grep", ["Grep", "grep"])).toBeUndefined();
  });
});

describe("formatUnknownToolMessage", () => {
  test("keeps the plain error when there is no suggestion", () => {
    expect(formatUnknownToolMessage("no.such.tool", undefined)).toBe(
      "No such tool available: no.such.tool",
    );
  });

  test("says how to load a deferred suggestion, as a fact", () => {
    expect(
      formatUnknownToolMessage("ls", "system.listDir", "system.searchTools"),
    ).toBe(
      "No such tool available: ls. " +
        "The closest available tool is system.listDir, which has its own parameters. " +
        "Its schema is not loaded yet; system.searchTools with select:system.listDir loads it.",
    );
  });

  test("names the closest tool as a fact, not a directive", () => {
    expect(formatUnknownToolMessage("edit_file", "Edit")).toBe(
      "No such tool available: edit_file. " +
        "The closest available tool is Edit, which has its own parameters.",
    );
  });
});
