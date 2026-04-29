import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  clearExitPlanModeApprovalsForTest,
  consumeExitPlanModeApproval,
} from "../../planning/exit-plan-approval.js";
import StdinContext from "../ink/components/StdinContext.js";
import type { DOMElement } from "../ink/dom.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import { PlanApprovalOverlay } from "./PlanApprovalOverlay.js";
import type { ApprovalDecision } from "./ApprovalOverlay.js";

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
        parts.push((child as unknown as { nodeValue: string }).nodeValue ?? "");
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

function makeKeyEvent(opts: { name?: string; sequence?: string }): InputEvent {
  const parsedKey = {
    kind: "key" as const,
    name: opts.name ?? "",
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
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

describe("PlanApprovalOverlay", () => {
  afterEach(() => {
    clearExitPlanModeApprovalsForTest();
  });

  test("renders plan content and requested prompt permissions", async () => {
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const { getText, unmount } = await mount(
      <PlanApprovalOverlay
        requestId="exit-1"
        input={{
          plan: "# Plan\n\nImplement parity.",
          planFilePath: "/tmp/agenc/plans/plan.md",
          allowedPrompts: [{ tool: "Bash", prompt: "npm test" }],
        }}
        workspacePath="/workspace"
        turnId="turn-1"
        onResolve={onResolve}
        abortSignal={new AbortController().signal}
      />,
    );

    const text = getText();
    expect(text).toContain("Plan approval needed");
    expect(text).toContain("Implement parity.");
    expect(text).toContain("Requested prompt permissions");
    expect(text).toContain("Bash(npm test)");
    unmount();
  });

  test("A approves with requested prompts through the ExitPlanMode side channel", async () => {
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const { emitter, unmount } = await mount(
      <PlanApprovalOverlay
        requestId="exit-side-channel"
        input={{
          plan: "# Plan\n\nRun tests.",
          planFilePath: "/tmp/agenc/plans/plan.md",
          allowedPrompts: [{ tool: "Bash", prompt: "npm test" }],
        }}
        workspacePath="/workspace"
        turnId="turn-1"
        onResolve={onResolve}
        abortSignal={new AbortController().signal}
      />,
    );

    emitter.emit("input", makeKeyEvent({ sequence: "a" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledWith({ behavior: "allow" });
    expect(
      consumeExitPlanModeApproval({ __callId: "exit-side-channel" }),
    ).toMatchObject({
      action: "approve",
      mode: "acceptEdits",
      applyAllowedPrompts: true,
      allowedPrompts: [{ tool: "Bash", prompt: "npm test" }],
    });
    unmount();
  });

  test("D records a revise decision instead of denying the tool before execution", async () => {
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const { emitter, unmount } = await mount(
      <PlanApprovalOverlay
        requestId="exit-revise"
        input={{ plan: "# Plan", planFilePath: "/tmp/agenc/plans/plan.md" }}
        workspacePath="/workspace"
        turnId="turn-1"
        onResolve={onResolve}
        abortSignal={new AbortController().signal}
      />,
    );

    emitter.emit("input", makeKeyEvent({ sequence: "d" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledWith({ behavior: "allow" });
    expect(consumeExitPlanModeApproval({ __callId: "exit-revise" }))
      .toMatchObject({ action: "revise" });
    unmount();
  });
});
