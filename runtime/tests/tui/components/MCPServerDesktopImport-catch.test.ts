import { describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../../src/services/mcp/types.js";
import { importSelectedMcpServers } from "../../../src/tui/components/MCPServerDesktopImportDialog.js";

// M-TUI-6 (core-todo.md): the import loop awaited addMcpConfig (a config-file
// write), but SelectMulti invokes onSubmit fire-and-forget, so a rejection
// escaped as an unhandled rejection. onSubmit now catches (no unhandled
// rejection) and, on failure, keeps the dialog open instead of completing —
// this helper still rejects so onSubmit can make that decision.

const cfg = (id: string): McpServerConfig =>
  ({ type: "stdio", command: id }) as unknown as McpServerConfig;

describe("importSelectedMcpServers", () => {
  it("imports each selected server and returns the count", async () => {
    const added: string[] = [];
    const count = await importSelectedMcpServers(
      ["a", "b"],
      { a: cfg("a"), b: cfg("b") },
      {},
      "user" as never,
      async (name) => {
        added.push(name);
      },
    );
    expect(count).toBe(2);
    expect(added).toEqual(["a", "b"]);
  });

  it("renames on a name collision with existing config", async () => {
    const added: string[] = [];
    const count = await importSelectedMcpServers(
      ["a"],
      { a: cfg("a") },
      { a: {} as never }, // 'a' already exists
      "user" as never,
      async (name) => {
        added.push(name);
      },
    );
    expect(count).toBe(1);
    expect(added).toEqual(["a_1"]);
  });

  it("rejects when a write fails (the caller keeps the dialog open)", async () => {
    const added: string[] = [];
    await expect(
      importSelectedMcpServers(
        ["a", "b", "c"],
        { a: cfg("a"), b: cfg("b"), c: cfg("c") },
        {},
        "user" as never,
        async (name) => {
          if (name === "b") {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          added.push(name);
        },
      ),
    ).rejects.toThrow("EACCES");
    // 'a' was written before 'b' failed; onSubmit does not complete on rejection.
    expect(added).toEqual(["a"]);
  });

  it("skips servers not present in the servers map", async () => {
    const added: string[] = [];
    const count = await importSelectedMcpServers(
      ["a", "missing"],
      { a: cfg("a") },
      {},
      "user" as never,
      async (name) => {
        added.push(name);
      },
    );
    expect(count).toBe(1);
    expect(added).toEqual(["a"]);
  });
});
