import type { Key } from "../../../ink.js";

export type NeovimInputEvent =
  | { readonly type: "keys"; readonly keys: string }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "resize"; readonly rows: number; readonly columns: number };

export function translateKeyToNeovimInput(input: string, key: Key): string | null {
  const named = namedKey(key);
  if (named) return wrapModifiedKey(named, key);
  if (input.length === 0) return null;
  if (key.ctrl) return controlInput(input);
  if (key.meta && !key.escape) return `<A-${escapeKeyText(input)}>`;
  if (key.super) return `<D-${escapeKeyText(input)}>`;
  return input;
}

export function translatePasteToNeovimInput(text: string): readonly NeovimInputEvent[] {
  if (text.length === 0) return [];
  return [
    { type: "keys", keys: "<PasteStart>" },
    { type: "paste", text },
    { type: "keys", keys: "<PasteEnd>" },
  ];
}

export function translateResizeToNeovimInput(rows: number, columns: number): NeovimInputEvent {
  return {
    type: "resize",
    rows: Math.max(1, Math.floor(rows)),
    columns: Math.max(1, Math.floor(columns)),
  };
}

function namedKey(key: Key): string | null {
  if (key.escape) return "Esc";
  if (key.return) return "CR";
  if (key.tab) return "Tab";
  if (key.backspace) return "BS";
  if (key.delete) return "Del";
  if (key.upArrow) return "Up";
  if (key.downArrow) return "Down";
  if (key.leftArrow) return "Left";
  if (key.rightArrow) return "Right";
  if (key.pageUp) return "PageUp";
  if (key.pageDown) return "PageDown";
  if (key.home) return "Home";
  if (key.end) return "End";
  if (key.wheelUp) return "ScrollWheelUp";
  if (key.wheelDown) return "ScrollWheelDown";
  return null;
}

function wrapModifiedKey(name: string, key: Key): string {
  const modifiers: string[] = [];
  if (key.ctrl) modifiers.push("C");
  if (key.shift && !name.startsWith("ScrollWheel")) modifiers.push("S");
  if (key.meta && !key.escape) modifiers.push("A");
  if (key.super) modifiers.push("D");
  return modifiers.length > 0 ? `<${modifiers.join("-")}-${name}>` : `<${name}>`;
}

function controlInput(input: string): string {
  const text = escapeKeyText(input);
  return `<C-${text}>`;
}

function escapeKeyText(input: string): string {
  if (input === "<") return "lt";
  if (input === " ") return "Space";
  return input.length === 1 ? input : input.replace(/[<>]/gu, "");
}
