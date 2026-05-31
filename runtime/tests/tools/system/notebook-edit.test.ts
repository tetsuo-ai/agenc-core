/**
 * Tests for `createNotebookEditTool` (src/tools/system/notebook-edit.ts).
 * Fixtures are .ipynb files in a tmpdir workspace. Most tests omit
 * `__agencSessionId` so the session read-gate is skipped and the edit
 * logic is exercised directly; one test passes a signed session id to
 * cover the "not read yet" gate.
 *
 * Coverage:
 *  - schema/identity (name, required, requiresApproval, mutating).
 *  - validation errors: missing path, bad edit_mode, non-string
 *    new_source, bad cell_type, insert without cell_type, non-insert
 *    without cell_id, non-.ipynb extension, path outside workspace,
 *    nonexistent file, non-JSON, missing cells array.
 *  - replace mode: code-cell outputs reset; markdown-cell outputs deleted.
 *  - insert mode: id generation on >=4.5, no id on 4.4.
 *  - delete mode.
 *  - findNotebookCellIndex edge cases (literal id, numeric, cell-N,
 *    out-of-range, unknown).
 *  - language resolution.
 *  - read-gate branch.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNotebookEditTool } from "./notebook-edit.js";

function notebook(cells: unknown[], minor = 5): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: minor,
    metadata: { language_info: { name: "python" } },
    cells,
  };
}

describe("createNotebookEditTool", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-edit-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function writeNotebook(name: string, value: unknown): Promise<string> {
    const path = join(workspace, name);
    await writeFile(path, JSON.stringify(value), "utf8");
    return path;
  }

  it("exposes the expected schema/identity", () => {
    const tool = createNotebookEditTool({ workspaceRoot: workspace });
    expect(tool.name).toBe("NotebookEdit");
    expect(tool.inputSchema.required).toEqual(["notebook_path"]);
    expect(tool.requiresApproval).toBe(true);
    expect(tool.metadata.mutating).toBe(true);
  });

  describe("validation errors", () => {
    let tool: ReturnType<typeof createNotebookEditTool>;
    beforeEach(() => {
      tool = createNotebookEditTool({ workspaceRoot: workspace });
    });

    it("rejects a missing notebook_path", async () => {
      const result = await tool.execute({});
      expect(result.isError).toBe(true);
    });

    it("rejects a bad edit_mode", async () => {
      const path = await writeNotebook("n.ipynb", notebook([]));
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "frobnicate",
        new_source: "x",
        cell_id: "a",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("Edit mode");
    });

    it("rejects a non-string new_source on non-delete edits", async () => {
      const path = await writeNotebook("n.ipynb", notebook([]));
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "a",
        new_source: 42,
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("new_source");
    });

    it("rejects a bad cell_type", async () => {
      const path = await writeNotebook("n.ipynb", notebook([]));
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "insert",
        new_source: "x",
        cell_type: "diagram",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("Cell type");
    });

    it("rejects insert without cell_type", async () => {
      const path = await writeNotebook("n.ipynb", notebook([]));
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "insert",
        new_source: "x",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("required when using edit_mode=insert");
    });

    it("rejects non-insert without cell_id", async () => {
      const path = await writeNotebook("n.ipynb", notebook([]));
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        new_source: "x",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("Cell ID must be specified");
    });

    it("rejects a non-.ipynb extension", async () => {
      const path = join(workspace, "n.txt");
      await writeFile(path, "{}", "utf8");
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "insert",
        cell_type: "code",
        new_source: "x",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain(".ipynb");
    });

    it("rejects a path outside the workspace", async () => {
      const outside = await mkdtemp(join(tmpdir(), "agenc-notebook-outside-"));
      try {
        const path = join(outside, "n.ipynb");
        await writeFile(path, JSON.stringify(notebook([])), "utf8");
        const result = await tool.execute({
          notebook_path: path,
          edit_mode: "insert",
          cell_type: "code",
          new_source: "x",
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content).error).toContain("Access denied");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects a nonexistent file", async () => {
      const result = await tool.execute({
        notebook_path: join(workspace, "missing.ipynb"),
        edit_mode: "insert",
        cell_type: "code",
        new_source: "x",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("does not exist");
    });

    it("rejects non-JSON content", async () => {
      const path = join(workspace, "bad.ipynb");
      await writeFile(path, "not json", "utf8");
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "insert",
        cell_type: "code",
        new_source: "x",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("not valid JSON");
    });

    it("rejects JSON lacking a cells array", async () => {
      const path = await writeNotebook("nocells.ipynb", { nbformat: 4 });
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "insert",
        cell_type: "code",
        new_source: "x",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("expected a cells array");
    });
  });

  describe("replace mode", () => {
    it("resets outputs/execution_count for a code cell", async () => {
      const path = await writeNotebook(
        "n.ipynb",
        notebook([
          {
            id: "c1",
            cell_type: "code",
            source: "old",
            execution_count: 7,
            outputs: [{ output_type: "stream" }],
          },
        ]),
      );
      const tool = createNotebookEditTool({ workspaceRoot: workspace });
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "c1",
        new_source: "new",
      });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      const updated = JSON.parse(payload.updated_file);
      expect(updated.cells[0].source).toBe("new");
      expect(updated.cells[0].execution_count).toBeNull();
      expect(updated.cells[0].outputs).toEqual([]);
    });

    it("deletes outputs/execution_count when switching to markdown", async () => {
      const path = await writeNotebook(
        "n.ipynb",
        notebook([
          {
            id: "c1",
            cell_type: "code",
            source: "old",
            execution_count: 1,
            outputs: [],
          },
        ]),
      );
      const tool = createNotebookEditTool({ workspaceRoot: workspace });
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "c1",
        cell_type: "markdown",
        new_source: "# title",
      });
      const updated = JSON.parse(JSON.parse(result.content).updated_file);
      expect(updated.cells[0].cell_type).toBe("markdown");
      expect(updated.cells[0]).not.toHaveProperty("execution_count");
      expect(updated.cells[0]).not.toHaveProperty("outputs");
    });
  });

  describe("insert mode", () => {
    it("generates an agenc id on nbformat >= 4.5", async () => {
      const path = await writeNotebook(
        "n.ipynb",
        notebook([{ id: "c1", cell_type: "code", source: "a" }], 5),
      );
      const tool = createNotebookEditTool({ workspaceRoot: workspace });
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "insert",
        cell_id: "c1",
        cell_type: "code",
        new_source: "b",
      });
      const payload = JSON.parse(result.content);
      expect(payload.cell_id).toMatch(/^agenc-/);
      const updated = JSON.parse(payload.updated_file);
      expect(updated.cells[1].source).toBe("b");
      expect(updated.cells[1].execution_count).toBeNull();
      expect(updated.cells[1].outputs).toEqual([]);
    });

    it("does not generate an id on nbformat 4.4", async () => {
      const path = await writeNotebook(
        "n44.ipynb",
        notebook([{ id: "c1", cell_type: "code", source: "a" }], 4),
      );
      const tool = createNotebookEditTool({ workspaceRoot: workspace });
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "insert",
        cell_id: "c1",
        cell_type: "code",
        new_source: "b",
      });
      const payload = JSON.parse(result.content);
      // No new id is generated on pre-4.5 notebooks, so the inserted cell
      // carries no id and the response echoes the input cell_id unchanged
      // rather than a freshly generated agenc-* id.
      expect(payload.cell_id).not.toMatch(/^agenc-/);
      const updated = JSON.parse(payload.updated_file);
      expect(updated.cells[1]).not.toHaveProperty("id");
    });
  });

  describe("delete mode", () => {
    it("removes the cell and omits cell_type/new_source", async () => {
      const path = await writeNotebook(
        "n.ipynb",
        notebook([
          { id: "c1", cell_type: "code", source: "a" },
          { id: "c2", cell_type: "code", source: "b" },
        ]),
      );
      const tool = createNotebookEditTool({ workspaceRoot: workspace });
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "delete",
        cell_id: "c1",
      });
      const payload = JSON.parse(result.content);
      expect(payload).not.toHaveProperty("cell_type");
      expect(payload).not.toHaveProperty("new_source");
      const updated = JSON.parse(payload.updated_file);
      expect(updated.cells).toHaveLength(1);
      expect(updated.cells[0].id).toBe("c2");
    });
  });

  describe("cell lookup edge cases", () => {
    let tool: ReturnType<typeof createNotebookEditTool>;
    let path: string;
    beforeEach(async () => {
      tool = createNotebookEditTool({ workspaceRoot: workspace });
      path = await writeNotebook(
        "n.ipynb",
        notebook([
          { id: "first", cell_type: "code", source: "a" },
          { id: "second", cell_type: "code", source: "b" },
        ]),
      );
    });

    it("resolves a literal id", async () => {
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "second",
        new_source: "x",
      });
      expect(result.isError).toBeUndefined();
      const updated = JSON.parse(JSON.parse(result.content).updated_file);
      expect(updated.cells[1].source).toBe("x");
    });

    it("resolves a numeric index", async () => {
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "0",
        new_source: "x",
      });
      const updated = JSON.parse(JSON.parse(result.content).updated_file);
      expect(updated.cells[0].source).toBe("x");
    });

    it("resolves a cell-N index", async () => {
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "cell-1",
        new_source: "x",
      });
      const updated = JSON.parse(JSON.parse(result.content).updated_file);
      expect(updated.cells[1].source).toBe("x");
    });

    it("rejects an out-of-range numeric index", async () => {
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "9",
        new_source: "x",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("does not exist");
    });

    it("rejects an unknown non-numeric id", async () => {
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "nope",
        new_source: "x",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("not found");
    });
  });

  describe("language resolution", () => {
    it("reflects metadata.language_info.name", async () => {
      const nb = notebook([{ id: "c1", cell_type: "code", source: "a" }]);
      (nb.metadata as Record<string, unknown>).language_info = { name: "rust" };
      const path = await writeNotebook("n.ipynb", nb);
      const tool = createNotebookEditTool({ workspaceRoot: workspace });
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "c1",
        new_source: "x",
      });
      expect(JSON.parse(result.content).language).toBe("rust");
    });

    it("defaults to python when language_info is absent", async () => {
      const path = await writeNotebook("n.ipynb", {
        nbformat: 4,
        nbformat_minor: 5,
        cells: [{ id: "c1", cell_type: "code", source: "a" }],
      });
      const tool = createNotebookEditTool({ workspaceRoot: workspace });
      const result = await tool.execute({
        notebook_path: path,
        edit_mode: "replace",
        cell_id: "c1",
        new_source: "x",
      });
      expect(JSON.parse(result.content).language).toBe("python");
    });
  });

  it("enforces the read-gate when a signed session id is present", async () => {
    const path = await writeNotebook(
      "n.ipynb",
      notebook([{ id: "c1", cell_type: "code", source: "a" }]),
    );
    const tool = createNotebookEditTool({ workspaceRoot: workspace });
    const result = await tool.execute({
      notebook_path: path,
      edit_mode: "replace",
      cell_id: "c1",
      new_source: "x",
      __agencSessionId: `notebook-read-gate-${Date.now()}`,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("has not been read yet");
  });
});
