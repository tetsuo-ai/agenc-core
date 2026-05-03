import { describe, expect, test, vi } from "vitest";

vi.mock("./ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

// branding-scan: allow compatibility bridge directory path
import { GlobPathsView } from "./openclaude/tool-stubs.js";

interface ChildProps {
  readonly children?: unknown;
  readonly dimColor?: boolean;
}

interface ChildElement {
  readonly props: ChildProps;
}

function flatten(node: unknown): ChildElement[] {
  if (!node || typeof node !== "object") return [];
  const children = (node as { props?: { children?: unknown } }).props?.children;
  const arr = Array.isArray(children) ? children : [children];
  return arr
    .flat(Infinity)
    .filter(
      (child): child is ChildElement =>
        typeof child === "object" && child !== null,
    );
}

describe("GlobPathsView", () => {
  test("renders explicit truncation state separately from the path list", () => {
    const node = GlobPathsView({
      content:
        "<glob-pattern>*.ts</glob-pattern>\n<glob-paths>a.ts\nb.ts</glob-paths>\n<glob-truncated>true</glob-truncated>",
    });
    const children = flatten(node);

    expect(children.find((child) => child.props.children === "a.ts")).toBeDefined();
    expect(
      children.find(
        (child) =>
          child.props.dimColor === true &&
          child.props.children ===
            "(Results are truncated. Consider using a more specific path or pattern.)",
      ),
    ).toBeDefined();
  });
});
