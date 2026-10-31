import { PassThrough } from "node:stream";

import React, { useMemo } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigStore } from "../../config/store.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../../elicitation/types.js";
import { useIsModalOverlayActive } from "../context/overlayContext.js";
import { CancelRequestHandler } from "../hooks/useCancelRequest.js";
import type { DOMNode } from "../ink/dom.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { KeybindingSetup } from "../keybindings/KeybindingProviderSetup.js";
import { AppStateProvider, getDefaultAppState } from "../state/AppState.js";
import {
  ElicitationRequestOverlay,
  installElicitationResolvers,
  type PendingElicitation,
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

/** Records whether the promise has settled and with what. */
function track<T>(promise: Promise<T>): { readonly settled: () => boolean; readonly value: () => T | undefined } {
  let settled = false;
  let value: T | undefined;
  void promise.then((result) => {
    settled = true;
    value = result;
  });
  return { settled: () => settled, value: () => value };
}

/**
 * Mounts the overlay the shell mounts for a pending request, inside the real
 * app state, keybinding provider and turn cancel handler, with a turn running.
 * Keys are real bytes on a fake TTY. `submits` records every answer sent to
 * the elicitation controller.
 */
async function mountOverlay(): Promise<{
  readonly session: TestSession;
  readonly submits: string[];
  readonly onCancel: ReturnType<typeof vi.fn>;
  readonly text: () => string;
  readonly send: (sequence: string) => Promise<void>;
  readonly waitForOwnership: () => Promise<void>;
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
    exitOnCtrlC: false,
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  const session: TestSession = { services: {}, subscribeToEvents: () => () => {} };
  const submits: string[] = [];
  const onCancel = vi.fn();
  const ownership = { modal: false };

  function OwnershipProbe(): null {
    ownership.modal = useIsModalOverlayActive();
    return null;
  }

  function Harness(): React.ReactElement | null {
    const elicitation = useTuiElicitation(session);
    const recorded = useMemo(
      () => ({
        ...elicitation,
        submitPending: (expected: PendingElicitation, value: string) => {
          submits.push(value);
          return elicitation.submitPending(expected, value);
        },
      }),
      [elicitation],
    );
    return <ElicitationRequestOverlay elicitation={recorded} />;
  }

  root.render(
    <AppStateProvider initialState={getDefaultAppState()}>
      <KeybindingSetup configStore={new ConfigStore({ env: {} })}>
        <CancelRequestHandler
          setToolUseConfirmQueue={() => {}}
          onCancel={onCancel}
          onAgentsKilled={() => {}}
          isMessageSelectorVisible={false}
          screen={"prompt" as never}
          canCancelActiveTurn={true}
        />
        <OwnershipProbe />
        <Harness />
      </KeybindingSetup>
    </AppStateProvider>,
  );
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
    onCancel,
    text: () => collectText(rootNode()),
    send: async (sequence) => {
      stdin.write(sequence);
      // A lone ESC is held briefly in case it starts a key sequence.
      await sleep(sequence === "\u001b" ? 90 : 30);
    },
    // Gives the overlay time to take Escape from the turn cancel. It does not
    // assert, so a missing handover fails on the answer, not here.
    waitForOwnership: async () => {
      const startedAt = Date.now();
      while (!ownership.modal && Date.now() - startedAt < 500) await sleep(10);
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

function optionsQuestion(): RequestUserInputEvent {
  return {
    turnId: "turn-1",
    requestId: "options-request",
    callId: "options-call",
    questions: [{
      id: "color",
      header: "Color",
      question: "Pick a color",
      options: [
        { label: "Teal", description: "Cool" },
        { label: "Gold", description: "Warm" },
      ],
    }],
  };
}

function mcpNameRequest(requestId = "name-request"): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "profile",
    requestId,
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

function mcpUrlRequest(): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "profile",
    requestId: "url-request",
    request: {
      mode: "url",
      message: "Open the sign-in page",
      url: "https://127.0.0.1/sign-in",
      elicitationId: "url-elicitation",
    },
  } as McpElicitationRequestEvent;
}

/** A two-field form: a field change, then a validation error on `age`. */
function mcpProfileRequest(requestId = "profile-request"): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "profile",
    requestId,
    request: {
      mode: "form",
      message: "Create a profile",
      requestedSchema: {
        type: "object",
        required: ["name", "age"],
        properties: {
          name: { type: "string", description: "Your name" },
          age: { type: "integer", description: "Your age" },
        },
      },
    },
  };
}

function twoQuestions(): RequestUserInputEvent {
  return {
    turnId: "turn-1",
    requestId: "two-request",
    callId: "two-call",
    questions: [
      { id: "first", header: "First", question: "First question" },
      { id: "second", header: "Second", question: "Second question" },
    ],
  };
}

function mcpOptionalFieldsRequest(): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "profile",
    requestId: "optional-request",
    request: {
      mode: "form",
      message: "Report details",
      requestedSchema: {
        type: "object",
        properties: {
          first: { type: "string", description: "First optional field" },
          second: { type: "string", description: "Second optional field" },
          third: { type: "string", description: "Third optional field" },
        },
      },
    },
  };
}

describe("elicitation request overlay input", () => {
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

  test("Escape during a running turn answers skip instead of cancelling the turn", async () => {
    const overlay = await mountOverlay();
    const response = overlay.session.services.requestUserInputResolver!.request(
      freeTextQuestion(),
    );
    await waitFor(() => expect(overlay.text()).toContain("esc skip"));
    await overlay.waitForOwnership();

    await overlay.send("draft");
    await overlay.send("\u001b");

    expect(overlay.onCancel).not.toHaveBeenCalled();
    await expect(response).resolves.toEqual({
      answers: { details: { answers: ["skip"] } },
    });
    expect(overlay.submits).toEqual(["skip"]);
  });

  test("Escape on an options question during a running turn answers skip", async () => {
    const overlay = await mountOverlay();
    const response = overlay.session.services.requestUserInputResolver!.request(
      optionsQuestion(),
    );
    await waitFor(() => expect(overlay.text()).toContain("Pick a color"));
    await overlay.waitForOwnership();

    await overlay.send("\u001b");

    expect(overlay.onCancel).not.toHaveBeenCalled();
    await expect(response).resolves.toEqual({
      answers: { color: { answers: ["skip"] } },
    });
  });

  test("Ctrl+C during a running turn answers like Escape", async () => {
    const overlay = await mountOverlay();
    const question = overlay.session.services.requestUserInputResolver!.request(
      freeTextQuestion(),
    );
    await waitFor(() => expect(overlay.text()).toContain("Describe the change"));
    await overlay.waitForOwnership();
    await overlay.send("\u0003");
    expect(overlay.onCancel).not.toHaveBeenCalled();
    await expect(question).resolves.toEqual({
      answers: { details: { answers: ["skip"] } },
    });

    const form = overlay.session.services.mcpElicitationResolver!.request(
      mcpNameRequest(),
    );
    await waitFor(() => expect(overlay.text()).toContain("Who is asking (name)"));
    await overlay.waitForOwnership();
    await overlay.send("\u0003");
    expect(overlay.onCancel).not.toHaveBeenCalled();
    await expect(form).resolves.toEqual({ action: "cancel" });
  });

  test("an MCP form string field takes typed text, and Escape cancels during a turn", async () => {
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

    const cancelled = overlay.session.services.mcpElicitationResolver!.request(
      mcpNameRequest("name-request-2"),
    );
    await waitFor(() => expect(overlay.text()).toContain("esc cancel"));
    await overlay.waitForOwnership();
    await overlay.send("\u001b");
    expect(overlay.onCancel).not.toHaveBeenCalled();
    await expect(cancelled).resolves.toEqual({ action: "cancel" });
    expect(overlay.submits).toEqual(["Ada", "cancel"]);
  });

  test("two Enters in one read answer the shown form and leave a queued URL confirmation waiting", async () => {
    const overlay = await mountOverlay();
    const form = overlay.session.services.mcpElicitationResolver!.request(
      mcpNameRequest(),
    );
    const url = track(
      overlay.session.services.mcpElicitationResolver!.request(mcpUrlRequest()),
    );
    await waitFor(() => expect(overlay.text()).toContain("Who is asking (name)"));

    await overlay.send("Ada\r\r");

    await expect(form).resolves.toEqual({
      action: "accept",
      content: { name: "Ada" },
    });
    await waitFor(() => expect(overlay.text()).toContain("Open the sign-in page"));
    await sleep(50);
    expect(url.settled()).toBe(false);
    expect(overlay.submits).toEqual(["Ada"]);

    // The confirmation is answered only by an Enter pressed after it shows.
    await overlay.send("\r");
    await waitFor(() => expect(url.value()).toEqual({ action: "accept" }));
    expect(overlay.submits).toEqual(["Ada", ""]);
  });

  test("repeated Enter in one read skips only the shown optional field", async () => {
    const overlay = await mountOverlay();
    const form = overlay.session.services.mcpElicitationResolver!.request(
      mcpOptionalFieldsRequest(),
    );
    await waitFor(() => expect(overlay.text()).toContain("Report details (first)"));

    await overlay.send("\r\r\r");

    await waitFor(() => expect(overlay.text()).toContain("Report details (second)"));
    await sleep(50);
    expect(overlay.text()).toContain("Report details (second)");
    expect(overlay.submits).toEqual([""]);

    await overlay.send("kept\r");
    await waitFor(() => expect(overlay.text()).toContain("Report details (third)"));
    await overlay.send("\r");
    await expect(form).resolves.toEqual({
      action: "accept",
      content: { second: "kept" },
    });
  });

  test("a form withdrawn after a field change and a validation error leaves the screen", async () => {
    const overlay = await mountOverlay();
    const withdraw = new AbortController();
    const form = overlay.session.services.mcpElicitationResolver!.request(
      mcpProfileRequest(),
      withdraw.signal,
    );
    await waitFor(() => expect(overlay.text()).toContain("Create a profile (name)"));
    await overlay.send("Ada\r");
    await waitFor(() => expect(overlay.text()).toContain("Create a profile (age)"));
    await overlay.send("abc\r");
    await waitFor(() =>
      expect(overlay.text()).toContain("Invalid input: age must be a number"),
    );

    withdraw.abort("withdrawn");

    await expect(form).resolves.toBeNull();
    await waitFor(() => expect(overlay.text()).not.toContain("Create a profile"));
    expect(overlay.submits).toEqual(["Ada", "abc"]);

    // The next request shows and takes its answer as usual.
    const next = overlay.session.services.mcpElicitationResolver!.request(
      mcpNameRequest("after-withdrawal"),
    );
    await waitFor(() => expect(overlay.text()).toContain("Who is asking (name)"));
    await overlay.send("Bo\r");
    await expect(next).resolves.toEqual({
      action: "accept",
      content: { name: "Bo" },
    });
  });
});

describe("elicitation controller", () => {
  test("submitPending answers only the request it was bound to", async () => {
    const session: TestSession = { services: {}, subscribeToEvents: () => () => {} };
    let pending: PendingElicitation | null = null;
    const controller = installElicitationResolvers(session as never, (next) => {
      pending = next;
    });
    try {
      const first = session.services.mcpElicitationResolver!.request(mcpNameRequest());
      const second = track(
        session.services.mcpElicitationResolver!.request(mcpUrlRequest()),
      );
      const shown = pending as unknown as PendingElicitation;
      expect(controller.submitPending(shown, "Ada")).toBe(true);
      await expect(first).resolves.toEqual({ action: "accept", content: { name: "Ada" } });

      // A late answer for the first request must not reach the second.
      expect(controller.submitPending(shown, "")).toBe(false);
      await sleep(10);
      expect(second.settled()).toBe(false);
      expect((pending as unknown as PendingElicitation).kind).toBe("mcp-url");
    } finally {
      controller.cleanup();
    }
  });

  /** A controller and a reader for the request it shows. */
  function installController(): {
    readonly session: TestSession;
    readonly controller: ReturnType<typeof installElicitationResolvers>;
    readonly shown: () => PendingElicitation | null;
  } {
    const session: TestSession = { services: {}, subscribeToEvents: () => () => {} };
    const state: { pending: PendingElicitation | null } = { pending: null };
    const controller = installElicitationResolvers(session as never, (next) => {
      state.pending = next;
    });
    return { session, controller, shown: () => state.pending };
  }

  test("a withdrawal after a field change removes the form and shows the next request", async () => {
    const { session, controller, shown } = installController();
    try {
      const withdraw = new AbortController();
      const form = session.services.mcpElicitationResolver!.request(
        mcpProfileRequest(),
        withdraw.signal,
      );
      const next = track(
        session.services.mcpElicitationResolver!.request(mcpNameRequest("queued")),
      );
      expect(controller.submitPending(shown()!, "Ada")).toBe(true);
      expect(shown()).toMatchObject({ kind: "mcp-form", index: 1 });

      withdraw.abort("withdrawn");

      await expect(form).resolves.toBeNull();
      expect(shown()).toMatchObject({
        kind: "mcp-form",
        index: 0,
        request: { requestId: "queued" },
      });
      await sleep(10);
      expect(next.settled()).toBe(false);
    } finally {
      controller.cleanup();
    }
  });

  test("a withdrawal after a validation error removes the form", async () => {
    const { session, controller, shown } = installController();
    try {
      const withdraw = new AbortController();
      const form = session.services.mcpElicitationResolver!.request(
        mcpProfileRequest(),
        withdraw.signal,
      );
      expect(controller.submitPending(shown()!, "Ada")).toBe(true);
      expect(controller.submitPending(shown()!, "abc")).toBe(true);
      expect(shown()).toMatchObject({
        kind: "mcp-form",
        index: 1,
        error: "age must be a number",
      });

      withdraw.abort("withdrawn");

      await expect(form).resolves.toBeNull();
      expect(shown()).toBeNull();
    } finally {
      controller.cleanup();
    }
  });

  test("a withdrawal after the first answer removes a multi-question request", async () => {
    const { session, controller, shown } = installController();
    try {
      const withdraw = new AbortController();
      const question = session.services.requestUserInputResolver!.request(
        twoQuestions(),
        withdraw.signal,
      );
      expect(controller.submitPending(shown()!, "first answer")).toBe(true);
      expect(shown()).toMatchObject({ kind: "user", index: 1 });

      withdraw.abort("withdrawn");

      await expect(question).resolves.toBeNull();
      expect(shown()).toBeNull();
    } finally {
      controller.cleanup();
    }
  });

  test("a queued request withdrawn before it shows leaves the shown request alone", async () => {
    const { session, controller, shown } = installController();
    try {
      const first = track(
        session.services.mcpElicitationResolver!.request(mcpProfileRequest()),
      );
      const withdraw = new AbortController();
      const queued = session.services.mcpElicitationResolver!.request(
        mcpNameRequest("queued"),
        withdraw.signal,
      );
      expect(controller.submitPending(shown()!, "Ada")).toBe(true);
      const showing = shown();

      withdraw.abort("withdrawn");

      await expect(queued).resolves.toBeNull();
      expect(shown()).toBe(showing);
      expect(controller.submitPending(shown()!, "36")).toBe(true);
      await waitFor(() =>
        expect(first.value()).toEqual({
          action: "accept",
          content: { name: "Ada", age: 36 },
        }),
      );
      expect(shown()).toBeNull();
    } finally {
      controller.cleanup();
    }
  });
});
