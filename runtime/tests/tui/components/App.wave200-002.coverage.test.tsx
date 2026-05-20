import { PassThrough } from "node:stream";

import React, { useEffect } from "react";
import { describe, expect, test } from "vitest";

import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
} from "../../elicitation/types.js";
import { createRoot } from "../ink/root.js";
import {
  type ElicitationPromptState,
  type TuiElicitationState,
  useTuiElicitation,
} from "./App.js";

type TestSession = {
  services: {
    mcpElicitationResolver?: {
      request(
        event: McpElicitationRequestEvent,
        signal?: AbortSignal,
      ): Promise<McpElicitationResponse | null>;
    };
  };
  subscribeToEvents(callback: (event: unknown) => void): () => void;
};

function createStreams(): {
  readonly stdout: PassThrough;
  readonly stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
} {
  const stdout = new PassThrough();
  stdout.resume();
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  return { stdin, stdout };
}

function createSession(): TestSession {
  return {
    services: {},
    subscribeToEvents: () => () => {},
  };
}

function mcpFormRequest(): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "prefs",
    requestId: "request-1",
    request: {
      mode: "form",
      message: "Configure access",
      requestedSchema: {
        type: "object",
        required: ["color", "scopes"],
        properties: {
          color: {
            type: "string",
            description: "Pick a color",
            oneOf: [
              { const: "red", title: "Red" },
              { const: "blue", title: "Blue" },
            ],
          },
          scopes: {
            type: "array",
            description: "Pick scopes",
            minItems: 1,
            items: {
              type: "string",
              anyOf: [
                { const: "read", title: "Read Files" },
                { const: "write", title: "Write Files" },
              ],
            },
          },
        },
      },
    },
  };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep();
    }
  }
  throw lastError;
}

describe("App MCP elicitation prompt coverage", () => {
  test("surfaces titled enum details while submitting a multi-field MCP form", async () => {
    const session = createSession();
    const prompts: Array<ElicitationPromptState | null> = [];
    const latest: { current: TuiElicitationState | null } = { current: null };
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    function Harness(): null {
      const elicitation = useTuiElicitation(session);
      latest.current = elicitation;
      useEffect(() => {
        prompts.push(elicitation.prompt);
      }, [elicitation.prompt]);
      return null;
    }

    try {
      root.render(<Harness />);
      await waitFor(() => {
        expect(session.services.mcpElicitationResolver).toBeDefined();
      });

      const pending = session.services.mcpElicitationResolver!.request(
        mcpFormRequest(),
      );

      await waitFor(() => {
        expect(prompts.at(-1)).toEqual({
          title: "MCP: prefs",
          message: "Configure access (color)",
          detailLines: [
            "Pick a color",
            "Allowed: red (Red), blue (Blue)",
            "Type decline or cancel to reject this request.",
          ],
          placeholder: "Enter value",
        });
      });

      expect(latest.current?.submit("red")).toBe(true);
      await waitFor(() => {
        expect(prompts.at(-1)).toEqual({
          title: "MCP: prefs",
          message: "Configure access (scopes)",
          detailLines: [
            "Pick scopes",
            "Allowed: read (Read Files), write (Write Files)",
            "Type decline or cancel to reject this request.",
          ],
          placeholder: "Enter value",
        });
      });

      expect(latest.current?.submit("delete")).toBe(true);
      await waitFor(() => {
        expect(prompts.at(-1)?.detailLines[0]).toBe(
          "Invalid input: scopes delete must be one of: read, write",
        );
      });

      expect(latest.current?.submit("read, write")).toBe(true);
      await expect(pending).resolves.toEqual({
        action: "accept",
        content: {
          color: "red",
          scopes: ["read", "write"],
        },
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
