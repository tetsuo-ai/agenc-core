import { relative, resolve } from "node:path";

import { getCwd } from "../../../utils/cwd.js";
import { lastGrapheme } from "../../../utils/intl.js";
import { logError } from "../../../utils/log.js";
import { TextCursor } from "../../../utils/TextCursor.js";
import type { VimMode } from "../../../types/textInputTypes.js";
import type { Key } from "../../ink.js";
import { isRelativePathOutsideBase } from "../../pathDisplay.js";
import {
  executeIndent,
  executeJoin,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeX,
} from "../../vim/operators.js";
import { resolveMotion } from "../../vim/motions.js";
import { transition, type TransitionContext } from "../../vim/transitions.js";
import {
  createInitialPersistentState,
  type PersistentState,
  type RecordedChange,
  SIMPLE_MOTIONS,
  type VimState,
} from "../../vim/types.js";
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
  nextGraphemeOffset,
  previousGraphemeOffset,
  replaceBufferRange,
  redoBufferChange,
  replaceBufferText,
  setBufferCursorOffset,
  setBufferSelection,
  selectionBounds,
  type BufferDocument,
  type BufferMove,
  type BufferSelection,
  undoBufferChange,
} from "./editing.js";
import { openFileInBufferExternalEditor, type BufferExternalEditorLauncher } from "./externalEditor.js";
import type { BufferFileEncoding, BufferLineEndings, BufferFileSnapshot } from "./fileSnapshot.js";
import {
  BufferSaveConflictError,
  readBufferFileSnapshot,
  resolveBufferFilePath,
  saveBufferFileSnapshot,
} from "./fileSnapshot.js";
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
  readonly vimMode: VimMode;
  readonly vimCommandLine: string | null;
};

type Listener = () => void;
export type BufferVimCommand =
  | { readonly type: "save"; readonly force: boolean }
  | { readonly type: "quit"; readonly discard: boolean; readonly all: boolean }
  | { readonly type: "saveQuit"; readonly force: boolean; readonly all: boolean };

type BufferVimCommandHandler = (command: BufferVimCommand) => void;
export type WorkbenchBufferStoreOptions = {
  readonly openExternalEditor?: BufferExternalEditorLauncher;
};
type BufferLoadOptions = {
  readonly preserveCurrentOnError?: boolean;
  readonly basePath?: string;
};
type VimEditSession = {
  readonly context: TransitionContext;
  readonly flush: () => void;
};

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
  #workspaceBasePath: string | null = null;
  #vimCommandLine: string | null = null;
  #vimState: VimState = { mode: "NORMAL", command: { type: "idle" } };
  #visualAnchor: number | null = null;
  #vimPersistentState: PersistentState = createInitialPersistentState();
  #openExternalEditor: BufferExternalEditorLauncher = openFileInBufferExternalEditor;
  #snapshot: WorkbenchBufferSnapshot = this.#createSnapshot();

  constructor(options: WorkbenchBufferStoreOptions = {}) {
    this.#openExternalEditor = options.openExternalEditor ?? openFileInBufferExternalEditor;
  }

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
    this.#openGeneration += 1;
    const closedFile = this.#file;
    if (closedFile) safeNotifyBufferLsp(() => notifyBufferLspClosed(closedFile.absolutePath));
    this.#file = null;
    this.#document = null;
    this.#workspaceBasePath = null;
    this.#status = "idle";
    this.#error = null;
    this.#conflictKind = null;
    this.#hoverText = null;
    this.#scrollLine = 0;
    this.#resetVimState();
    this.#emit();
    return true;
  }

  async revert(): Promise<void> {
    const file = this.#file;
    if (!file) return;
    await this.#load(file.absolutePath, this.#position().line, true, file.filePath, {
      basePath: this.#workspaceBasePath ?? getCwd(),
    });
  }

  async save(options: { readonly hasInFlightAgent?: boolean; readonly force?: boolean } = {}): Promise<boolean> {
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
      const nextFile = await saveBufferFileSnapshot(file, bufferText(document), { force: options.force });
      this.#file = nextFile;
      this.#status = "ready";
      this.#error = null;
      this.#conflictKind = null;
      this.#hoverText = null;
      safeNotifyBufferLsp(() => notifyBufferLspSaved(nextFile.absolutePath));
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

  async openExternalEditor(): Promise<boolean> {
    const file = this.#file;
    if (!file) return false;
    if (this.#isDirty()) {
      this.#setProblem("conflict", "Save or revert inline edits before opening the external editor.", "disk");
      return false;
    }

    const line = this.#position().line;
    let opened: boolean;
    try {
      opened = this.#openExternalEditor(file.absolutePath, line);
    } catch (error) {
      logError(error);
      this.#setProblem("error", `Failed to open external editor: ${errorMessage(error)}`, null);
      return false;
    }
    if (!opened) {
      this.#setProblem("error", "No external editor is available for BUFFER. Set $VISUAL or $EDITOR, or install nvim/vim.", null);
      return false;
    }

    return this.#load(file.absolutePath, line, true, file.filePath, {
      basePath: this.#workspaceBasePath ?? getCwd(),
    });
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

  handleVimInput(input: string, key: Key, columns: number, onCommand?: BufferVimCommandHandler): boolean {
    if (!this.#document) return false;

    if (this.#vimCommandLine !== null) {
      return this.#handleVimCommandLineInput(input, key, onCommand);
    }

    if (key.ctrl || key.super || (key.meta && !key.escape)) return false;

    if (this.#visualAnchor !== null) {
      return this.#handleVimVisualInput(input, key, columns);
    }

    const state = this.#vimState;
    if (key.escape && state.mode === "INSERT") {
      this.#switchToNormalMode();
      return true;
    }
    if (key.escape && state.mode === "NORMAL") {
      // With no vim command pending there is nothing to cancel: let esc
      // bubble to the workbench keybindings so it leaves the buffer for the
      // composer (users were trapped inside the basic-fallback editor).
      if (state.command.type === "idle") return false;
      this.#vimState = { mode: "NORMAL", command: { type: "idle" } };
      this.#emit();
      return true;
    }

    if (state.mode === "INSERT") {
      if (isNavigationKey(key)) return false;
      this.#handleVimInsertInput(input, key);
      return true;
    }

    if (input === ":") {
      this.#vimCommandLine = "";
      this.#error = null;
      this.#conflictKind = null;
      this.#emit();
      return true;
    }

    if (input === "v") {
      this.#enterVisualMode();
      return true;
    }

    if (key.return || input === "\r" || input === "\n") {
      return false;
    }
    if (isShiftSelectionNavigationKey(key)) {
      return false;
    }

    const vimInput = normalizeVimNormalInput(input, key);
    if (vimInput === null) {
      return key.tab || input.length > 0;
    }

    const session = this.#createVimEditSession(columns);
    const result = transition(state.command, vimInput, session.context);
    result.execute?.();
    session.flush();

    if (this.#vimState.mode === "NORMAL") {
      this.#vimState = {
        mode: "NORMAL",
        command: result.next ?? { type: "idle" },
      };
      this.#emit();
    }
    return true;
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
    const hover = await requestBufferHover(file.absolutePath, position).catch(error => {
      logError(error);
      return null;
    });
    if (this.#file !== file || this.#document !== document) return null;
    this.#hoverText = hover;
    this.#emit();
    return hover;
  }

  async goToDefinition(): Promise<boolean> {
    const file = this.#file;
    const document = this.#document;
    if (!file || !document) return false;
    const position = this.#lspPosition(document);
    const target = await requestBufferDefinition(file.absolutePath, position).catch(error => {
      logError(error);
      return null;
    });
    if (!target || this.#file !== file || this.#document !== document) return false;
    return this.#load(target.path, target.line, false, displayPathForAbsolute(target.path), {
      basePath: this.#workspaceBasePath ?? getCwd(),
      preserveCurrentOnError: true,
    });
  }

  #handleVimCommandLineInput(input: string, key: Key, onCommand?: BufferVimCommandHandler): boolean {
    if (key.escape || (key.ctrl && input.toLowerCase() === "c")) {
      this.#vimCommandLine = null;
      this.#emit();
      return true;
    }

    if (key.return) {
      const rawCommand = this.#vimCommandLine ?? "";
      this.#vimCommandLine = null;
      const command = parseVimCommand(rawCommand);
      if (!command) {
        this.#setProblem("error", `Unknown Vim command: :${rawCommand.trim()}`, null);
        return true;
      }
      this.#emit();
      onCommand?.(command);
      return true;
    }

    if (key.backspace || key.delete) {
      this.#vimCommandLine = removeLastGrapheme(this.#vimCommandLine ?? "");
      this.#emit();
      return true;
    }

    if (key.ctrl || key.super || key.meta) return true;

    if (input.length > 0) {
      this.#vimCommandLine = `${this.#vimCommandLine ?? ""}${input}`;
      this.#emit();
      return true;
    }

    return true;
  }

  #handleVimInsertInput(input: string, key: Key): void {
    const state = this.#vimState.mode === "INSERT" ? this.#vimState : { mode: "INSERT" as const, insertedText: "" };
    if (key.return) {
      this.newline();
      this.#vimState = { mode: "INSERT", insertedText: `${state.insertedText}\n` };
      return;
    }
    if (key.tab) {
      this.insert("\t");
      this.#vimState = { mode: "INSERT", insertedText: `${state.insertedText}\t` };
      return;
    }
    if (key.backspace) {
      this.backspace();
      this.#vimState = {
        mode: "INSERT",
        insertedText: removeLastGrapheme(state.insertedText),
      };
      return;
    }
    if (key.delete) {
      this.deleteForward();
      this.#vimState = {
        mode: "INSERT",
        insertedText: state.insertedText,
      };
      return;
    }
    if (input.length > 0) {
      this.insert(input);
      this.#vimState = { mode: "INSERT", insertedText: state.insertedText + input };
      return;
    }
    this.#emit();
  }

  #handleVimVisualInput(input: string, key: Key, columns: number): boolean {
    if (key.escape || input === "v") {
      this.#exitVisualMode();
      return true;
    }

    if (input === "y" || input === "Y") {
      this.#yankVisualSelection();
      return true;
    }
    if (input === "d" || input === "x") {
      this.#deleteVisualSelection(false);
      return true;
    }
    if (input === "c") {
      this.#deleteVisualSelection(true);
      return true;
    }
    if (input === "p" || input === "P") {
      this.#pasteOverVisualSelection();
      return true;
    }

    const vimInput = normalizeVimNormalInput(input, key);
    if (vimInput === null) {
      return key.return || key.tab || input.length > 0;
    }
    if (!SIMPLE_MOTIONS.has(vimInput) && vimInput !== "G") {
      return input.length > 0;
    }

    const document = this.#document;
    if (!document) return true;
    const text = bufferText(document);
    const cursor = TextCursor.fromText(text, columns, currentSelection(document).head);
    const target = vimInput === "G"
      ? cursor.startOfLastLine()
      : resolveMotion(vimInput, cursor, 1);
    this.#setVisualHead(target.offset);
    return true;
  }

  #enterVisualMode(): void {
    const offset = this.#position().offset;
    this.#visualAnchor = offset;
    this.#replaceDocument((document) => setBufferSelection(document, { anchor: offset, head: offset }), false);
  }

  #exitVisualMode(): void {
    const head = this.#position().offset;
    this.#visualAnchor = null;
    this.#vimState = { mode: "NORMAL", command: { type: "idle" } };
    this.#replaceDocument((document) => setBufferCursorOffset(document, head), false);
  }

  #setVisualHead(offset: number): void {
    const anchor = this.#visualAnchor;
    if (anchor === null) return;
    this.#replaceDocument((document) => setBufferSelection(document, { anchor, head: offset }), false);
  }

  #visualSelectionRange(): { readonly from: number; readonly to: number; readonly text: string } | null {
    const document = this.#document;
    if (!document) return null;
    const text = bufferText(document);
    const { from, to } = selectionBounds(currentSelection(document));
    const safeTo = from === to ? nextGraphemeOffset(text, to) : to;
    return { from, to: safeTo, text: text.slice(from, safeTo) };
  }

  #yankVisualSelection(): void {
    const range = this.#visualSelectionRange();
    if (!range) return;
    this.#vimPersistentState = {
      ...this.#vimPersistentState,
      register: range.text,
      registerIsLinewise: false,
    };
    this.#visualAnchor = null;
    this.#vimState = { mode: "NORMAL", command: { type: "idle" } };
    this.#replaceDocument((document) => setBufferCursorOffset(document, range.from), false);
  }

  #deleteVisualSelection(enterInsert: boolean): void {
    const range = this.#visualSelectionRange();
    if (!range) return;
    this.#vimPersistentState = {
      ...this.#vimPersistentState,
      register: range.text,
      registerIsLinewise: false,
    };
    this.#visualAnchor = null;
    this.#vimState = enterInsert
      ? { mode: "INSERT", insertedText: "" }
      : { mode: "NORMAL", command: { type: "idle" } };
    this.#replaceDocument((document) => replaceBufferRange(document, range.from, range.to, "", range.from), true);
  }

  #pasteOverVisualSelection(): void {
    const range = this.#visualSelectionRange();
    const register = this.#vimPersistentState.register;
    if (!range || !register) return;
    this.#vimPersistentState = {
      ...this.#vimPersistentState,
      register: range.text,
      registerIsLinewise: false,
    };
    this.#visualAnchor = null;
    this.#vimState = { mode: "NORMAL", command: { type: "idle" } };
    this.#replaceDocument(
      (document) => replaceBufferRange(document, range.from, range.to, register, range.from + register.length),
      true,
    );
  }

  #createVimEditSession(columns: number): VimEditSession {
    const startDocument = this.#document;
    const startText = startDocument ? bufferText(startDocument) : "";
    let nextText = startText;
    let nextOffset = this.#position().offset;
    let textChanged = false;
    let offsetChanged = false;
    let enteredInsert = false;
    const clampOffset = (offset: number): number => Math.max(0, Math.min(nextText.length, offset));
    const applyText = (text: string): void => {
      nextText = text;
      textChanged = true;
      nextOffset = clampOffset(nextOffset);
    };
    const applyOffset = (offset: number): void => {
      nextOffset = clampOffset(offset);
      offsetChanged = true;
    };
    const context: TransitionContext = {
      get cursor() {
        return TextCursor.fromText(nextText, columns, nextOffset);
      },
      get text() {
        return nextText;
      },
      setText: applyText,
      setOffset: applyOffset,
      enterInsert: (offset: number) => {
        applyOffset(offset);
        enteredInsert = true;
      },
      getRegister: () => this.#vimPersistentState.register,
      setRegister: (content: string, linewise: boolean) => {
        this.#vimPersistentState = {
          ...this.#vimPersistentState,
          register: content,
          registerIsLinewise: linewise,
        };
      },
      getLastFind: () => this.#vimPersistentState.lastFind,
      setLastFind: (type, char) => {
        this.#vimPersistentState = {
          ...this.#vimPersistentState,
          lastFind: { type, char },
        };
      },
      recordChange: (change: RecordedChange) => {
        this.#vimPersistentState = {
          ...this.#vimPersistentState,
          lastChange: change,
        };
      },
      onUndo: () => this.undo(),
      onDotRepeat: () => this.#replayLastVimChange(columns),
    };
    return {
      context,
      flush: () => {
        if (enteredInsert) {
          this.#vimState = { mode: "INSERT", insertedText: "" };
        }
        let emitted = false;
        if (textChanged) {
          emitted = this.#replaceDocument((document) => replaceBufferText(document, nextText, nextOffset), true);
        } else if (offsetChanged) {
          emitted = this.#replaceDocument((document) => setBufferCursorOffset(document, nextOffset), false);
        }
        if (enteredInsert && !emitted) {
          this.#emit();
        }
      },
    };
  }

  #replayLastVimChange(columns: number): void {
    const change = this.#vimPersistentState.lastChange;
    if (!change) return;
    const session = this.#createVimEditSession(columns);
    const ctx = session.context;

    switch (change.type) {
      case "insert":
        if (change.text) {
          const cursor = TextCursor.fromText(ctx.text, columns, this.#position().offset);
          const next = cursor.insert(change.text);
          ctx.setText(next.text);
          ctx.setOffset(next.offset);
        }
        break;
      case "x":
        executeX(change.count, ctx);
        break;
      case "replace":
        executeReplace(change.char, change.count, ctx);
        break;
      case "toggleCase":
        executeToggleCase(change.count, ctx);
        break;
      case "indent":
        executeIndent(change.dir, change.count, ctx);
        break;
      case "join":
        executeJoin(change.count, ctx);
        break;
      case "openLine":
        executeOpenLine(change.direction, ctx);
        break;
      case "operator":
        executeOperatorMotion(change.op, change.motion, change.count, ctx);
        break;
      case "operatorFind":
        executeOperatorFind(change.op, change.find, change.char, change.count, ctx);
        break;
      case "operatorTextObj":
        executeOperatorTextObj(change.op, change.scope, change.objType, change.count, ctx);
        break;
    }

    session.flush();
  }

  #switchToNormalMode(): void {
    if (this.#vimState.mode === "INSERT" && this.#vimState.insertedText) {
      this.#vimPersistentState = {
        ...this.#vimPersistentState,
        lastChange: {
          type: "insert",
          text: this.#vimState.insertedText,
        },
      };
    }
    const document = this.#document;
    if (document) {
      const offset = currentSelection(document).head;
      const text = bufferText(document);
      if (offset > 0 && text[offset - 1] !== "\n") {
        this.#replaceDocument((current) => setBufferCursorOffset(current, previousGraphemeOffset(text, offset)), false);
      }
    }
    this.#vimState = { mode: "NORMAL", command: { type: "idle" } };
    this.#emit();
  }

  #resetVimState(): void {
    this.#vimCommandLine = null;
    this.#vimState = { mode: "NORMAL", command: { type: "idle" } };
    this.#visualAnchor = null;
    this.#vimPersistentState = createInitialPersistentState();
  }

  #edit(update: (document: BufferDocument) => BufferDocument): void {
    this.#replaceDocument(update, true);
  }

  #replaceDocument(update: (document: BufferDocument) => BufferDocument, notifyLsp: boolean): boolean {
    const current = this.#document;
    if (!current) return false;
    const previousText = bufferText(current);
    const next = update(current);
    if (next === current) return false;
    this.#document = next;
    this.#status = "ready";
    this.#error = null;
    this.#conflictKind = null;
    this.#hoverText = null;
    this.#ensureCursorVisible();
    const nextText = bufferText(next);
    if (notifyLsp && nextText !== previousText && this.#file) {
      const file = this.#file;
      if (file) safeNotifyBufferLsp(() => notifyBufferLspChanged(file.absolutePath, nextText));
    }
    this.#emit();
    return true;
  }

  async #load(
    filePath: string,
    line: number,
    allowDirtyReplace: boolean,
    displayPath = filePath,
    options: BufferLoadOptions = {},
  ): Promise<boolean> {
    let absolutePath: string;
    const basePath = options.basePath ?? getCwd();
    try {
      absolutePath = resolveBufferFilePath(filePath, basePath);
    } catch (error) {
      this.#status = "error";
      this.#error = errorMessage(error);
      this.#conflictKind = null;
      this.#emit();
      return false;
    }
    if (this.#file?.absolutePath === absolutePath && !allowDirtyReplace) {
      if (this.#document) {
        this.#document = moveBufferCursorToLine(this.#document, line);
        this.#status = "ready";
        this.#error = null;
        this.#conflictKind = null;
        this.#hoverText = null;
        this.#ensureCursorVisible();
        this.#emit();
        return true;
      }
      return false;
    }
    if (this.#isDirty() && !allowDirtyReplace) {
      this.#setProblem("conflict", "Unsaved edits. Save, revert, or close-discard before opening another file.", "disk");
      return false;
    }

    const generation = ++this.#openGeneration;
    const previousPath = this.#file?.absolutePath;
    const previousFile = this.#file;
    const previousDocument = this.#document;
    const previousWorkspaceBasePath = this.#workspaceBasePath;
    const previousScrollLine = this.#scrollLine;
    const previousVimCommandLine = this.#vimCommandLine;
    const previousVimState = this.#vimState;
    const previousVisualAnchor = this.#visualAnchor;
    const previousVimPersistentState = this.#vimPersistentState;
    this.#status = "loading";
    this.#error = null;
    this.#conflictKind = null;
    this.#hoverText = null;
    this.#file = null;
    this.#document = null;
    this.#workspaceBasePath = null;
    this.#scrollLine = 0;
    this.#resetVimState();
    this.#emit();

    try {
      const snapshot = await readBufferFileSnapshot(absolutePath, {
        basePath,
        displayPath,
      });
      if (generation !== this.#openGeneration) return false;
      if (previousPath && previousPath !== snapshot.absolutePath) {
        safeNotifyBufferLsp(() => notifyBufferLspClosed(previousPath));
      }
      this.#file = snapshot;
      this.#document = createBufferDocument(snapshot.content, line);
      this.#workspaceBasePath = basePath;
      this.#resetVimState();
      this.#status = "ready";
      this.#error = null;
      this.#conflictKind = null;
      this.#hoverText = null;
      this.#ensureCursorVisible();
      safeNotifyBufferLsp(() => notifyBufferLspOpened(snapshot.absolutePath, snapshot.content));
      this.#emit();
      return true;
    } catch (error) {
      if (generation !== this.#openGeneration) return false;
      if (options.preserveCurrentOnError && previousFile && previousDocument) {
        this.#file = previousFile;
        this.#document = previousDocument;
        this.#workspaceBasePath = previousWorkspaceBasePath;
        this.#scrollLine = previousScrollLine;
        this.#vimCommandLine = previousVimCommandLine;
        this.#vimState = previousVimState;
        this.#visualAnchor = previousVisualAnchor;
        this.#vimPersistentState = previousVimPersistentState;
      }
      this.#status = "error";
      this.#error = errorMessage(error);
      this.#conflictKind = null;
      this.#emit();
      return false;
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
      vimMode: this.#visualAnchor !== null ? "VISUAL" : this.#vimState.mode,
      vimCommandLine: this.#vimCommandLine,
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
  return isRelativePathOutsideBase(relativePath) || relativePath === "" || resolve(cwd, relativePath) !== absolutePath
    ? absolutePath
    : relativePath;
}

function errorMessage(error: any): string {
  return error instanceof Error ? error.message : String(error);
}

function safeNotifyBufferLsp(notify: () => void): void {
  try {
    notify();
  } catch (error) {
    logError(error);
  }
}

function normalizeVimNormalInput(input: string, key: Key): string | null {
  if (key.leftArrow) return "h";
  if (key.rightArrow) return "l";
  if (key.upArrow) return "k";
  if (key.downArrow) return "j";
  if (key.backspace) return "h";
  if (key.delete) return "x";
  if (input.length === 1) return input;
  return null;
}

function parseVimCommand(rawCommand: string): BufferVimCommand | null {
  const command = rawCommand.trim().toLowerCase();
  switch (command) {
    case "w":
    case "write":
      return { type: "save", force: false };
    case "w!":
    case "write!":
      return { type: "save", force: true };
    case "q":
    case "quit":
      return { type: "quit", discard: false, all: false };
    case "q!":
    case "quit!":
      return { type: "quit", discard: true, all: false };
    case "qa":
    case "qall":
    case "quitall":
      return { type: "quit", discard: false, all: true };
    case "qa!":
    case "qall!":
    case "quitall!":
      return { type: "quit", discard: true, all: true };
    case "wq":
    case "x":
    case "xit":
    case "exit":
      return { type: "saveQuit", force: false, all: false };
    case "wq!":
    case "x!":
    case "xit!":
    case "exit!":
      return { type: "saveQuit", force: true, all: false };
    case "wqa":
    case "wqall":
    case "xa":
    case "xall":
      return { type: "saveQuit", force: false, all: true };
    case "wqa!":
    case "wqall!":
    case "xa!":
    case "xall!":
      return { type: "saveQuit", force: true, all: true };
    default:
      return null;
  }
}

function isNavigationKey(key: Key): boolean {
  return key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown || key.home || key.end;
}

function isShiftSelectionNavigationKey(key: Key): boolean {
  return key.shift && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.home || key.end);
}

function removeLastGrapheme(value: string): string {
  if (value.length === 0) return value;
  const last = lastGrapheme(value);
  return value.slice(0, Math.max(0, value.length - (last.length || 1)));
}

let singleton: WorkbenchBufferStore | null = null;

export function getWorkbenchBufferStore(): WorkbenchBufferStore {
  singleton ??= new WorkbenchBufferStore();
  return singleton;
}

export function resetWorkbenchBufferStoreForTesting(): void {
  singleton = new WorkbenchBufferStore();
}
