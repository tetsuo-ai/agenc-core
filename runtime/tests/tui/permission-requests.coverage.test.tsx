import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";

import type { ReviewDecision } from "../permissions/review-decision.js";
import {
  APPROVED,
  APPROVED_FOR_SESSION,
  DENIED,
} from "../permissions/review-decision.js";
import type { ApprovalCtx } from "../tools/orchestrator.js";
import { createRoot } from "./ink.js";
import type { PendingRequest } from "./permission-requests.js";
import { AgenCPermissionOverlay } from "./permission-requests.js";

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
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  return {
    stdin,
    stdout,
    output: () => output,
  };
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
  await new Promise(resolve => setTimeout(resolve, ms));
}

function createPendingRequest(
  resolve: (decision: ReviewDecision) => void,
  options: {
    readonly id?: string;
    readonly input?: Record<string, unknown>;
    readonly description?: string;
  } = {},
): PendingRequest {
  const input = options.input ?? {
    command: "agenc stake --mainnet --validator 42",
  };
  const description = options.description ?? "Stake on mainnet";
  const id = options.id ?? "request-mainnet-stake";
  return {
    id,
    ctx: {
      callId: `call-${id}`,
      toolName: "Bash",
      turnId: "turn-1",
      invocation: {
        payload: {
          kind: "function",
          arguments: JSON.stringify(input),
        },
      },
    } as unknown as ApprovalCtx,
    input,
    description,
    resolve,
  };
}

describe("permission request overlay coverage", () => {
  test("requires the typed high-risk confirmation word before approving", async () => {
    const resolved: ReviewDecision[] = [];
    const request = createPendingRequest(decision => {
      resolved.push(decision);
    });
    const tools = [
      {
        name: "Bash",
        userFacingName: vi.fn(() => "Protocol staking"),
      },
    ];
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<AgenCPermissionOverlay request={request} tools={tools} />);
      await sleep();

      const initialFrame = stripAnsi(extractLastFrame(output()));
      const compactInitialFrame = initialFrame.replace(/\s+/gu, "");
      expect(compactInitialFrame).toContain("high-riskapproval");
      expect(compactInitialFrame).toContain("Protocolstaking");
      expect(compactInitialFrame).toContain("agencstake--mainnet--validator42");
      expect(compactInitialFrame).toContain("type'stake'toapprove");

      stdin.write("s");
      await sleep();
      stdin.write("x");
      await sleep();
      stdin.write("\x7F");
      await sleep();
      for (const character of "take") {
        stdin.write(character);
        await sleep();
      }

      const typedFrame = stripAnsi(extractLastFrame(output()));
      expect(typedFrame).toContain("stake");
      expect(resolved).toEqual([]);

      stdin.write("\r");
      await sleep();

      expect(tools[0]?.userFacingName).toHaveBeenCalledWith(request.input);
      expect(resolved).toEqual([APPROVED]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("clears typed high-risk confirmation when the pending request changes", async () => {
    const firstResolved: ReviewDecision[] = [];
    const secondResolved: ReviewDecision[] = [];
    const firstRequest = createPendingRequest(
      decision => {
        firstResolved.push(decision);
      },
      {
        id: "request-delete-first",
        input: { command: "rm -rf /tmp/agenc-first" },
        description: "Delete generated path",
      },
    );
    const secondRequest = createPendingRequest(
      decision => {
        secondResolved.push(decision);
      },
      {
        id: "request-delete-second",
        input: { command: "rm -rf /tmp/agenc-second" },
        description: "Delete another generated path",
      },
    );
    const tools = [{ name: "Bash" }];
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<AgenCPermissionOverlay request={firstRequest} tools={tools} />);
      await sleep();

      for (const character of "delete") {
        stdin.write(character);
        await sleep();
      }
      stdin.write("\r");
      await sleep();

      expect(firstResolved).toEqual([APPROVED]);
      expect(secondResolved).toEqual([]);

      root.render(<AgenCPermissionOverlay request={secondRequest} tools={tools} />);
      await sleep();

      expect(stripAnsi(extractLastFrame(output()))).toContain("second");
      expect(secondResolved).toEqual([]);

      stdin.write("\r");
      await sleep();

      expect(secondResolved).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("renders split command arguments as the destructive command", async () => {
    const resolved: ReviewDecision[] = [];
    const request = createPendingRequest(
      decision => {
        resolved.push(decision);
      },
      {
        id: "request-delete-path",
        input: { command: "rm", args: ["-rf", "/tmp/agenc-danger"] },
        description: "Delete generated path",
      },
    );
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<AgenCPermissionOverlay request={request} tools={[{ name: "Bash" }]} />);
      await sleep();

      const frame = stripAnsi(extractLastFrame(output()));
      const compactFrame = frame.replace(/\s+/gu, "");
      expect(compactFrame).toContain("high-riskapproval");
      expect(compactFrame).toContain("rm-rf/tmp/agenc-danger");
      expect(compactFrame).toContain("type'delete'toapprove");
      expect(resolved).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("handles numeric low-risk approval shortcuts", async () => {
    const sessionResolved: ReviewDecision[] = [];
    const denyResolved: ReviewDecision[] = [];
    const sessionRequest = createPendingRequest(
      decision => {
        sessionResolved.push(decision);
      },
      {
        id: "request-session-pwd",
        input: { command: "pwd" },
        description: "Print working directory",
      },
    );
    const denyRequest = createPendingRequest(
      decision => {
        denyResolved.push(decision);
      },
      {
        id: "request-deny-pwd",
        input: { command: "pwd" },
        description: "Print working directory",
      },
    );
    const tools = [{ name: "Bash" }];
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<AgenCPermissionOverlay request={sessionRequest} tools={tools} />);
      await sleep();

      expect(stripAnsi(extractLastFrame(output())).replace(/\s+/gu, "")).toContain(
        "approveforsession",
      );
      stdin.write("2");
      await sleep();

      expect(sessionResolved).toEqual([APPROVED_FOR_SESSION]);
      expect(denyResolved).toEqual([]);

      root.render(<AgenCPermissionOverlay request={denyRequest} tools={tools} />);
      await sleep();
      stdin.write("3");
      await sleep();

      expect(denyResolved).toEqual([DENIED]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("requires typed confirmation for equivalent forced recursive removal forms", async () => {
    const resolved: ReviewDecision[] = [];
    const request = createPendingRequest(
      decision => {
        resolved.push(decision);
      },
      {
        id: "request-delete-permuted",
        input: { command: "rm", args: ["-fr", "/tmp/agenc-danger"] },
        description: "Remove generated path",
      },
    );
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<AgenCPermissionOverlay request={request} tools={[{ name: "Bash" }]} />);
      await sleep();

      const frame = stripAnsi(extractLastFrame(output()));
      const compactFrame = frame.replace(/\s+/gu, "");
      expect(compactFrame).toContain("high-riskapproval");
      expect(compactFrame).toContain("rm-fr/tmp/agenc-danger");
      expect(compactFrame).toContain("type'delete'toapprove");
      expect(resolved).toEqual([]);

      stdin.write("\r");
      await sleep();

      expect(resolved).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
