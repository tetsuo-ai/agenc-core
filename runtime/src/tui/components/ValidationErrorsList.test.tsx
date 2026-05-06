import * as React from "react";
import { describe, expect, test, vi } from "vitest";

import { InvalidSettingsDialog } from "./InvalidSettingsDialog";
import {
  buildValidationErrorTree,
  ValidationErrorsList,
} from "./ValidationErrorsList.js";

vi.mock("react-compiler-runtime", () => ({
  c: (size: number) =>
    Array.from({ length: size }, () =>
      Symbol.for("react.memo_cache_sentinel"),
    ),
}));

vi.mock("../ink.js", async () => {
  const React = await import("react");
  const Passthrough = ({
    children,
  }: {
    readonly children?: React.ReactNode;
  }) => React.createElement(React.Fragment, null, children);
  return {
    Box: Passthrough,
    Text: Passthrough,
  };
});

vi.mock("./design-system/Dialog.js", async () => {
  const React = await import("react");
  return {
    Dialog: ({
      title,
      children,
    }: {
      readonly title: React.ReactNode;
      readonly children?: React.ReactNode;
    }) => React.createElement(React.Fragment, null, title, children),
  };
});

vi.mock("./CustomSelect/select.js", async () => {
  const React = await import("react");
  return {
    Select: ({
      options,
    }: {
      readonly options: readonly { readonly label: React.ReactNode }[];
    }) =>
      React.createElement(
        React.Fragment,
        null,
        options.map((option) => option.label),
      ),
  };
});

function renderPlain(node: React.ReactNode): string {
  return collectText(node);
}

function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join("");
  }
  if (React.isValidElement(node)) {
    const element = node as React.ReactElement<{
      readonly children?: React.ReactNode;
    }>;
    if (typeof element.type === "function") {
      const Component = element.type as (
        props: typeof element.props,
      ) => React.ReactNode;
      return collectText(Component(element.props));
    }
    return collectText(element.props.children);
  }
  return "";
}

describe("ValidationErrorsList", () => {
  test("renders validation output through the live settings dialog route", () => {
    const output = renderPlain(
      <InvalidSettingsDialog
        settingsErrors={[
          {
            file: "config.toml",
            path: "permissions.allow.0",
            message: "Unknown tool",
            invalidValue: "bad-tool",
          },
        ]}
        onContinue={() => {}}
        onExit={() => {}}
      />,
    );

    expect(output).toContain("Settings Error");
    expect(output).toContain("config.toml");
    expect(output).toContain('"bad-tool"');
    expect(output).toContain("Unknown tool");
    expect(output).toContain("Exit and fix manually");
  });

  test("builds a readable nested tree with invalid indexed values", () => {
    expect(
      buildValidationErrorTree([
        {
          file: "config.toml",
          path: "permissions.allow.0",
          message: "Unknown tool",
          invalidValue: "bad-tool",
        },
      ]),
    ).toEqual({
      permissions: {
        allow: {
          '"bad-tool"': "Unknown tool",
        },
      },
    });

    expect(
      buildValidationErrorTree([
        {
          file: "config.toml",
          path: "permissions.allow.0",
          message: "Ambiguous tool",
          invalidValue: 'bad.tool["x"]\nnext',
        },
      ]),
    ).toEqual({
      permissions: {
        allow: {
          '"bad.tool[\\"x\\"]\\nnext"': "Ambiguous tool",
        },
      },
    });
  });

  test("renders grouped files, tree output, and unique suggestions", () => {
    const output = renderPlain(
      <ValidationErrorsList
        errors={[
          {
            file: "b.toml",
            path: "z",
            message: "Last",
          },
          {
            file: "a.toml",
            path: "permissions.allow.0",
            message: "Unknown tool",
            invalidValue: "bad-tool",
            suggestion: "Run agenc config validate after editing.",
            docLink: "urn:agenc:config:permissions",
          },
          {
            file: "a.toml",
            path: "",
            message: "Root error",
            suggestion: "Run agenc config validate after editing.",
            docLink: "urn:agenc:config:permissions",
          },
        ]}
      />,
    );

    expect(output.indexOf("a.toml")).toBeLessThan(output.indexOf("b.toml"));
    expect(output).toContain("Root error");
    expect(output).toContain('"bad-tool"');
    expect(output).toContain("Unknown tool");
    expect(output.match(/Run agenc config validate/g)).toHaveLength(1);
    expect(output).toContain("urn:agenc:config:permissions");
  });
});
