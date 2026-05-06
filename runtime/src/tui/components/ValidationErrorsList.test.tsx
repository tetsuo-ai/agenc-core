import * as React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import {
  buildValidationErrorTree,
  ValidationErrorsList,
} from "./ValidationErrorsList.js";

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
  test("is wired into the live upstream settings callers", () => {
    const doctorSource = readFileSync(
      new URL("../../agenc/upstream/screens/Doctor.tsx", import.meta.url),
      "utf8",
    );
    const invalidSettingsDialogSource = readFileSync(
      new URL(
        "../../agenc/upstream/components/InvalidSettingsDialog.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(doctorSource).toContain(
      "../../../tui/components/ValidationErrorsList.js",
    );
    expect(invalidSettingsDialogSource).toContain(
      "../../../tui/components/ValidationErrorsList.js",
    );
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
