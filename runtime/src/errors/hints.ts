import { logForDebugging } from "../utils/debug.js";
import { createSignal } from "../utils/signal.js";

export type AgenCCodeHintType = "plugin";

export type AgenCCodeHint = {
  readonly v: number;
  readonly type: AgenCCodeHintType;
  readonly value: string;
  readonly sourceCommand: string;
};

const SUPPORTED_VERSIONS = new Set([1]);
const SUPPORTED_TYPES = new Set<string>(["plugin"]);
const HINT_TAG_RE = /^[ \t]*<agenc-code-hint\s+([^>]*?)\s*\/>[ \t]*$/gm;
const ATTR_RE = /(\w+)=(?:"([^"]*)"|([^\s/>]+))/g;

export function extractAgenCCodeHints(
  output: string,
  command: string,
): { readonly hints: AgenCCodeHint[]; readonly stripped: string } {
  if (!output.includes("<agenc-code-hint")) {
    return { hints: [], stripped: output };
  }

  const sourceCommand = firstCommandToken(command);
  const hints: AgenCCodeHint[] = [];

  const stripped = output.replace(HINT_TAG_RE, (rawLine) => {
    const attrs = parseAttrs(rawLine);
    const v = Number(attrs.v);
    const type = attrs.type;
    const value = attrs.value;

    if (!SUPPORTED_VERSIONS.has(v)) {
      logForDebugging(
        `[agencCodeHints] dropped hint with unsupported v=${attrs.v}`,
      );
      return "";
    }
    if (!type || !SUPPORTED_TYPES.has(type)) {
      logForDebugging(
        `[agencCodeHints] dropped hint with unsupported type=${type}`,
      );
      return "";
    }
    if (!value) {
      logForDebugging("[agencCodeHints] dropped hint with empty value");
      return "";
    }

    hints.push({ v, type: type as AgenCCodeHintType, value, sourceCommand });
    return "";
  });

  const collapsed =
    hints.length > 0 || stripped !== output
      ? stripped.replace(/\n{3,}/g, "\n\n")
      : stripped;

  return { hints, stripped: collapsed };
}

function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tagBody.matchAll(ATTR_RE)) {
    attrs[match[1]!] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

function firstCommandToken(command: string): string {
  const trimmed = command.trim();
  const spaceIdx = trimmed.search(/\s/);
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

let pendingHint: AgenCCodeHint | null = null;
let shownThisSession = false;
const pendingHintChanged = createSignal();

export function setPendingHint(hint: AgenCCodeHint): void {
  if (shownThisSession) return;
  pendingHint = hint;
  pendingHintChanged.emit();
}

export function clearPendingHint(): void {
  if (pendingHint !== null) {
    pendingHint = null;
    pendingHintChanged.emit();
  }
}

export function markShownThisSession(): void {
  shownThisSession = true;
}

export const subscribeToPendingHint = pendingHintChanged.subscribe;

export function getPendingHintSnapshot(): AgenCCodeHint | null {
  return pendingHint;
}

export function hasShownHintThisSession(): boolean {
  return shownThisSession;
}

export function _resetAgenCCodeHintStore(): void {
  pendingHint = null;
  shownThisSession = false;
  pendingHintChanged.clear();
}

export const _test = {
  parseAttrs,
  firstCommandToken,
};
