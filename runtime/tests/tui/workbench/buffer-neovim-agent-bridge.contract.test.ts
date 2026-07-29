import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  capturedContextFromRpcValue,
  integrationIntentFromRpcParams,
} from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";

function selection(content: string) {
  return {
    kind: "selection",
    buffer: 11,
    path: "/workspace/src/example.ts",
    range: {
      start: { line: 2, column: 1 },
      end: { line: 2, column: 8 },
    },
    content,
    dirty: true,
    selection_mode: "character",
    changedtick: 17,
    truncated: false,
  } as const;
}

describe("embedded Neovim agent bridge", () => {
  it("preserves exact unsaved Unicode context and intent metadata", () => {
    expect(integrationIntentFromRpcParams([
      "fix",
      "keep behavior",
      selection("界🙂"),
    ])).toEqual({
      kind: "fix",
      prompt: "keep behavior",
      context: {
        kind: "selection",
        bufferHandle: 11,
        path: "/workspace/src/example.ts",
        range: {
          start: { line: 2, column: 1 },
          end: { line: 2, column: 8 },
        },
        content: "界🙂",
        dirty: true,
        selectionMode: "character",
        changedtick: 17,
      },
    });
  });

  it("admits unnamed regular buffers without inventing a filesystem path", () => {
    expect(integrationIntentFromRpcParams([
      "attach",
      "",
      {
        ...selection("unsaved scratch"),
        buffer: 27,
        path: "",
      },
    ])).toMatchObject({
      kind: "attach",
      context: {
        bufferHandle: 27,
        path: "",
        content: "unsaved scratch",
      },
    });
  });

  it("refuses partial captures instead of silently truncating them", () => {
    expect(capturedContextFromRpcValue({
      ...selection("x"),
      truncated: true,
    }, {})).toBeNull();
    expect(capturedContextFromRpcValue(
      selection("x".repeat(64 * 1024 + 1)),
      {},
    )).toBeNull();
    expect(capturedContextFromRpcValue(
      selection(Array.from({ length: 2001 }, () => "x").join("\n")),
      {},
    )).toBeNull();
  });

  it("installs every public command and matching user-owned Plug mapping", async () => {
    const source = await readFile(
      new URL(
        "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.ts",
        import.meta.url,
      ),
      "utf8",
    );
    for (const [suffix, action] of [
      ["Attach", "attach"],
      ["Ask", "ask"],
      ["Fix", "fix"],
      ["Explain", "explain"],
      ["Review", "review"],
    ]) {
      expect(source).toContain(`${suffix} = '${action}'`);
    }
    expect(source).toContain(`nvim_create_user_command('AgenC' .. suffix`);
    expect(source).toContain(`'<Plug>(AgenC' .. suffix`);
    expect(source).not.toContain("vim.keymap.set('n', '<leader>");
  });
});
