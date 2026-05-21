import * as React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgenCSystemAPIErrorMessage } from "../../../src/errors/api.js";
import { SystemAPIErrorMessage } from "../../../src/tui/components/SystemAPIErrorMessage.js";

const harness = vi.hoisted(() => ({
  countdownMs: 0,
  intervalCallback: undefined as (() => void) | undefined,
  intervalMs: undefined as number | null | undefined,
  stateUpdates: [] as number[],
  reset() {
    harness.countdownMs = 0;
    harness.intervalCallback = undefined;
    harness.intervalMs = undefined;
    harness.stateUpdates = [];
  },
}));

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T) => [
      harness.countdownMs as T,
      (updater: T | ((value: T) => T)) => {
        const next =
          typeof updater === "function"
            ? (updater as (value: T) => T)(harness.countdownMs as T)
            : updater;
        harness.countdownMs = Number(next);
        harness.stateUpdates.push(harness.countdownMs);
      },
    ],
  };
});

vi.mock("../../../src/tui/ink.js", async () => {
  const ReactModule = await import("react");
  const Passthrough = ({
    children,
  }: {
    readonly children?: React.ReactNode;
  }) => ReactModule.createElement(ReactModule.Fragment, null, children);

  return {
    Box: Passthrough,
    Text: Passthrough,
    useInterval: (callback: () => void, intervalMs: number | null) => {
      harness.intervalCallback = callback;
      harness.intervalMs = intervalMs;
    },
  };
});

vi.mock("../../../src/tui/components/MessageResponse.js", async () => {
  const ReactModule = await import("react");
  return {
    MessageResponse: ({
      children,
    }: {
      readonly children?: React.ReactNode;
    }) => ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

function message(
  overrides: Partial<AgenCSystemAPIErrorMessage> = {},
): AgenCSystemAPIErrorMessage {
  return {
    type: "system",
    subtype: "api_error",
    level: "error",
    error: new Error("provider unavailable"),
    retryAttempt: 4,
    retryInMs: 3000,
    maxRetries: 6,
    ...overrides,
  };
}

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

describe("SystemAPIErrorMessage coverage swarm row 228", () => {
  beforeEach(() => {
    harness.reset();
  });

  afterEach(() => {
    delete process.env.API_TIMEOUT_MS;
  });

  test("suppresses early retry attempts and pauses the countdown interval", () => {
    const output = renderPlain(
      <SystemAPIErrorMessage
        verbose={false}
        message={message({ retryAttempt: 3 })}
      />,
    );

    expect(output).toBe("");
    expect(harness.intervalMs).toBeNull();
  });

  test("renders retry details and advances through the countdown callback", () => {
    process.env.API_TIMEOUT_MS = "2500";

    const output = renderPlain(
      <SystemAPIErrorMessage verbose={false} message={message()} />,
    );

    expect(output).toContain("provider unavailable");
    expect(output).toContain("Retrying in 3 seconds... (attempt 4/6)");
    expect(output).toContain("API_TIMEOUT_MS=2500ms, try increasing it");
    expect(harness.intervalMs).toBe(1000);

    harness.intervalCallback?.();

    expect(harness.stateUpdates).toEqual([1000]);
  });

  test("uses singular seconds and pauses when the retry countdown is done", () => {
    harness.countdownMs = 1000;

    const output = renderPlain(
      <SystemAPIErrorMessage
        verbose={false}
        message={message({ retryInMs: 1000, maxRetries: 4 })}
      />,
    );

    expect(output).toContain("Retrying in 0 seconds... (attempt 4/4)");
    expect(harness.intervalMs).toBeNull();

    harness.reset();

    const singularOutput = renderPlain(
      <SystemAPIErrorMessage
        verbose={false}
        message={message({ retryInMs: 1000 })}
      />,
    );

    expect(singularOutput).toContain("Retrying in 1 second... (attempt 4/6)");
    expect(harness.intervalMs).toBe(1000);
  });

  test("truncates long formatted errors unless verbose output is requested", () => {
    const longMessage = "x".repeat(1200);

    const truncatedOutput = renderPlain(
      <SystemAPIErrorMessage
        verbose={false}
        message={message({ error: new Error(longMessage) })}
      />,
    );

    expect(truncatedOutput).toContain(`${"x".repeat(1000)}...`);
    expect(truncatedOutput).toContain("(ctrl+o to expand)");
    expect(truncatedOutput).not.toContain("x".repeat(1001));

    harness.reset();

    const verboseOutput = renderPlain(
      <SystemAPIErrorMessage
        verbose={true}
        message={message({ error: new Error(longMessage) })}
      />,
    );

    expect(verboseOutput).toContain(longMessage);
    expect(verboseOutput).not.toContain("(ctrl+o to expand)");
  });
});
