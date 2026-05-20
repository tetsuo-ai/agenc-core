import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";

import type { ReviewDecision } from "../permissions/review-decision.js";
import { APPROVED } from "../permissions/review-decision.js";
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
): PendingRequest {
  return {
    id: "request-mainnet-stake",
    ctx: {
      callId: "call-mainnet-stake",
      toolName: "Bash",
      turnId: "turn-1",
      invocation: {
        payload: {
          kind: "function",
          arguments: "{\"command\":\"agenc stake --mainnet --validator 42\"}",
        },
      },
    } as unknown as ApprovalCtx,
    input: {
      command: "agenc stake --mainnet --validator 42",
    },
    description: "Stake on mainnet",
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
});
