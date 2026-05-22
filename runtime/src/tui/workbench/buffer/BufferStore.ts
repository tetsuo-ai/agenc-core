import { relative, resolve } from "node:path";

import { getCwd } from "../../../utils/cwd.js";
import {
  bufferText,
  createBufferDocument,
  currentSelection,
  deleteBackward,
  deleteForward,
  documentPosition,
  insertBufferText,
  moveBufferCursor,
  moveBufferCursorToLine,
  redoBufferChange,
  type BufferDocument,
  type BufferMove,
  type BufferSelection,
  undoBufferChange,
} from "./editing.js";
import type { BufferFileEncoding, BufferLineEndings, BufferFileSnapshot } from "./fileSnapshot.js";
import { BufferSaveConflictError, readBufferFileSnapshot, saveBufferFileSnapshot } from "./fileSnapshot.js";
import {
  notifyBufferLspChanged,
  notifyBufferLspClosed,
  notifyBufferLspOpened,
  notifyBufferLspSaved,
  requestBufferDefinition,
  requestBufferHover,
} from "./lsp.js";

export type BufferStatus = "idle" | "loading" | "ready" | "saving" | "error" | "conflict";
export type BufferConflictKind = "disk" | "agent" | null;

export type BufferPosition = {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
};

export type BufferVisibleLine = {
  readonly number: number;
  readonly text: string;
  readonly from: number;
  readonly to: number;
};

export type WorkbenchBufferSnapshot = {
  readonly status: BufferStatus;
  readonly filePath: string | null;
  readonly absolutePath: string | null;
  readonly dirty: boolean;
  readonly lineCount: number;
  readonly position: BufferPosition;
  readonly selection: BufferSelection;
  readonly scrollLine: number;
  readonly viewportRows: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly error: string | null;
  readonly conflictKind: BufferConflictKind;
  readonly encoding: BufferFileEncoding | null;
  readonly lineEndings: BufferLineEndings | null;
  readonly hoverText: string | null;
};

type Listener = () => void;

const EMPTY_SELECTION: BufferSelection = { anchor: 0, head: 0 };
const EMPTY_POSITION: BufferPosition = { line: 1, column: 0, offset: 0 };
const DEFAULT_VIEWPORT_ROWS = 20;

export class WorkbenchBufferStore {
  #listeners = new Set<Listener>();
  #file: BufferFileSnapshot | null = null;
  #document: BufferDocument | null = null;
  #status: BufferStatus = "idle";
  #error: string | null = null;
  #conflictKind: BufferConflictKind = null;
  #hoverText: string | null = null;
  #scrollLine = 0;
  #viewportRows = DEFAULT_VIEWPORT_ROWS;
  #openGeneration = 0;
  #snapshot: WorkbenchBufferSnapshot = this.#createSnapshot();

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): WorkbenchBufferSnapshot => this.#snapshot;

  getText(): string {
    return this.#document ? bufferText(this.#document) : "";
  }

  getVisibleLines(): readonly BufferVisibleLine[] {
    const document = this.#document;
    if (!document) return [];
    const start = Math.max(1, this.#scrollLine + 1);
    const end = Math.min(document.state.doc.lines, start + this.#viewportRows - 1);
    const lines: BufferVisibleLine[] = [];
    for (let number = start; number <= end; number += 1) {
      const line = document.state.doc.line(number);
      lines.push({
        number,
        text: line.text,
        from: line.from,
        to: line.to,
      });
    }
    return lines;
  }

  async open(filePath: string, line = 1): Promise<void> {
    await this.#load(filePath, line, false);
  }

  close(options: { readonly discard?: boolean } = {}): boolean {
    if (this.#isDirty() && options.discard !== true) {
      this.#setProblem("conflict", "Unsaved edits. Save, revert, or close-discard before closing.", "disk");
      return false;
    }
    if (this.#file) notifyBufferLspClosed(this.#file.absolutePath);
    this.#file = null;
    this.#document = null;
    this.#status = "idle";
    this.#error = null;
    this.#conflictKind = null;
    this.#hoverText = null;
    this.#scrollLine = 0;
    this.#emit();
    return true;
  }

  async revert(): Promise<void> {
    const file = this.#file;
    if (!file) return;
    await this.#load(file.absolutePath, this.#position().line, true, file.filePath);
  }

  async save(options: { readonly hasInFlightAgent?: boolean } = {}): Promise<boolean> {
    const file = this.#file;
    const document = this.#document;
    if (!file || !document) return false;
    if (!this.#isDirty()) {
      this.#status = "ready";
      this.#error = null;
      this.#conflictKind = null;
      this.#emit();
      return true;
    }
    if (options.hasInFlightAgent) {
      this.#setProblem("conflict", "An agent appears to be editing this file. Wait or close-discard before saving.", "agent");
      return false;
    }

    this.#status = "saving";
    this.#error = null;
    this.#conflictKind = null;
    this.#emit();

    try {
      const nextFile = await saveBufferFileSnapshot(file, bufferText(document));
      this.#file = nextFile;
      this.#status = "ready";
      this.#error = null;
      this.#conflictKind = null;
      this.#hoverText = null;
      notifyBufferLspSaved(nextFile.absolutePath);
      this.#emit();
      return true;
    } catch (error) {
      if (error instanceof BufferSaveConflictError) {
        this.#setProblem("conflict", error.message, "disk");
      } else {
        this.#setProblem("error", errorMessage(error), null);
      }
      return false;
    }
  }

  insert(text: string): void {
    this.#edit((document) => insertBufferText(document, text));
  }

  newline(): void {
    this.insert("\n");
  }

  backspace(): void {
    this.#edit(deleteBackward);
  }

  deleteForward(): void {
    this.#edit(deleteForward);
  }

  move(move: BufferMove, options: { readonly extend?: boolean; readonly pageSize?: number } = {}): void {
    this.#replaceDocument((document) => moveBufferCursor(document, move, options), false);
  }

  undo(): void {
    this.#replaceDocument(undoBufferChange, true);
  }

  redo(): void {
    this.#replaceDocument(redoBufferChange, true);
  }

  setViewportRows(rows: number): void {
    const nextRows = Math.max(1, Math.floor(rows));
    if (nextRows === this.#viewportRows) return;
    this.#viewportRows = nextRows;
    this.#ensureCursorVisible();
    this.#emit();
  }

  async requestHover(): Promise<string | null> {
    const file = this.#file;
    const document = this.#document;
    if (!file || !document) return null;
    const position = this.#lspPosition(document);
    const hover = await requestBufferHover(file.absolutePath, position).catch(() => null);
    this.#hoverText = hover;
    this.#emit();
    return hover;
  }

  async goToDefinition(): Promise<boolean> {
    const file = this.#file;
    const document = this.#document;
    if (!file || !document) return false;
    const target = await requestBufferDefinition(file.absolutePath, this.#lspPosition(document)).catch(() => null);
    if (!target) return false;
    await this.#load(target.path, target.line, false, displayPathForAbsolute(target.path));
    return true;
  }

  #edit(update: (document: BufferDocument) => BufferDocument): void {
    this.#replaceDocument(update, true);
  }

  #replaceDocument(update: (document: BufferDocument) => BufferDocument, notifyLsp: boolean): void {
    const current = this.#document;
    if (!current) return;
    const previousText = bufferText(current);
    const next = update(current);
    if (next === current) return;
    this.#document = next;
    this.#status = "ready";
    this.#error = null;
    this.#conflictKind = null;
    this.#hoverText = null;
    this.#ensureCursorVisible();
    const nextText = bufferText(next);
    if (notifyLsp && nextText !== previousText && this.#file) {
      notifyBufferLspChanged(this.#file.absolutePath, nextText);
    }
    this.#emit();
  }

  async #load(
    filePath: string,
    line: number,
    allowDirtyReplace: boolean,
    displayPath = filePath,
  ): Promise<void> {
    const absolutePath = resolve(getCwd(), filePath);
    if (this.#file?.absolutePath === absolutePath && !allowDirtyReplace) {
      if (this.#document) {
        this.#document = moveBufferCursorToLine(this.#document, line);
        this.#ensureCursorVisible();
        this.#emit();
      }
      return;
    }
    if (this.#isDirty() && !allowDirtyReplace) {
      this.#setProblem("conflict", "Unsaved edits. Save, revert, or close-discard before opening another file.", "disk");
      return;
    }

    const generation = ++this.#openGeneration;
    const previousPath = this.#file?.absolutePath;
    this.#status = "loading";
    this.#error = null;
    this.#conflictKind = null;
    this.#hoverText = null;
    this.#file = null;
    this.#document = null;
    this.#scrollLine = 0;
    this.#emit();

    try {
      const snapshot = await readBufferFileSnapshot(absolutePath, {
        displayPath,
      });
      if (generation !== this.#openGeneration) return;
      if (previousPath && previousPath !== snapshot.absolutePath) notifyBufferLspClosed(previousPath);
      this.#file = snapshot;
      this.#document = createBufferDocument(snapshot.content, line);
      this.#status = "ready";
      this.#error = null;
      this.#conflictKind = null;
      this.#hoverText = null;
      this.#ensureCursorVisible();
      notifyBufferLspOpened(snapshot.absolutePath, snapshot.content);
      this.#emit();
    } catch (error) {
      if (generation !== this.#openGeneration) return;
      this.#status = "error";
      this.#error = errorMessage(error);
      this.#conflictKind = null;
      this.#emit();
    }
  }

  #isDirty(): boolean {
    return Boolean(this.#file && this.#document && this.#file.content !== bufferText(this.#document));
  }

  #position(): BufferPosition {
    return this.#document ? documentPosition(this.#document) : EMPTY_POSITION;
  }

  #lspPosition(document: BufferDocument): { readonly line: number; readonly character: number } {
    const selection = currentSelection(document);
    const line = document.state.doc.lineAt(selection.head);
    return {
      line: line.number - 1,
      character: selection.head - line.from,
    };
  }

  #ensureCursorVisible(): void {
    const line = this.#position().line;
    if (line <= this.#scrollLine) {
      this.#scrollLine = Math.max(0, line - 1);
      return;
    }
    const bottom = this.#scrollLine + this.#viewportRows;
    if (line > bottom) {
      this.#scrollLine = Math.max(0, line - this.#viewportRows);
    }
  }

  #setProblem(status: "error" | "conflict", message: string, conflictKind: BufferConflictKind): void {
    this.#status = status;
    this.#error = message;
    this.#conflictKind = conflictKind;
    this.#emit();
  }

  #createSnapshot(): WorkbenchBufferSnapshot {
    const document = this.#document;
    const file = this.#file;
    const position = this.#position();
    return {
      status: this.#status,
      filePath: file?.filePath ?? null,
      absolutePath: file?.absolutePath ?? null,
      dirty: this.#isDirty(),
      lineCount: document?.state.doc.lines ?? 0,
      position,
      selection: document ? currentSelection(document) : EMPTY_SELECTION,
      scrollLine: this.#scrollLine,
      viewportRows: this.#viewportRows,
      canUndo: Boolean(document?.undoStack.length),
      canRedo: Boolean(document?.redoStack.length),
      error: this.#error,
      conflictKind: this.#conflictKind,
      encoding: file?.encoding ?? null,
      lineEndings: file?.lineEndings ?? null,
      hoverText: this.#hoverText,
    };
  }

  #emit(): void {
    this.#snapshot = this.#createSnapshot();
    for (const listener of this.#listeners) listener();
  }
}

function displayPathForAbsolute(absolutePath: string): string {
  const cwd = getCwd();
  const relativePath = relative(cwd, absolutePath);
  return relativePath.startsWith("..") || relativePath === "" || resolve(cwd, relativePath) !== absolutePath
    ? absolutePath
    : relativePath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let singleton: WorkbenchBufferStore | null = null;

export function getWorkbenchBufferStore(): WorkbenchBufferStore {
  singleton ??= new WorkbenchBufferStore();
  return singleton;
}

export function resetWorkbenchBufferStoreForTesting(): void {
  singleton = new WorkbenchBufferStore();
}
