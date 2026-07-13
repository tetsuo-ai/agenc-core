import { describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../../src/services/mcp/types.js";
import { importSelectedMcpServers } from "../../../src/tui/components/MCPServerDesktopImportDialog.js";

// M-TUI-6 (core-todo.md): the import loop awaited addMcpConfig (a config-file
// write) with no try/catch, but SelectMulti invokes onSubmit fire-and-forget. An
// EACCES/EROFS/disk rejection escaped as an unhandled rejection AND left done()
// uncalled, wedging the dialog. The loop now catches, logs, and returns the
// partial count so the caller always closes the dialog.

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

  it("returns the partial count without throwing when a write fails", async () => {
    const added: string[] = [];
    const count = await importSelectedMcpServers(
      ["a", "b", "c"],
      { a: cfg("a"), b: cfg("b"), c: cfg("c") },
      {},
      "user" as never,
      async (name) => {
        if (name === "b") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        added.push(name);
      },
    );
    // 'a' succeeded, 'b' threw -> loop stops, count is the partial 1, no throw.
    expect(count).toBe(1);
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
