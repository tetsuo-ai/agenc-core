import * as React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgenCSystemAPIErrorMessage } from "../../errors/api.js";
import { SystemAPIErrorMessage } from "./SystemAPIErrorMessage.js";

type LiveCreateSystemAPIErrorMessage =
  typeof import("../../agenc/upstream/utils/messages.js").createSystemAPIErrorMessage;
type LiveCreatedSystemAPIErrorMessage =
  ReturnType<LiveCreateSystemAPIErrorMessage>;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;
type _LiveCreatedMessageIsTyped = Assert<
  IsAny<LiveCreatedSystemAPIErrorMessage> extends false ? true : false
>;
type _LiveCreatedMessageIsCanonical = Assert<
  LiveCreatedSystemAPIErrorMessage extends AgenCSystemAPIErrorMessage
    ? true
    : false
>;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T) => [initial, () => {}],
  };
});

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
    useInterval: () => {},
  };
});

function renderPlain(node: React.ReactNode): string {
  return collectText(node);
}

function assertSystemAPIErrorMessage(
  _message: AgenCSystemAPIErrorMessage,
): void {}

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

describe("SystemAPIErrorMessage", () => {
  afterEach(() => {
    delete process.env.API_TIMEOUT_MS;
  });

  test("hides early retry attempts", () => {
    const output = renderPlain(
      <SystemAPIErrorMessage
        verbose={false}
        message={{
          type: "system",
          subtype: "api_error",
          level: "error",
          error: new Error("temporary"),
          retryAttempt: 2,
          retryInMs: 3000,
          maxRetries: 5,
        }}
      />,
    );

    expect(output.trim()).toBe("");
  });

  test("renders formatted retry text and timeout hint", () => {
    process.env.API_TIMEOUT_MS = "1000";

    const output = renderPlain(
      <SystemAPIErrorMessage
        verbose={false}
        message={{
          type: "system",
          subtype: "api_error",
          level: "error",
          error: Object.assign(new Error("Connection error."), {
            cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
          }),
          retryAttempt: 4,
          retryInMs: 3000,
          maxRetries: 5,
        }}
      />,
    );

    expect(output).toContain("Request timed out");
    expect(output).toContain("Retrying in 3 seconds");
    expect(output).toContain("API_TIMEOUT_MS=1000ms");
  });

  test("truncates long errors outside verbose mode", () => {
    const formatted = "x".repeat(1200);
    const output = renderPlain(
      <SystemAPIErrorMessage
        verbose={false}
        message={{
          type: "system",
          subtype: "api_error",
          level: "error",
          error: new Error(formatted),
          retryAttempt: 4,
          retryInMs: 1000,
          maxRetries: 5,
        }}
      />,
    );

    expect(output).toContain(`${"x".repeat(1000)}...`);
    expect(output).toContain("(ctrl+o to expand)");
    expect(output).not.toContain("x".repeat(1001));
  });

  test("renders the live-created API retry message shape through the typed boundary", () => {
    const cause = Object.assign(new Error("connect refused"), {
      code: "ECONNREFUSED",
    });
    const error = Object.assign(new Error("Connection error."), { cause });
    const message: LiveCreatedSystemAPIErrorMessage = {
      type: "system",
      subtype: "api_error",
      level: "error",
      cause,
      error,
      retryInMs: 1000,
      retryAttempt: 4,
      maxRetries: 5,
      timestamp: new Date().toISOString(),
      uuid: "api-error-test",
    };
    assertSystemAPIErrorMessage(message);

    const output = renderPlain(
      <SystemAPIErrorMessage verbose={false} message={message} />,
    );

    expect(message.level).toBe("error");
    expect(message.cause).toBe(cause);
    expect(output).toContain("Unable to connect to API (ECONNREFUSED)");
    expect(output).toContain("Retrying in 1 second");
  });
});
