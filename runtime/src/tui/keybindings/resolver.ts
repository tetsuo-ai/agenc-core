import type { Key } from "../ink-public.js";
import { getKeyName, matchesBinding } from "./match.js";
import { chordToString } from "./parser.js";
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from "./types.js";

export type ResolveResult =
  | { type: "match"; action: string }
  | { type: "none" }
  | { type: "unbound" };

export type ChordResolveResult =
  | { type: "match"; action: string }
  | { type: "none" }
  | { type: "unbound" }
  | { type: "chord_started"; pending: ParsedKeystroke[] }
  | { type: "chord_cancelled" };

export function resolveKey(
  input: string,
  key: Partial<Key>,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
): ResolveResult {
  let match: ParsedBinding | undefined;
  const ctxSet = new Set(activeContexts);

  for (const binding of bindings) {
    if (binding.chord.length !== 1) continue;
    if (!ctxSet.has(binding.context)) continue;

    if (matchesBinding(input, key, binding)) {
      match = binding;
    }
  }

  if (!match) return { type: "none" };
  if (match.action === null) return { type: "unbound" };
  return { type: "match", action: match.action };
}

export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
): string | undefined {
  const binding = bindings.findLast(
    (b) => b.action === action && b.context === context,
  );
  return binding ? chordToString(binding.chord) : undefined;
}

function buildKeystroke(
  input: string,
  key: Partial<Key>,
): ParsedKeystroke | null {
  const keyName = getKeyName(input, key);
  if (!keyName) return null;

  const effectiveMeta = key.escape ? false : Boolean(key.meta);

  return {
    key: keyName,
    ctrl: Boolean(key.ctrl),
    alt: effectiveMeta,
    shift: Boolean(key.shift),
    meta: effectiveMeta,
    super: Boolean(key.super),
  };
}

export function keystrokesEqual(
  a: ParsedKeystroke,
  b: ParsedKeystroke,
): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    (a.alt || a.meta) === (b.alt || b.meta) &&
    a.super === b.super
  );
}

function chordPrefixMatches(
  prefix: ParsedKeystroke[],
  binding: ParsedBinding,
): boolean {
  if (prefix.length >= binding.chord.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    const prefixKey = prefix[i];
    const bindingKey = binding.chord[i];
    if (!prefixKey || !bindingKey) return false;
    if (!keystrokesEqual(prefixKey, bindingKey)) return false;
  }
  return true;
}

function chordExactlyMatches(
  chord: ParsedKeystroke[],
  binding: ParsedBinding,
): boolean {
  if (chord.length !== binding.chord.length) return false;
  for (let i = 0; i < chord.length; i += 1) {
    const chordKey = chord[i];
    const bindingKey = binding.chord[i];
    if (!chordKey || !bindingKey) return false;
    if (!keystrokesEqual(chordKey, bindingKey)) return false;
  }
  return true;
}

export function resolveKeyWithChordState(
  input: string,
  key: Partial<Key>,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,
): ChordResolveResult {
  if (key.escape && pending !== null) {
    return { type: "chord_cancelled" };
  }

  const currentKeystroke = buildKeystroke(input, key);
  if (!currentKeystroke) {
    if (pending !== null) return { type: "chord_cancelled" };
    return { type: "none" };
  }

  const testChord = pending
    ? [...pending, currentKeystroke]
    : [currentKeystroke];

  const ctxSet = new Set(activeContexts);
  const contextBindings = bindings.filter((b) => ctxSet.has(b.context));

  const chordWinners = new Map<string, string | null>();
  for (const binding of contextBindings) {
    if (
      binding.chord.length > testChord.length &&
      chordPrefixMatches(testChord, binding)
    ) {
      chordWinners.set(chordToString(binding.chord), binding.action);
    }
  }

  let hasLongerChords = false;
  for (const action of chordWinners.values()) {
    if (action !== null) {
      hasLongerChords = true;
      break;
    }
  }

  if (hasLongerChords) {
    return { type: "chord_started", pending: testChord };
  }

  let exactMatch: ParsedBinding | undefined;
  for (const binding of contextBindings) {
    if (chordExactlyMatches(testChord, binding)) {
      exactMatch = binding;
    }
  }

  if (exactMatch) {
    if (exactMatch.action === null) return { type: "unbound" };
    return { type: "match", action: exactMatch.action };
  }

  if (pending !== null) return { type: "chord_cancelled" };

  return { type: "none" };
}
