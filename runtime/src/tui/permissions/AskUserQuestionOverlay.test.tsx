import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  clearAskUserQuestionResponsesForTest,
  createAskUserQuestionTool,
} from "../../tools/system/ask-user-question.js";
import StdinContext from "../ink/components/StdinContext.js";
import type { DOMElement } from "../ink/dom.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import { AskUserQuestionOverlay } from "./AskUserQuestionOverlay.js";
import type { AskUserQuestionDecision } from "./AskUserQuestionOverlay.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

function createStdinContext(emitter: EventEmitter) {
  return {
    stdin: process.stdin,
    setRawMode: () => undefined,
    isRawModeSupported: true,
    internal_exitOnCtrlC: true,
    internal_eventEmitter: emitter,
    internal_querier: null,
  } as React.ContextType<typeof StdinContext>;
}

function collectText(node: DOMElement): string {
  const parts: string[] = [];
  const walk = (n: DOMElement): void => {
    for (const child of n.childNodes) {
      if (child.nodeName === "#text") {
        parts.push(
          (child as unknown as { nodeValue: string }).nodeValue ?? "",
        );
      } else {
        walk(child as DOMElement);
      }
    }
  };
  walk(node);
  return parts.join("");
}

function getRoot(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) throw new Error("Ink instance root missing");
  return instance.rootNode;
}

function makeKeyEvent(opts: {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}): InputEvent {
  const parsedKey = {
    kind: "key" as const,
    name: opts.name ?? "",
    fn: false,
    ctrl: !!opts.ctrl,
    meta: !!opts.meta,
    shift: !!opts.shift,
    option: false,
    super: false,
    sequence: opts.sequence ?? "",
    raw: opts.sequence ?? "",
  };
  return new InputEvent(parsedKey as never);
}

async function mount(element: React.ReactElement): Promise<{
  readonly emitter: EventEmitter;
  readonly getText: () => string;
  readonly unmount: () => void;
}> {
  const { stdout, stdin } = createStreams();
  const emitter = new EventEmitter();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(
    <StdinContext.Provider value={createStdinContext(emitter)}>
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        {element}
      </KeybindingProvider>
    </StdinContext.Provider>,
  );
  await new Promise((r) => setTimeout(r, 30));
  return {
    emitter,
    getText: () => collectText(getRoot(stdout)),
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

const ASK_INPUT = {
  questions: [
    {
      header: "Approach",
      question: "Which planner interview behavior should AgenC use?",
      options: [
        {
          label: "OpenClaude picker (Recommended)",
          description: "Show multiple-choice questions in the TUI.",
          preview: "Render an interactive picker and return selected answers.",
        },
        {
          label: "No picker",
          description: "Keep plan mode approval-only.",
        },
      ],
    },
  ],
};

describe("AskUserQuestionOverlay", () => {
  afterEach(() => {
    clearAskUserQuestionResponsesForTest();
  });

  test("renders questions and records the selected answer before allowing", async () => {
    const onResolve = vi.fn<[AskUserQuestionDecision], void>();
    const { emitter, getText, unmount } = await mount(
      <AskUserQuestionOverlay
        requestId="ask-1"
        input={ASK_INPUT}
        onResolve={onResolve}
        abortSignal={new AbortController().signal}
      />,
    );

    expect(getText()).toContain("Answer questions");
    expect(getText()).toContain("Which planner interview behavior should AgenC use?");
    expect(getText()).toContain("OpenClaude picker (Recommended)");

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ sequence: "s" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]?.[0]).toEqual({ behavior: "allow" });

    const result = await createAskUserQuestionTool().execute({
      ...ASK_INPUT,
      __callId: "ask-1",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(
      '"Which planner interview behavior should AgenC use?"="OpenClaude picker (Recommended)"',
    );
    expect(result.content).toContain("selected preview");
    unmount();
  });

  test("renders model options that provide previews without descriptions", async () => {
    const onResolve = vi.fn<[AskUserQuestionDecision], void>();
    const { emitter, getText, unmount } = await mount(
      <AskUserQuestionOverlay
        requestId="ask-preview-fallback"
        input={{
          questions: [
            {
              header: "Priority",
              question: "Which milestone should come first?",
              options: [
                {
                  label: "M1 first",
                  preview: "Complete reader/lexer before parser.",
                },
                {
                  label: "M2 first",
                  preview: "Focus on AST and grammar early.",
                },
              ],
            },
          ],
        }}
        onResolve={onResolve}
        abortSignal={new AbortController().signal}
      />,
    );

    expect(getText()).toContain("Answer questions");
    expect(getText()).toContain("M1 first");
    expect(getText()).toContain("Complete reader/lexer before parser.");

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ sequence: "s" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledWith({ behavior: "allow" });
    unmount();
  });

  test("auto-denies unrecoverably invalid payloads instead of blocking input", async () => {
    const onResolve = vi.fn<[AskUserQuestionDecision], void>();
    const { getText, unmount } = await mount(
      <AskUserQuestionOverlay
        requestId="ask-invalid"
        input={{
          questions: [
            {
              header: "Bad",
              question: "Pick one",
              options: [{ preview: "Missing label" }, { label: "Valid" }],
            },
          ],
        }}
        onResolve={onResolve}
        abortSignal={new AbortController().signal}
      />,
    );

    expect(getText()).toContain("Invalid AskUserQuestion input");
    await new Promise((r) => setTimeout(r, 20));
    expect(onResolve).toHaveBeenCalledWith({ behavior: "deny" });
    unmount();
  });

  test("Escape denies the request", async () => {
    const onResolve = vi.fn<[AskUserQuestionDecision], void>();
    const { emitter, unmount } = await mount(
      <AskUserQuestionOverlay
        requestId="ask-escape"
        input={ASK_INPUT}
        onResolve={onResolve}
        abortSignal={new AbortController().signal}
      />,
    );

    emitter.emit("input", makeKeyEvent({ name: "escape" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]?.[0]).toEqual({ behavior: "deny" });
    unmount();
  });
});
