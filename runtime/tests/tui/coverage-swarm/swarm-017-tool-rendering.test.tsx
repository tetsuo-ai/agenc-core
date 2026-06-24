import { describe, expect, test, vi } from "vitest";

vi.mock("../ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import {
  BashOutputView,
  createTuiTool,
  EditDiffView,
  FileReadView,
  GlobPathsView,
  GrepMatchesView,
  ToolErrorView,
} from "../tool-rendering.js";

interface ChildProps {
  readonly bold?: boolean;
  readonly children?: unknown;
  readonly color?: string;
  readonly dimColor?: boolean;
}

interface ChildElement {
  readonly props: ChildProps;
}

function flatten(node: unknown): ChildElement[] {
  // Recurse through the element tree. BashOutputView now nests its stdout/stderr
  // lines one level deeper inside the `⎿`-gutter content column, so a shallow
  // (immediate-children only) walk would miss them.
  const out: ChildElement[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    out.push(value as ChildElement);
    const children = (value as { props?: { children?: unknown } }).props
      ?.children;
    if (children !== undefined) visit(children);
  };
  const top = (node as { props?: { children?: unknown } })?.props?.children;
  visit(top);
  return out;
}

function textOf(child: ChildElement): string {
  return String(child.props.children ?? "");
}

describe("coverage swarm row 017 tool-rendering branches", () => {
  test("EditDiffView renders a (No changes) fallback and a capped (+a -r) diff", () => {
    const emptyNode = EditDiffView({
      content: "<edit-file>src/a.ts</edit-file><edit-diff></edit-diff>",
    }) as { props: ChildProps };
    expect(emptyNode.props.children).toBe("(No changes)");
    expect(emptyNode.props.dimColor).toBe(true);

    const longDiff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      " unchanged context",
      "+added line",
      "x".repeat(9000),
    ].join("\n");
    const diffChildren = flatten(
      EditDiffView({
        content: `<edit-file>src/a.ts</edit-file><edit-diff>${longDiff}</edit-diff>`,
      }),
    );

    // The +++ / --- header lines are excluded from the change rows; the stat
    // line carries the path and (+a -r) summary.
    expect(
      diffChildren.some((child) => textOf(child).startsWith("--- a/src")),
    ).toBe(false);
    expect(
      diffChildren.some((child) => textOf(child).startsWith("+++ b/src")),
    ).toBe(false);
    expect(
      diffChildren.find(
        (child) =>
          child.props.dimColor === true && textOf(child).includes("(+1 -0)"),
      ),
    ).toBeDefined();
    // The added line is width-capped on the change row.
    expect(diffChildren.some((child) => child.props.color === "green")).toBe(true);
  });

  test("FileReadView summarizes ranged content as 'Read N lines'", () => {
    const ranged = FileReadView({
      content:
        "<read-file>src/a.ts</read-file><read-lines>10-12</read-lines><read-content>body</read-content>",
    }) as { props: ChildProps };
    expect(ranged.props.children).toBe("Read 3 lines");

    const bodyOnly = FileReadView({
      content: "<read-content>body only</read-content>",
    }) as { props: ChildProps };
    expect(bodyOnly.props.children).toBe("Read 1 line");
  });

  test("GrepMatchesView summarizes singular and plural match counts", () => {
    const single = GrepMatchesView({
      content:
        "<grep-pattern>needle</grep-pattern><grep-matches>src/a.ts:1:needle</grep-matches>",
    }) as { props: ChildProps };
    expect(single.props.children).toBe("Found 1 match");

    const matches = Array.from(
      { length: 202 },
      (_, index) => `src/${index}.ts:${index}:hit`,
    ).join("\n");
    const many = GrepMatchesView({
      content: `<grep-pattern>hit</grep-pattern><grep-matches>${matches}</grep-matches>`,
    }) as { props: ChildProps };
    expect(many.props.children).toBe("Found 202 matches");
  });

  test("GlobPathsView renders singular headers, headerless lists, and truncation", () => {
    const singleChildren = flatten(
      GlobPathsView({
        content: "<glob-pattern>*.ts</glob-pattern><glob-paths>src/a.ts</glob-paths>",
      }),
    );

    expect(
      singleChildren.find(
        (child) =>
          child.props.bold === true &&
          child.props.children === "Glob: *.ts (1 path)",
      ),
    ).toBeDefined();
    expect(singleChildren.find((child) => child.props.children === "src/a.ts"))
      .toBeDefined();
    expect(singleChildren.some((child) => textOf(child).includes("truncated")))
      .toBe(false);

    const paths = Array.from(
      { length: 201 },
      (_, index) => `src/${index}.ts`,
    ).join("\n");
    const manyChildren = flatten(
      GlobPathsView({
        content: `<glob-paths>${paths}</glob-paths><glob-truncated>true</glob-truncated>`,
      }),
    );

    expect(manyChildren.find((child) => child.props.bold === true))
      .toBeUndefined();
    expect(
      manyChildren.find(
        (child) =>
          child.props.dimColor === true &&
          textOf(child).includes("1 more paths truncated"),
      ),
    ).toBeDefined();
    expect(
      manyChildren.find(
        (child) =>
          child.props.dimColor === true &&
          textOf(child).startsWith("(Results are truncated."),
      ),
    ).toBeDefined();
  });

  test("BashOutputView shows stdout + red stderr on failure, no metadata line", () => {
    const failedChildren = flatten(
      BashOutputView({
        content:
          "<bash-stdout>ok</bash-stdout><bash-stderr>err</bash-stderr>[exit_code=2 duration_ms=3]",
      }),
    );

    expect(failedChildren.find((child) => child.props.children === "ok"))
      .toBeDefined();
    // Non-zero exit surfaces stderr in red.
    expect(
      failedChildren.find(
        (child) => child.props.color === "red" && child.props.children === "err",
      ),
    ).toBeDefined();
    // The raw [exit_code=... duration_ms=...] metadata block is no longer shown.
    expect(
      failedChildren.some((child) => textOf(child).startsWith("[exit_code=")),
    ).toBe(false);
    expect(failedChildren.some((child) => child.props.children === "(No output)"))
      .toBe(false);

    const plainChildren = flatten(
      BashOutputView({ content: "<bash-stdout>ok</bash-stdout>" }),
    );
    expect(plainChildren.find((child) => child.props.children === "ok"))
      .toBeDefined();
    expect(plainChildren.some((child) => textOf(child).startsWith("[exit_code=")))
      .toBe(false);
  });

  test("ToolErrorView uses named error envelopes", () => {
    const children = flatten(
      ToolErrorView({
        content:
          "<tool-error-name>CustomTool</tool-error-name><tool-error>bad input</tool-error>",
      }),
    );

    expect(
      children.find(
        (child) =>
          child.props.bold === true &&
          child.props.color === "red" &&
          child.props.children === "CustomTool error",
      ),
    ).toBeDefined();
    expect(children.find((child) => child.props.children === "bad input"))
      .toBeDefined();
  });

  test("createTuiTool covers read, command, search, MCP, Skill, and Bash summaries", () => {
    const read = createTuiTool("FileRead");
    expect(read.getPath({ path: "src/from-path.ts" })).toBe("src/from-path.ts");
    expect(read.getActivityDescription({ file_path: "src/read.ts" })).toBe(
      "Reading src/read.ts",
    );
    expect(read.getActivityDescription({})).toBe("Reading file");
    expect(read.isReadOnly()).toBe(true);
    expect(read.renderToolUseMessage({ file_path: "src/read.ts" })).toBe(
      "src/read.ts",
    );
    expect(read.renderToolUseMessage({})).toBe("file");
    expect(read.userFacingName()).toBe("Read");

    const command = createTuiTool("exec_command");
    expect(command.userFacingName({})).toBe("Run");
    expect(command.renderToolUseMessage({ cmd: "  npm   test  " })).toBe(
      "npm test",
    );
    expect(command.renderToolUseMessage({})).toBe("command");
    expect(command.getActivityDescription({ command: "pnpm build" })).toBe(
      "Run: pnpm build",
    );

    const search = createTuiTool("system.searchTools");
    expect(search.userFacingName({})).toBe("Tool search");
    expect(search.renderToolUseMessage({ select: "Read" })).toBe(
      "Select tool: Read",
    );
    expect(search.renderToolUseMessage({ query: "file tools" })).toBe(
      "Search tools: file tools",
    );
    expect(search.getActivityDescription({ query: "grep" })).toBe(
      "Search tools: grep",
    );

    const mcp = createTuiTool("mcp.server.tool");
    expect(mcp.renderToolUseMessage({})).toBe("");
    expect(mcp.getActivityDescription({})).toBe("mcp.server.tool");

    const skill = createTuiTool("Skill");
    expect(skill.userFacingName({ name: "deploy", args: "target\nprod" })).toBe(
      "$deploy",
    );
    expect(skill.renderToolUseMessage({ name: "deploy", args: "target\nprod" }))
      .toBe("target prod");
    expect(skill.renderToolUseMessage({ skill: "" })).toBe("");
    expect(skill.getActivityDescription({ skill: "" })).toBe("Load $skill");

    const bash = createTuiTool("Bash");
    expect(bash.renderToolUseMessage({ command: "echo\nhello" })).toBe(
      "echo hello",
    );
  });

  test("renderToolUseErrorMessage supports string and non-message errors", () => {
    const tool = createTuiTool("DynamicTool");
    const stringError = tool.renderToolUseErrorMessage("plain failure");
    expect(
      (stringError as { readonly props: { readonly content: string } }).props
        .content,
    ).toContain("<tool-error>plain failure</tool-error>");

    const objectError = tool.renderToolUseErrorMessage({ code: 500 });
    expect(
      (objectError as { readonly props: { readonly content: string } }).props
        .content,
    ).toContain("<tool-error>{\"code\":500}</tool-error>");
  });
});
