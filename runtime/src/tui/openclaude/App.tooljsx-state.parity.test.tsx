import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  applyToolJSXUpdate,
  type ToolJSXArgs,
  type ToolJSXState,
} from "./use-tool-jsx.js";

const APP_SOURCE_PATH = path.resolve(import.meta.dirname, "App.tsx");

function readSource(): string {
  return fs.readFileSync(APP_SOURCE_PATH, "utf8");
}

function args(over: Partial<ToolJSXArgs> = {}): ToolJSXArgs {
  return {
    jsx: null,
    shouldHidePromptInput: false,
    ...over,
  };
}

describe("R2 toolJSX state contract (use-tool-jsx + App.tsx wiring)", () => {
  test("E2.1 isLocalJSXCommand:true persists to local-ref AND returns args (minus clearLocalJSX) as next state", () => {
    const incoming = args({
      jsx: "X",
      isLocalJSXCommand: true,
      clearLocalJSX: false,
    });
    const result = applyToolJSXUpdate(incoming, null);
    expect("skip" in result && result.skip).not.toBe(true);
    if ("skip" in result && result.skip) return;
    // Wrapper destructures clearLocalJSX out of `rest` (REPL.tsx:1075-1077)
    // before persisting; both the state push and the local-ref store get
    // the rest spread, never the original clearLocalJSX directive.
    expect(result.nextState).toEqual({
      jsx: "X",
      shouldHidePromptInput: false,
      isLocalJSXCommand: true,
    });
    // The persisted ref entry strips clearLocalJSX and re-asserts
    // isLocalJSXCommand: true (mirroring REPL.tsx:1078-1081).
    expect(result.nextLocalRef).toEqual({
      jsx: "X",
      shouldHidePromptInput: false,
      isLocalJSXCommand: true,
    });
  });

  test("E2.2 with active local-ref and no clearLocalJSX, normal updates are skipped (REPL.tsx:1095 'keep the local JSX command visible')", () => {
    const localRef: ToolJSXState = {
      jsx: "local",
      shouldHidePromptInput: false,
      isLocalJSXCommand: true,
    };
    const incoming = args({ jsx: "tool-update", showSpinner: false });
    const result = applyToolJSXUpdate(incoming, localRef);
    expect("skip" in result && result.skip).toBe(true);
  });

  test("E2.3 with active local-ref and clearLocalJSX:true, both state and ref are cleared to null", () => {
    const localRef: ToolJSXState = {
      jsx: "local",
      shouldHidePromptInput: false,
      isLocalJSXCommand: true,
    };
    const incoming = args({ jsx: null, clearLocalJSX: true });
    const result = applyToolJSXUpdate(incoming, localRef);
    expect("skip" in result && result.skip).not.toBe(true);
    if ("skip" in result && result.skip) return;
    expect(result.nextState).toBeNull();
    expect(result.nextLocalRef).toBeNull();
  });

  test("E2.4 with no local-ref and clearLocalJSX:true, state goes to null without touching ref", () => {
    const incoming = args({ jsx: null, clearLocalJSX: true });
    const result = applyToolJSXUpdate(incoming, null);
    expect("skip" in result && result.skip).not.toBe(true);
    if ("skip" in result && result.skip) return;
    expect(result.nextState).toBeNull();
    expect(result.nextLocalRef).toBeUndefined();
  });

  test("E2.5 with no local-ref and a normal value, args are returned verbatim as next state (no transformation, no ref write)", () => {
    const incoming = args({ jsx: "panel", showSpinner: true });
    const result = applyToolJSXUpdate(incoming, null);
    expect("skip" in result && result.skip).not.toBe(true);
    if ("skip" in result && result.skip) return;
    expect(result.nextState).toBe(incoming);
    expect(result.nextLocalRef).toBeUndefined();
  });

  test("E2.6 applyToolJSXUpdate(null, null) returns null state (full clear, no local-ref to consider)", () => {
    const result = applyToolJSXUpdate(null, null);
    expect("skip" in result && result.skip).not.toBe(true);
    if ("skip" in result && result.skip) return;
    expect(result.nextState).toBeNull();
  });

  test("E2.6b applyToolJSXUpdate(null, localRef) is skipped (active local-ref blocks normal clears that are not explicit clearLocalJSX:true)", () => {
    const localRef: ToolJSXState = {
      jsx: "local",
      shouldHidePromptInput: false,
      isLocalJSXCommand: true,
    };
    const result = applyToolJSXUpdate(null, localRef);
    expect("skip" in result && result.skip).toBe(true);
  });

  test("E2.7 App.tsx no longer hardcodes toolJSX={null} on <Messages>; the prop is wired to a state variable", () => {
    const source = readSource();
    expect(source).not.toMatch(/toolJSX\s*=\s*\{\s*null\s*\}/);
    expect(source).toMatch(/toolJSX\s*=\s*\{\s*toolJSX[^}]*\}/);
  });

  test("E2.8 App.tsx renders toolJSX.jsx as a sibling Box (matches REPL.tsx:4469-4470)", () => {
    const source = readSource();
    expect(source).toMatch(
      /toolJSX\s*!==?\s*null[\s\S]{0,200}<Box[^>]*flexDirection="column"[^>]*width="100%"[\s\S]{0,200}\{\s*toolJSX\.jsx\s*\}[\s\S]{0,200}<\/Box>/,
    );
  });

  test("B2.3 setToolJSX is exposed via getToolUseContext so AgenC tools can call it", () => {
    const source = readSource();
    expect(source).toMatch(/getToolUseContext\s*=[\s\S]*setToolJSX/m);
  });
});
