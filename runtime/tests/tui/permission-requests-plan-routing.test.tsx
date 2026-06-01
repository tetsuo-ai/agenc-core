import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, test } from "vitest";

import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";
import { APPROVED } from "../../src/permissions/review-decision.js";
import { createRoot } from "../../src/tui/ink.js";
import type { PendingRequest } from "../../src/tui/permission-requests.js";
import { AgenCPermissionOverlay } from "../../src/tui/permission-requests.js";
import {
  AppStateProvider,
  getDefaultAppState,
} from "../../src/tui/state/AppState.js";
import {
  clearPlanApprovalChoicesForTest,
  takePlanApprovalChoice,
} from "../../src/tui/plan-approval-choice.js";

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
  readonly output: () => string;
} {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 120;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 40;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  return { stdin, stdout, output: () => output };
}

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null;
  let cursor = 0;
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) break;
    const contentStart = start + SYNC_START.length;
    const end = output.indexOf(SYNC_END, contentStart);
    if (end === -1) break;
    const frame = output.slice(contentStart, end);
    if (frame.trim().length > 0) lastFrame = frame;
    cursor = end + SYNC_END.length;
  }
  return lastFrame ?? output;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createExitPlanRequest(
  resolve: (decision: ReviewDecision) => void,
): PendingRequest {
  const input = { plan: "# Plan\n\nship the feature" };
  return {
    id: "call-exit-plan",
    ctx: {
      callId: "call-exit-plan",
      toolName: "ExitPlanMode",
      turnId: "turn-1",
      planContent: "# Plan\n\nship the feature",
      planFilePath: "/plans/quiet-harbor.md",
      invocation: {
        payload: { kind: "function", arguments: JSON.stringify(input) },
      },
    } as unknown as ApprovalCtx,
    input,
    description: "Permission required to use ExitPlanMode",
    resolve,
  };
}

describe("permission-requests routes ExitPlanMode to PlanApprovalOverlay (contract #7)", () => {
  afterEach(() => clearPlanApprovalChoicesForTest());

  test("renders the plan overlay (not ApprovalCard) and auto-accept sets the choice + resolves APPROVED", async () => {
    const resolved: ReviewDecision[] = [];
    const request = createExitPlanRequest((decision) => resolved.push(decision));
    // The ApprovalCard would have rendered a fake `req 0x…` / `$ <command>`
    // bash status. The plan overlay must render instead, even though
    // ExitPlanMode is NOT in this `tools` list (resolve directly).
    const tools = [{ name: "Bash" }];

    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          <AgenCPermissionOverlay request={request} tools={tools} />
        </AppStateProvider>,
      );
      await sleep();

      const frame = stripAnsi(extractLastFrame(output()));
      const compact = frame.replace(/\s+/gu, "");
      // PlanApprovalOverlay markers.
      expect(compact).toContain("planreadyforreview");
      expect(compact).toContain("yes,andauto-acceptedits");
      // ApprovalCard markers must be absent.
      expect(compact).not.toContain("needsapproval");
      expect(compact).not.toContain("tool·");

      // Auto-accept (option 1).
      stdin.write("1");
      await sleep();

      expect(resolved).toEqual([APPROVED]);
      expect(takePlanApprovalChoice("call-exit-plan")).toEqual({
        action: "approve",
        mode: "acceptEdits",
        applyAllowedPrompts: true,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("keep-planning (option 3) sets a revise choice and resolves APPROVED", async () => {
    const resolved: ReviewDecision[] = [];
    const request = createExitPlanRequest((decision) => resolved.push(decision));
    const tools = [{ name: "Bash" }];
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          <AgenCPermissionOverlay request={request} tools={tools} />
        </AppStateProvider>,
      );
      await sleep();
      stdin.write("3");
      await sleep();
      expect(resolved).toEqual([APPROVED]);
      expect(takePlanApprovalChoice("call-exit-plan")).toEqual({
        action: "revise",
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
