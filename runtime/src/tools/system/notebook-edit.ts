import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

import { checkToolPathPermission } from "../../permissions/path-validation.js";
import { isRecord } from "../../utils/record.js";
import { nonEmptyString as stringValue } from "../../utils/stringUtils.js";
import type { Tool, ToolResult } from "../types.js";
import {
  getSessionReadSnapshot,
  hasSessionRead,
  recordSessionRead,
  resolveSessionId,
  safePathAllowingSessionPlanFile,
} from "./filesystem.js";

export const NOTEBOOK_EDIT_TOOL_NAME = "NotebookEdit";
const MAX_NOTEBOOK_EDIT_BYTES = 16 * 1024 * 1024;

export interface NotebookEditToolConfig {
  readonly workspaceRoot: string;
}

function json(value: Record<string, unknown>, isError = false): ToolResult {
  return { content: JSON.stringify(value), ...(isError ? { isError: true } : {}) };
}

function parseNotebookCellIndex(cellId: string): number | undefined {
  const normalized = /^cell-(\d+)$/u.exec(cellId)?.[1] ?? cellId;
  if (!/^\d+$/u.test(normalized)) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function findNotebookCellIndex(
  cells: readonly unknown[],
  cellId: string,
): number | { error: string } {
  const found = cells.findIndex(
    (cell) => isRecord(cell) && cell.id === cellId,
  );
  if (found >= 0) return found;

  const numericIndex = parseNotebookCellIndex(cellId);
  if (numericIndex !== undefined) {
    return cells[numericIndex] === undefined
      ? { error: `Cell with index ${numericIndex} does not exist in notebook.` }
      : numericIndex;
  }
  return { error: `Cell with ID "${cellId}" not found in notebook.` };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function notebookSupportsCellIds(notebook: Record<string, unknown>): boolean {
  const nbformat = typeof notebook.nbformat === "number" ? notebook.nbformat : 0;
  const nbformatMinor =
    typeof notebook.nbformat_minor === "number" ? notebook.nbformat_minor : 0;
  return nbformat > 4 || (nbformat === 4 && nbformatMinor >= 5);
}

function generateNotebookCellId(cells: readonly unknown[]): string {
  const existing = new Set(
    cells
      .map((cell) => (isRecord(cell) && typeof cell.id === "string" ? cell.id : null))
      .filter((value): value is string => value !== null),
  );
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `agenc-${index.toString(36)}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `agenc-${Date.now().toString(36)}`;
}

function notebookLanguage(notebook: Record<string, unknown>): string | undefined {
  const metadata = isRecord(notebook.metadata) ? notebook.metadata : undefined;
  const languageInfo = isRecord(metadata?.language_info)
    ? metadata.language_info
    : undefined;
  return typeof languageInfo?.name === "string" &&
    languageInfo.name.trim().length > 0
    ? languageInfo.name
    : "python";
}

export function createNotebookEditTool(config: NotebookEditToolConfig): Tool {
  return {
    name: NOTEBOOK_EDIT_TOOL_NAME,
    description:
      "Edit Jupyter notebook cells by cell id or insertion point. Requires a .ipynb file in the workspace.",
    metadata: {
      family: "coding",
      source: "builtin",
      keywords: ["notebook", "ipynb", "edit"],
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: true,
    },
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        notebook_path: { type: "string" },
        cell_id: { type: "string" },
        new_source: { type: "string" },
        cell_type: { type: "string", enum: ["code", "markdown"] },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
      },
      required: ["notebook_path"],
      additionalProperties: false,
    },
    checkPermissions(input, context) {
      const args = input as Record<string, unknown>;
      const notebookPath = stringValue(args.notebook_path);
      if (!notebookPath) {
        return {
          behavior: "ask",
          message: "notebook_path must be a non-empty string",
        };
      }
      return checkToolPathPermission({
        toolName: NOTEBOOK_EDIT_TOOL_NAME,
        input: { ...args, file_path: notebookPath },
        path: notebookPath,
        cwd: config.workspaceRoot,
        context: context.getAppState().toolPermissionContext,
        operationType: "write",
        extraWorkingDirectories: [config.workspaceRoot],
      });
    },
    async execute(args) {
      const notebookPath = stringValue(args.notebook_path);
      if (!notebookPath) return json({ error: "notebook_path is required" }, true);
      const editMode = stringValue(args.edit_mode) ?? "replace";
      if (
        editMode !== "replace" &&
        editMode !== "insert" &&
        editMode !== "delete"
      ) {
        return json({ error: "Edit mode must be replace, insert, or delete." }, true);
      }
      if (editMode !== "delete" && typeof args.new_source !== "string") {
        return json({ error: "new_source must be a string" }, true);
      }
      const cellType = stringValue(args.cell_type);
      if (
        cellType !== undefined &&
        cellType !== "code" &&
        cellType !== "markdown"
      ) {
        return json({ error: "Cell type must be code or markdown." }, true);
      }
      if (editMode === "insert" && cellType === undefined) {
        return json({ error: "Cell type is required when using edit_mode=insert." }, true);
      }
      const cellId = stringValue(args.cell_id);
      if (editMode !== "insert" && cellId === undefined) {
        return json({
          error: "Cell ID must be specified when not inserting a new cell.",
        }, true);
      }

      const requestedPath = isAbsolute(notebookPath)
        ? notebookPath
        : resolve(config.workspaceRoot, notebookPath);
      if (extname(requestedPath).toLowerCase() !== ".ipynb") {
        return json({ error: "NotebookEdit only supports .ipynb files." }, true);
      }
      const safe = await safePathAllowingSessionPlanFile(
        requestedPath,
        [config.workspaceRoot],
        { ...args, file_path: requestedPath, cwd: config.workspaceRoot },
      );
      if (!safe.safe) {
        return json({ error: `Access denied: ${safe.reason}` }, true);
      }
      const filePath = safe.resolved;

      try {
        const fileStats = await stat(filePath);
        if (!fileStats.isFile()) {
          return json({ error: "Path is not a regular file" }, true);
        }
        if (fileStats.size > MAX_NOTEBOOK_EDIT_BYTES) {
          return json(
            {
              error: `Notebook size ${formatBytes(fileStats.size)} exceeds the notebook-edit limit of ${formatBytes(MAX_NOTEBOOK_EDIT_BYTES)}.`,
            },
            true,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return json({ error: "Notebook file does not exist." }, true);
        }
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }

      const sessionId = resolveSessionId(args);
      if (sessionId !== undefined && !hasSessionRead(sessionId, filePath)) {
        return json(
          { error: "File has not been read yet. Read it first before writing to it." },
          true,
        );
      }

      let original: string;
      try {
        original = await readFile(filePath, "utf8");
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }

      if (sessionId !== undefined) {
        const snapshot = getSessionReadSnapshot(sessionId, filePath);
        const snapshotContent =
          typeof snapshot?.rawContent === "string"
            ? snapshot.rawContent
            : snapshot?.content;
        if (
          snapshot?.viewKind !== "full" ||
          typeof snapshotContent !== "string"
        ) {
          return json(
            { error: "File has not been read yet. Read it first before writing to it." },
            true,
          );
        }
        if (original !== snapshotContent) {
          return json(
            {
              error:
                "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
            },
            true,
          );
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(original);
      } catch {
        return json({ error: "Notebook is not valid JSON." }, true);
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.cells)) {
        return json({ error: "Invalid notebook: expected a cells array" }, true);
      }

      const cells = parsed.cells;
      let index = 0;
      if (cellId !== undefined) {
        const found = findNotebookCellIndex(cells, cellId);
        if (typeof found !== "number") return json({ error: found.error }, true);
        index = editMode === "insert" ? found + 1 : found;
      }

      let resultCellId: string | undefined = cellId;
      let resultCellType: string | undefined;
      if (editMode === "delete") {
        const cell = cells[index];
        resultCellType =
          isRecord(cell) && typeof cell.cell_type === "string"
            ? cell.cell_type
            : undefined;
        cells.splice(index, 1);
      } else if (editMode === "insert") {
        resultCellType = cellType ?? "code";
        const newCell: Record<string, unknown> = {
          cell_type: resultCellType,
          metadata: {},
          source: args.new_source,
        };
        if (notebookSupportsCellIds(parsed)) {
          resultCellId = generateNotebookCellId(cells);
          newCell.id = resultCellId;
        }
        if (resultCellType === "code") {
          newCell.execution_count = null;
          newCell.outputs = [];
        }
        cells.splice(index, 0, newCell);
      } else {
        const cell = cells[index];
        if (!isRecord(cell)) return json({ error: "Invalid notebook cell." }, true);
        cell.source = args.new_source;
        const finalCellType =
          cellType ??
          (typeof cell.cell_type === "string" ? cell.cell_type : undefined);
        if (cellType !== undefined && cellType !== cell.cell_type) {
          cell.cell_type = cellType;
        }
        if (finalCellType === "code") {
          cell.execution_count = null;
          cell.outputs = [];
        } else {
          delete cell.execution_count;
          delete cell.outputs;
        }
        resultCellType = finalCellType;
      }

      const updated = JSON.stringify(parsed, null, 1);
      await writeFile(filePath, updated, "utf8");
      if (sessionId !== undefined) {
        let mtimeMs = Date.now();
        try {
          const postWriteStats = await stat(filePath);
          if (Number.isFinite(postWriteStats.mtimeMs)) {
            mtimeMs = postWriteStats.mtimeMs;
          }
        } catch {
          // Best effort: keep the session snapshot useful after the write.
        }
        recordSessionRead(sessionId, filePath, {
          content: updated,
          rawContent: updated,
          timestamp: mtimeMs,
          viewKind: "full",
        });
      }

      return json({
        notebook_path: filePath,
        cell_id: resultCellId,
        ...(editMode !== "delete" && resultCellType !== undefined
          ? { cell_type: resultCellType }
          : {}),
        language: notebookLanguage(parsed),
        edit_mode: editMode,
        ...(editMode !== "delete" ? { new_source: args.new_source } : {}),
        original_file: original,
        updated_file: updated,
      });
    },
  };
}
