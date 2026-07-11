/**
 * Accessibility snapshot formatting + ref stability.
 *
 * Revert-sensitivity: the "same ref across re-snapshot" assertion goes red if
 * RefRegistry stops memoizing backendId → ref (e.g. assigns a fresh counter
 * each snapshot).
 */

import { describe, expect, test } from "vitest";
import { formatSnapshot, RefRegistry, type AXNode } from "../../src/browser/snapshot.js";

function ax(
  nodeId: string,
  role: string,
  name: string | undefined,
  backendDOMNodeId: number | undefined,
  childIds: string[] = [],
): AXNode {
  return {
    nodeId,
    role: { value: role },
    ...(name !== undefined ? { name: { value: name } } : {}),
    ...(backendDOMNodeId !== undefined ? { backendDOMNodeId } : {}),
    childIds,
  };
}

// A tiny form: root > form > (textbox, button).
function formTree(): AXNode[] {
  return [
    ax("1", "RootWebArea", "Login", 1, ["2"]),
    ax("2", "form", undefined, 2, ["3", "4"]),
    ax("3", "textbox", "Username", 3, []),
    ax("4", "button", "Sign in", 4, []),
  ];
}

describe("formatSnapshot", () => {
  test("tags actionable elements with refs and names", () => {
    const { text, refToBackendId } = formatSnapshot(formTree(), new RefRegistry());
    expect(text).toContain('textbox "Username" [ref=e1]');
    expect(text).toContain('button "Sign in" [ref=e2]');
    // Root/form are structural — shown, not ref-tagged.
    expect(text).toContain("RootWebArea");
    expect(text).not.toMatch(/RootWebArea.*\[ref=/);
    expect(refToBackendId.get("e1")).toBe(3);
    expect(refToBackendId.get("e2")).toBe(4);
  });

  test("indents children under their parent", () => {
    const { text } = formatSnapshot(formTree(), new RefRegistry());
    const lines = text.split("\n");
    const formLine = lines.find((l) => l.includes("form"));
    const textboxLine = lines.find((l) => l.includes("textbox"));
    expect(formLine).toBeDefined();
    expect(textboxLine).toBeDefined();
    // textbox is deeper than form.
    const indentOf = (l: string): number => l.length - l.trimStart().length;
    expect(indentOf(textboxLine!)).toBeGreaterThan(indentOf(formLine!));
  });

  test("refs are stable across re-snapshots of the same document", () => {
    const registry = new RefRegistry();
    const first = formatSnapshot(formTree(), registry);
    const second = formatSnapshot(formTree(), registry);
    expect(second.text).toBe(first.text);
    expect(second.refToBackendId.get("e1")).toBe(3);
    expect(second.refToBackendId.get("e2")).toBe(4);
  });

  test("reset() gives a fresh document new refs from e1", () => {
    const registry = new RefRegistry();
    formatSnapshot(formTree(), registry);
    registry.reset();
    // A different page with a single button — it should be e1 again.
    const fresh = formatSnapshot(
      [ax("1", "RootWebArea", "New", 1, ["2"]), ax("2", "button", "Go", 99, [])],
      registry,
    );
    expect(fresh.refToBackendId.get("e1")).toBe(99);
  });

  test("skips ignored nodes", () => {
    const nodes: AXNode[] = [
      ax("1", "RootWebArea", "R", 1, ["2", "3"]),
      { ...ax("2", "button", "Hidden", 2, []), ignored: true },
      ax("3", "button", "Shown", 3, []),
    ];
    const { text, refToBackendId } = formatSnapshot(nodes, new RefRegistry());
    expect(text).toContain('button "Shown"');
    expect(text).not.toContain("Hidden");
    expect([...refToBackendId.values()]).toEqual([3]);
  });
});
