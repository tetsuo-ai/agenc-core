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

function textOf(child: ChildElement): string {
  return String(child.props.children ?? "");
}

describe("coverage swarm row 017 tool-rendering branches", () => {
  test("EditDiffView renders no-change headers and truncates long diff output", () => {
    const emptyChildren = flatten(
      EditDiffView({
        content: "<edit-file>src/a.ts</edit-file><edit-diff></edit-diff>",
      }),
    );

    expect(
      emptyChildren.find(
        (child) => child.props.bold === true && child.props.children === "src/a.ts",
      ),
    ).toBeDefined();
    expect(
      emptyChildren.find(
        (child) =>
          child.props.dimColor === true &&
          child.props.children === "(No changes)",
      ),
    ).toBeDefined();

    const longDiff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      " unchanged context",
      "x".repeat(9000),
    ].join("\n");
    const diffChildren = flatten(
      EditDiffView({
        content: `<edit-file>src/a.ts</edit-file><edit-diff>${longDiff}</edit-diff>`,
      }),
    );

    expect(
      diffChildren.find(
        (child) => child.props.dimColor === true && textOf(child).startsWith("---"),
      ),
    ).toBeDefined();
    expect(
      diffChildren.find(
        (child) => child.props.dimColor === true && textOf(child).startsWith("+++"),
      ),
    ).toBeDefined();
    expect(diffChildren.some((child) => textOf(child).includes("chars truncated")))
      .toBe(true);
  });

  test("FileReadView renders ranged content and omits an empty header", () => {
    const rangedChildren = flatten(
      FileReadView({
        content:
          "<read-file>src/a.ts</read-file><read-lines>10-12</read-lines><read-content>body</read-content>",
      }),
    );

    expect(
      rangedChildren.find(
        (child) =>
          child.props.bold === true &&
          child.props.children === "src/a.ts [10-12]",
      ),
    ).toBeDefined();
    expect(rangedChildren.find((child) => child.props.children === "body"))
      .toBeDefined();

    const bodyOnlyChildren = flatten(
      FileReadView({ content: "<read-content>body only</read-content>" }),
    );
    expect(bodyOnlyChildren.find((child) => child.props.bold === true))
      .toBeUndefined();
    expect(bodyOnlyChildren.find((child) => child.props.children === "body only"))
      .toBeDefined();
  });

  test("GrepMatchesView renders singular, plural, and truncated match lists", () => {
    const singleChildren = flatten(
      GrepMatchesView({
        content:
          "<grep-pattern>needle</grep-pattern><grep-matches>src/a.ts:1:needle</grep-matches>",
      }),
    );

    expect(
      singleChildren.find(
        (child) =>
          child.props.bold === true &&
          child.props.children === "Grep: needle (1 match)",
      ),
    ).toBeDefined();
    expect(
      singleChildren.find((child) => child.props.children === "src/a.ts:1:needle"),
    ).toBeDefined();

    const matches = Array.from(
      { length: 202 },
      (_, index) => `src/${index}.ts:${index}:hit`,
    ).join("\n");
    const manyChildren = flatten(
      GrepMatchesView({
        content: `<grep-pattern>hit</grep-pattern><grep-matches>${matches}</grep-matches>`,
      }),
    );

    expect(
      manyChildren.find(
        (child) =>
          child.props.bold === true &&
          child.props.children === "Grep: hit (202 matches)",
      ),
    ).toBeDefined();
    expect(
      manyChildren.find(
        (child) =>
          child.props.dimColor === true &&
          textOf(child).includes("2 more matches truncated"),
      ),
    ).toBeDefined();
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

  test("BashOutputView colors stderr and failed metadata while omitting silent state", () => {
    const failedChildren = flatten(
      BashOutputView({
        content:
          "<bash-stdout>ok</bash-stdout><bash-stderr>err</bash-stderr>[exit_code=2 duration_ms=3]",
      }),
    );

    expect(failedChildren.find((child) => child.props.children === "ok"))
      .toBeDefined();
    expect(
      failedChildren.find(
        (child) => child.props.color === "red" && child.props.children === "err",
      ),
    ).toBeDefined();
    expect(
      failedChildren.find(
        (child) =>
          child.props.color === "red" &&
          child.props.dimColor === false &&
          child.props.children === "[exit_code=2 duration_ms=3]",
      ),
    ).toBeDefined();
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
