import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import type { ToolJSXState } from "./use-tool-jsx.js";

const APP_SOURCE_PATH = path.resolve(import.meta.dirname, "App.tsx");

function readSource(): string {
  return fs.readFileSync(APP_SOURCE_PATH, "utf8");
}

/**
 * Mirrors the upstream animation gate from
 * `runtime/src/tui/components/Messages.tsx`:
 *
 *   const canAnimate =
 *     (!toolJSX || !!toolJSX.shouldContinueAnimation)
 *     && !toolUseConfirmQueue.length
 *     && !isMessageSelectorVisible;
 *
 * Re-derived here so the row can directly test that the upstream
 * gate semantics are preserved when the host passes `toolJSX`,
 * `toolUseConfirmQueue`, and `isMessageSelectorVisible` from R2.
 */
function canAnimate(
  toolJSX: ToolJSXState | null,
  toolUseConfirmQueue: readonly unknown[],
  isMessageSelectorVisible: boolean,
): boolean {
  return (
    (!toolJSX || !!toolJSX.shouldContinueAnimation) &&
    !toolUseConfirmQueue.length &&
    !isMessageSelectorVisible
  );
}

describe("R3 toolJSX gating reaches the Messages animation gate", () => {
  test("E3.1 toolJSX=null AND empty toolUseConfirmQueue AND !isMessageSelectorVisible -> canAnimate=true", () => {
    expect(canAnimate(null, [], false)).toBe(true);
  });

  test("E3.2 toolJSX={shouldContinueAnimation:true} AND empty queue -> canAnimate=true (set-but-continuing path)", () => {
    const tj: ToolJSXState = {
      jsx: "X",
      shouldHidePromptInput: false,
      shouldContinueAnimation: true,
    };
    expect(canAnimate(tj, [], false)).toBe(true);
  });

  test("E3.3 toolJSX set without shouldContinueAnimation -> canAnimate=false (set-and-blocking path)", () => {
    const tj: ToolJSXState = {
      jsx: "X",
      shouldHidePromptInput: false,
    };
    expect(canAnimate(tj, [], false)).toBe(false);
  });

  test("E3.4 toolJSX=null AND non-empty toolUseConfirmQueue -> canAnimate=false (queue-blocks path)", () => {
    expect(canAnimate(null, [{ id: "pending" }], false)).toBe(false);
  });

  test("E3.5 toolJSX=null AND empty queue AND isMessageSelectorVisible=true -> canAnimate=false (selector-blocks path)", () => {
    expect(canAnimate(null, [], true)).toBe(false);
  });

  test("B3.1 App.tsx passes the live toolJSX state variable to <Messages>, not a literal null or normalized copy", () => {
    const source = readSource();
    expect(source).toMatch(
      /<Messages\b[\s\S]{0,2000}toolJSX\s*=\s*\{\s*toolJSX(?:\s+as\s+\w+)?\s*\}/,
    );
    expect(source).not.toMatch(/<Messages\b[\s\S]{0,2000}toolJSX\s*=\s*\{\s*null\s*\}/);
  });

  test("B3.2 App.tsx renders the permission overlay unconditionally on permissionRequests[0] (dialog still mounts when toolJSX is set)", () => {
    const source = readSource();
    expect(source).toMatch(
      /<PermissionOverlay\b[\s\S]{0,200}request\s*=\s*\{\s*permissionRequests\[0\]\s*\}/,
    );
    // The overlay must NOT be wrapped in a `toolJSX === null && (...)` or `!toolJSX && (...)` gate,
    // because that would block dialogs when a tool is rendering its own UI surface
    // (counter to REPL.tsx:2061-2062 'show unless blocked by toolJSX').
    expect(source).not.toMatch(
      /\{\s*!toolJSX\s*&&\s*<PermissionOverlay\b/,
    );
    expect(source).not.toMatch(
      /\{\s*toolJSX\s*===\s*null\s*&&\s*<PermissionOverlay\b/,
    );
  });

  test("B3.3 App.tsx passes isMessageSelectorVisible={false} to <Messages> so the third canAnimate clause never spuriously blocks animation", () => {
    const source = readSource();
    expect(source).toMatch(
      /<Messages\b[\s\S]{0,2000}isMessageSelectorVisible\s*=\s*\{\s*false\s*\}/,
    );
  });

  test("B3.4 App.tsx passes the live buildToolUseConfirmQueue result to <Messages> so the queue-blocks clause respects pending confirmations", () => {
    const source = readSource();
    expect(source).toMatch(
      /<Messages\b[\s\S]{0,2000}toolUseConfirmQueue\s*=\s*\{\s*toolUseConfirmQueue(?:\s+as\s+\w+(?:\[\])?)?\s*\}/,
    );
    expect(source).toMatch(
      /toolUseConfirmQueue\s*=[\s\S]{0,200}buildToolUseConfirmQueue\s*\(\s*permissionRequests\s*,\s*tools\s*\)/,
    );
  });
});
