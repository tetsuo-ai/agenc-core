import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_BINDINGS,
  KNOWN_BINDING_COMMANDS,
  KNOWN_BINDING_CONTEXTS,
  normalizeKeySequence,
  type BindingCommand,
  type BindingContext,
  type BindingMap,
} from "./defaultBindings.js";
import { parseChord } from "./parser.js";
import {
  getReservedShortcuts,
  normalizeKeyForComparison,
} from "./reservedShortcuts.js";
import type { Chord } from "./types.js";
import { validateKeybindings } from "./validate.js";

export type KeybindingWarningType =
  | "parse_error"
  | "invalid_context"
  | "invalid_action"
  | "duplicate"
  | "reserved";

export interface KeybindingWarning {
  readonly type: KeybindingWarningType;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly key?: string;
  readonly context?: string;
  readonly action?: string;
}

export interface KeybindingsLoadResult {
  readonly bindings: Record<BindingContext, BindingMap>;
  readonly warnings: readonly KeybindingWarning[];
}

type RawKeybindingBlock = {
  readonly context?: unknown;
  readonly bindings?: unknown;
};

const CONTEXT_ALIASES: Record<string, BindingContext> = {
  global: "global",
  chat: "chat",
  modal: "modal",
  confirmation: "modal",
  select: "modal",
  modelpicker: "modal",
  themepicker: "modal",
  settings: "modal",
  help: "modal",
  transcript: "transcript",
  historysearch: "modal",
};

const LEGACY_ACTION_ALIASES: Record<string, BindingCommand> = {
  interrupt: "app:interrupt",
  exit: "app:exit",
  clearscreen: "app:redraw",
  redraw: "app:redraw",
  cyclemode: "chat:cycleMode",
  submit: "chat:submit",
  newline: "chat:newline",
  cancel: "chat:cancel",
  externaleditor: "chat:externalEditor",
  imagepaste: "chat:imagePaste",
};

const RESERVED_PROCESS_KEYS = new Set(["ctrl+c", "ctrl+d"]);
const RESERVED_GLOBAL_KEYS = new Set(
  getReservedShortcuts()
    .map((shortcut) => normalizeKeyForComparison(shortcut.key))
    .filter((key) => RESERVED_PROCESS_KEYS.has(key)),
);

function cloneDefaultBindings(): Record<BindingContext, BindingMap> {
  return {
    global: { ...DEFAULT_BINDINGS.global },
    chat: { ...DEFAULT_BINDINGS.chat },
    modal: { ...DEFAULT_BINDINGS.modal },
    transcript: { ...DEFAULT_BINDINGS.transcript },
    Scroll: { ...DEFAULT_BINDINGS.Scroll },
  };
}

export function keybindingsPathFromHome(agencHome = resolveAgencHome()): string {
  return join(agencHome, "keybindings.json");
}

function resolveAgencHome(): string {
  if (process.env.AGENC_HOME && process.env.AGENC_HOME.trim().length > 0) {
    return process.env.AGENC_HOME;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home && home.length > 0 ? join(home, ".agenc") : join(process.cwd(), ".agenc");
}

function normalizeContext(value: unknown): BindingContext | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/[^a-z]/gi, "").toLowerCase();
  return CONTEXT_ALIASES[compact] ?? null;
}

function normalizeAction(value: unknown): BindingCommand | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (KNOWN_BINDING_COMMANDS.has(trimmed as BindingCommand)) {
    return trimmed as BindingCommand;
  }
  const compact = trimmed.replace(/[^a-z]/gi, "").toLowerCase();
  return LEGACY_ACTION_ALIASES[compact] ?? null;
}

function parsedChordToLiveKeySequence(chord: Chord): string {
  return chord
    .map((keystroke) => {
      const parts: string[] = [];
      if (keystroke.alt || keystroke.meta) parts.push("alt");
      if (keystroke.ctrl) parts.push("ctrl");
      if (keystroke.super) parts.push("meta");
      if (keystroke.shift) parts.push("shift");
      parts.push(keystroke.key === " " ? "space" : keystroke.key);
      return parts.join("+");
    })
    .join(" ");
}

function normalizeUserKey(rawKey: string): string {
  try {
    return normalizeKeySequence(parsedChordToLiveKeySequence(parseChord(rawKey)));
  } catch {
    return normalizeKeySequence(rawKey);
  }
}

function pushWarning(
  warnings: KeybindingWarning[],
  warning: KeybindingWarning,
): void {
  warnings.push(warning);
}

function applyBinding(
  bindings: Record<BindingContext, BindingMap>,
  warnings: KeybindingWarning[],
  context: BindingContext,
  rawKey: string,
  rawAction: unknown,
): void {
  const key = normalizeUserKey(rawKey);
  if (key.length === 0) {
    pushWarning(warnings, {
      type: "parse_error",
      severity: "error",
      message: `Empty keybinding key in ${context}.`,
      key: rawKey,
      context,
    });
    return;
  }

  if (
    context === "global" &&
    RESERVED_GLOBAL_KEYS.has(normalizeKeyForComparison(key))
  ) {
    pushWarning(warnings, {
      type: "reserved",
      severity: "warning",
      message: `${rawKey} is reserved by AgenC and cannot be rebound.`,
      key: rawKey,
      context,
    });
    return;
  }

  if (rawAction === null) {
    delete bindings[context][key];
    return;
  }

  const action = normalizeAction(rawAction);
  if (action === null) {
    pushWarning(warnings, {
      type: "invalid_action",
      severity: "error",
      message: `Unknown keybinding action "${String(rawAction)}".`,
      key: rawKey,
      context,
      action: String(rawAction),
    });
    return;
  }

  bindings[context][key] = action;
}

function normalizeBlocks(parsed: unknown): RawKeybindingBlock[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  if (Array.isArray(root.bindings)) {
    return root.bindings as RawKeybindingBlock[];
  }

  if (Array.isArray(root.shortcuts)) {
    const chatBindings: Record<string, string> = {};
    const globalBindings: Record<string, string> = {};
    for (const entry of root.shortcuts) {
      if (typeof entry !== "object" || entry === null) continue;
      const shortcut = entry as Record<string, unknown>;
      if (typeof shortcut.keys !== "string" || typeof shortcut.action !== "string") {
        continue;
      }
      const action = normalizeAction(shortcut.action);
      if (!action) continue;
      const target = action.startsWith("chat:") ? chatBindings : globalBindings;
      target[shortcut.keys] = action;
    }
    return [
      { context: "Global", bindings: globalBindings },
      { context: "Chat", bindings: chatBindings },
    ];
  }

  return null;
}

function validationContextFor(context: BindingContext): string {
  switch (context) {
    case "global":
      return "Global";
    case "chat":
      return "Chat";
    case "modal":
      return "Modal";
    case "transcript":
      return "Transcript";
    case "Scroll":
      return "Scroll";
  }
}

function normalizeBlocksForValidation(
  blocks: readonly RawKeybindingBlock[],
): unknown[] {
  return blocks.map((block) => {
    const context = normalizeContext(block.context);
    const bindings: Record<string, unknown> = {};

    if (typeof block.bindings === "object" && block.bindings !== null) {
      for (const [key, action] of Object.entries(
        block.bindings as Record<string, unknown>,
      )) {
        bindings[key] =
          action === null
            ? null
            : typeof action === "string"
              ? normalizeAction(action) ?? action
              : action;
      }
    }

    return {
      context:
        context !== null ? validationContextFor(context) : block.context,
      bindings,
    };
  });
}

function addOpenClaudeValidationWarnings(
  warnings: KeybindingWarning[],
  blocks: readonly RawKeybindingBlock[],
): void {
  for (const warning of validateKeybindings(
    normalizeBlocksForValidation(blocks),
  )) {
    if (warning.type !== "duplicate") continue;
    pushWarning(warnings, {
      type: "duplicate",
      severity: warning.severity,
      message: warning.message,
      ...(warning.key !== undefined ? { key: warning.key } : {}),
      ...(warning.context !== undefined ? { context: warning.context } : {}),
      ...(warning.action !== undefined ? { action: warning.action } : {}),
    });
  }
}

export function loadUserBindingsSync(
  agencHome?: string,
): KeybindingsLoadResult {
  const bindings = cloneDefaultBindings();
  const warnings: KeybindingWarning[] = [];
  const file = keybindingsPathFromHome(agencHome);

  if (!existsSync(file)) {
    return { bindings, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      bindings,
      warnings: [
        {
          type: "parse_error",
          severity: "error",
          message: `Failed to parse keybindings.json: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }

  const blocks = normalizeBlocks(parsed);
  if (blocks === null) {
    return {
      bindings,
      warnings: [
        {
          type: "parse_error",
          severity: "error",
          message: 'keybindings.json must contain a "bindings" array.',
        },
      ],
    };
  }

  addOpenClaudeValidationWarnings(warnings, blocks);

  for (const block of blocks) {
    const context = normalizeContext(block.context);
    if (context === null) {
      pushWarning(warnings, {
        type: "invalid_context",
        severity: "error",
        message: `Unknown keybinding context "${String(block.context)}".`,
        context: String(block.context),
      });
      continue;
    }

    if (typeof block.bindings !== "object" || block.bindings === null) {
      pushWarning(warnings, {
        type: "parse_error",
        severity: "error",
        message: `Keybinding block "${String(block.context)}" is missing a bindings object.`,
        context,
      });
      continue;
    }

    for (const [key, action] of Object.entries(
      block.bindings as Record<string, unknown>,
    )) {
      applyBinding(bindings, warnings, context, key, action);
    }
  }

  return { bindings, warnings };
}

export function watchUserBindings(
  onChange: (result: KeybindingsLoadResult) => void,
  agencHome?: string,
): () => void {
  const file = keybindingsPathFromHome(agencHome);
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });

  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;

  const reload = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange(loadUserBindingsSync(agencHome));
    }, 75);
  };

  try {
    watcher = watch(directory, (_event, filename) => {
      if (filename === null || filename === "keybindings.json") {
        reload();
      }
    });
  } catch {
    return () => undefined;
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

export const KNOWN_USER_BINDING_CONTEXTS: readonly BindingContext[] =
  KNOWN_BINDING_CONTEXTS;
