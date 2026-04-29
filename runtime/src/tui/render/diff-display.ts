import {
  buildDiffDisplayLines,
  type DiffDisplayLine,
} from "../_deps/diff-render.js";

export function looksLikeDiffText(value: string | undefined): boolean {
  const text = String(value ?? "");
  return (
    text.includes("@@") &&
    (text.startsWith("diff --git ") ||
      text.startsWith("--- ") ||
      (text.includes("\n--- ") && text.includes("\n+++ ")))
  );
}

export function renderDiffDisplayLines(value: string): DiffDisplayLine[] {
  const source = String(value ?? "");
  return buildDiffDisplayLines({ kind: "tool", body: source });
}
