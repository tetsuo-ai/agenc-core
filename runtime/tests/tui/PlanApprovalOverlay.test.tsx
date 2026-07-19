import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../../src/tui/ink.js";
import { PlanApprovalOverlay } from "../../src/tui/components/PlanApprovalOverlay.js";
import {
  AppStateProvider,
  getDefaultAppState,
} from "../../src/tui/state/AppState.js";

function Wrapped(props: React.ComponentProps<typeof PlanApprovalOverlay>) {
  return (
    <AppStateProvider initialState={getDefaultAppState()}>
      <PlanApprovalOverlay {...props} />
    </AppStateProvider>
  );
}

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
    if (frame.trim().length > 0) {
      lastFrame = frame;
    }
    cursor = end + SYNC_END.length;
  }
  return lastFrame ?? output;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const PLAN = "# Migration plan\n\n1. add the column\n2. backfill rows";
const PLAN_PATH = "/home/dev/.agenc/plans/quiet-harbor.md";

describe("PlanApprovalOverlay (contract #6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders the header, the plan markdown, and the three exact labels; writes default frame", async () => {
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    try {
      root.render(
        <Wrapped
          planContent={PLAN}
          planFilePath={PLAN_PATH}
          onApprove={() => {}}
          onKeepPlanning={() => {}}
        />,
      );
      await sleep();

      const frame = stripAnsi(extractLastFrame(output()));
      const compact = frame.replace(/\s+/gu, "");

      expect(compact).toContain("planreadyforreview");
      expect(compact).toContain("Migrationplan");
      expect(compact).toContain("addthecolumn");
      expect(compact).toContain("backfillrows");
      // The three EXACT labels (whitespace-collapsed to survive line padding).
      expect(compact).toContain("yes,andauto-acceptedits");
      expect(compact).toContain("yes,andmanuallyapproveedits");
      expect(compact).toContain("no,keepplanning");
      expect(compact).toContain("wouldyouliketoproceed?");

      // Persist the default-state frame for the contract deliverable.
      writeFileSync("/tmp/plan-overlay-render.txt", frame, "utf8");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test('"1" approves acceptEdits, "2" approves default', async () => {
    const approvals: Array<"acceptEdits" | "default"> = [];
    const keeps: number[] = [];
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    try {
      root.render(
        <Wrapped
          planContent={PLAN}
          onApprove={(mode) => approvals.push(mode)}
          onKeepPlanning={() => keeps.push(1)}
        />,
      );
      await sleep();
      stdin.write("1");
      await sleep();
      expect(approvals).toEqual(["acceptEdits"]);

      stdin.write("2");
      await sleep();
      expect(approvals).toEqual(["acceptEdits", "default"]);
      expect(keeps).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test('"3" and Esc both keep planning', async () => {
    const approvals: string[] = [];
    const keeps: number[] = [];
    const render = (root: Awaited<ReturnType<typeof createRoot>>) =>
      root.render(
        <Wrapped
          planContent={PLAN}
          onApprove={(mode) => approvals.push(mode)}
          onKeepPlanning={() => keeps.push(1)}
        />,
      );

    // "3"
    {
      const { stdin, stdout } = createStreams();
      const root = await createRoot({
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      });
      try {
        render(root);
        await sleep();
        stdin.write("3");
        await sleep();
        expect(keeps).toEqual([1]);
        expect(approvals).toEqual([]);
      } finally {
        root.unmount();
        stdin.end();
        stdout.end();
        await sleep();
      }
    }

    // Esc
    {
      const { stdin, stdout } = createStreams();
      const root = await createRoot({
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      });
      try {
        render(root);
        await sleep();
        // A lone ESC byte is buffered as an incomplete escape sequence and only
        // flushed after the parser's NORMAL_TIMEOUT (25ms). Wait past it.
        stdin.write("\x1B");
        await sleep(120);
        expect(keeps).toEqual([1, 1]);
        expect(approvals).toEqual([]);
      } finally {
        root.unmount();
        stdin.end();
        stdout.end();
        await sleep();
      }
    }
  });

  test("down-arrow then Return selects option 2 (approve default)", async () => {
    const approvals: Array<"acceptEdits" | "default"> = [];
    const keeps: number[] = [];
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    try {
      root.render(
        <Wrapped
          planContent={PLAN}
          onApprove={(mode) => approvals.push(mode)}
          onKeepPlanning={() => keeps.push(1)}
        />,
      );
      await sleep();
      // selectedIndex starts at 0; one down → index 1 (manually approve = default).
      stdin.write("\x1B[B");
      await sleep();
      stdin.write("\r");
      await sleep();
      expect(approvals).toEqual(["default"]);
      expect(keeps).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
