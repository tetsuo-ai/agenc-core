import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, describe, expect, test } from "vitest";

import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../../elicitation/types.js";
import type { DOMNode } from "../ink/dom.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import {
  ElicitationOverlay,
  elicitationAnswerControls,
  useTuiElicitation,
} from "./App.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TestSession = {
  services: {
    requestUserInputResolver?: {
      request(
        event: RequestUserInputEvent,
        signal?: AbortSignal,
      ): Promise<RequestUserInputResponse | null>;
    };
    mcpElicitationResolver?: {
      request(
        event: McpElicitationRequestEvent,
        signal?: AbortSignal,
      ): Promise<McpElicitationResponse | null>;
    };
  };
  subscribeToEvents(callback: (event: unknown) => void): () => void;
};

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > timeoutMs) throw error;
      await sleep(10);
    }
  }
}

function collectText(node: DOMNode): string {
  if (node.nodeName === "#text") return node.nodeValue;
  return node.childNodes.map(collectText).join("");
}

/**
 * Mounts the same text overlay the shell mounts for a pending request, with
 * real Ink input on a fake TTY. `submits` records every elicitation.submit.
 */
async function mountOverlay(): Promise<{
  readonly session: TestSession;
  readonly submits: string[];
  readonly text: () => string;
  readonly send: (sequence: string) => Promise<void>;
}> {
  const stdout = new PassThrough();
  stdout.resume();
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  const session: TestSession = { services: {}, subscribeToEvents: () => () => {} };
  const submits: string[] = [];

  function Harness(): React.ReactElement | null {
    const elicitation = useTuiElicitation(session);
    const submit = (value: string): boolean => {
      submits.push(value);
      return elicitation.submit(value);
    };
    return (
      <ElicitationOverlay
        prompt={elicitation.prompt}
        answer={elicitationAnswerControls(elicitation.pending, submit)}
      />
    );
  }

  root.render(<Harness />);
  disposers.push(async () => {
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep(10);
  });
  await waitFor(() => {
    expect(session.services.requestUserInputResolver).toBeDefined();
  });
  const rootNode = (): DOMNode => {
    const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
      | { rootNode?: DOMNode }
      | undefined;
    if (instance?.rootNode === undefined) throw new Error("Ink root node not found");
    return instance.rootNode;
  };
  return {
    session,
    submits,
    text: () => collectText(rootNode()),
    send: async (sequence) => {
      stdin.write(sequence);
      // A lone ESC is held briefly in case it starts a key sequence.
      await sleep(sequence === "\u001b" ? 90 : 30);
    },
  };
}

function freeTextQuestion(): RequestUserInputEvent {
  return {
    turnId: "turn-1",
    requestId: "text-request",
    callId: "text-call",
    questions: [
      { id: "details", header: "Details", question: "Describe the change" },
    ],
  };
}

function mcpNameRequest(): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "profile",
    requestId: "name-request",
    request: {
      mode: "form",
      message: "Who is asking",
      requestedSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Your name" },
        },
      },
    },
  };
}

describe("elicitation text overlay input", () => {
  test("typing and Enter send a free-text answer to elicitation.submit", async () => {
    const overlay = await mountOverlay();
    const response = overlay.session.services.requestUserInputResolver!.request(
      freeTextQuestion(),
    );
    await waitFor(() => expect(overlay.text()).toContain("Describe the change"));

    await overlay.send("\r");
    expect(overlay.submits).toEqual([]);
    await overlay.send("Use blue");
    await waitFor(() => expect(overlay.text()).toContain("› Use blue"));
    await overlay.send("\r");

    await expect(response).resolves.toEqual({
      answers: { details: { answers: ["Use blue"] } },
    });
    expect(overlay.submits).toEqual(["Use blue"]);
  });

  test("text and Enter in one read still submit the typed text", async () => {
    const overlay = await mountOverlay();
    const response = overlay.session.services.requestUserInputResolver!.request(
      freeTextQuestion(),
    );
    await waitFor(() => expect(overlay.text()).toContain("Describe the change"));

    await overlay.send("Use bluee\u007f\r");

    await expect(response).resolves.toEqual({
      answers: { details: { answers: ["Use blue"] } },
    });
    expect(overlay.submits).toEqual(["Use blue"]);
  });

  test("Escape answers skip, as the options picker does", async () => {
    const overlay = await mountOverlay();
    const response = overlay.session.services.requestUserInputResolver!.request(
      freeTextQuestion(),
    );
    await waitFor(() => expect(overlay.text()).toContain("esc skip"));

    await overlay.send("draft");
    await overlay.send("\u001b");

    await expect(response).resolves.toEqual({
      answers: { details: { answers: ["skip"] } },
    });
    expect(overlay.submits).toEqual(["skip"]);
  });

  test("an MCP form string field takes typed text, and Escape cancels", async () => {
    const overlay = await mountOverlay();
    const accepted = overlay.session.services.mcpElicitationResolver!.request(
      mcpNameRequest(),
    );
    await waitFor(() => expect(overlay.text()).toContain("Who is asking (name)"));
    await overlay.send("Ada\r");
    await expect(accepted).resolves.toEqual({
      action: "accept",
      content: { name: "Ada" },
    });

    const cancelled = overlay.session.services.mcpElicitationResolver!.request({
      ...mcpNameRequest(),
      requestId: "name-request-2",
    });
    await waitFor(() => expect(overlay.text()).toContain("esc cancel"));
    await overlay.send("\u001b");
    await expect(cancelled).resolves.toEqual({ action: "cancel" });
    expect(overlay.submits).toEqual(["Ada", "cancel"]);
  });
});
