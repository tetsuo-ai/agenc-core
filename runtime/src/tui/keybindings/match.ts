import type { Key } from "../ink-public.js";
import type { ParsedBinding, ParsedKeystroke } from "./types.js";

type InkModifiers = Pick<Key, "ctrl" | "shift" | "meta" | "super">;

function getInkModifiers(key: Key): InkModifiers {
  return {
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.meta,
    super: key.super,
  };
}

export function getKeyName(input: string, key: Partial<Key>): string | null {
  if (key.escape) return "escape";
  if (key.return) return "enter";
  if (key.tab) return "tab";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  if (key.wheelUp) return "wheelup";
  if (key.wheelDown) return "wheeldown";
  if (key.home) return "home";
  if (key.end) return "end";
  if (input.length === 1) return input.toLowerCase();
  return null;
}

function modifiersMatch(
  inkMods: Partial<InkModifiers>,
  target: ParsedKeystroke,
): boolean {
  if (Boolean(inkMods.ctrl) !== target.ctrl) return false;
  if (Boolean(inkMods.shift) !== target.shift) return false;

  const targetNeedsMeta = target.alt || target.meta;
  if (Boolean(inkMods.meta) !== targetNeedsMeta) return false;

  if (Boolean(inkMods.super) !== target.super) return false;

  return true;
}

export function matchesKeystroke(
  input: string,
  key: Partial<Key>,
  target: ParsedKeystroke,
): boolean {
  const keyName = getKeyName(input, key);
  if (keyName !== target.key) return false;

  const inkMods = getInkModifiers(key as Key);
  if (key.escape) {
    return modifiersMatch({ ...inkMods, meta: false }, target);
  }

  return modifiersMatch(inkMods, target);
}

export function matchesBinding(
  input: string,
  key: Partial<Key>,
  binding: ParsedBinding,
): boolean {
  if (binding.chord.length !== 1) return false;
  const keystroke = binding.chord[0];
  if (!keystroke) return false;
  return matchesKeystroke(input, key, keystroke);
}
