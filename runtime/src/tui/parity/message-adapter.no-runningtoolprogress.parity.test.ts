import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "../session-transcript.js";

const MESSAGE_ADAPTER_PATH = path.resolve(
  import.meta.dirname,
  "../session-transcript.ts",
);
const TUI_OPENCLAUDE_DIR = path.resolve(import.meta.dirname);
const RUNTIME_SRC_DIR = path.resolve(import.meta.dirname, "..", "..");

function readSource(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function listTsFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        out.push(full);
      }
    }
  }
  return out;
}

describe("R4 runningToolProgress / RunningToolProgress removal from session-transcript", () => {
  test("B4.4 RunningToolProgress interface is no longer exported from session-transcript.ts", () => {
    const source = readSource(MESSAGE_ADAPTER_PATH);
    expect(source).not.toMatch(/export\s+interface\s+RunningToolProgress\b/);
    expect(source).not.toMatch(/export\s+type\s+RunningToolProgress\b/);
  });

  test("B4.4 AdaptedTranscript no longer declares the runningToolProgress field", () => {
    const source = readSource(MESSAGE_ADAPTER_PATH);
    expect(source).not.toMatch(/runningToolProgress\s*:/);
  });

  test("B4.4 adaptTranscriptEvents no longer constructs a runningToolProgress Map or includes it in the return object", () => {
    const source = readSource(MESSAGE_ADAPTER_PATH);
    expect(source).not.toMatch(/runningToolProgress\s*=\s*new\s+Map\b/);
    expect(source).not.toMatch(/runningToolProgress\.set\b/);
    expect(source).not.toMatch(/runningToolProgress\.delete\b/);
    expect(source).not.toMatch(/runningToolProgress\.get\b/);
  });

  test("B4.4 the runtime adaptTranscriptEvents return value lacks the runningToolProgress key entirely", () => {
    const transcript = adaptTranscriptEvents([]);
    expect(transcript).not.toHaveProperty("runningToolProgress");
  });

  test("E4.2 no other file under runtime/src references runningToolProgress (consumers were limited to App.tsx + session-transcript; both now clean)", () => {
    const offenders: string[] = [];
    for (const file of listTsFilesRecursive(RUNTIME_SRC_DIR)) {
      // Ignore any still-quarantined donor boundary file; that code does not
      // reference our local AgenC field name and is out of this row's scope.
      if (file.includes(`${path.sep}agenc${path.sep}upstream${path.sep}`)) {
        continue;
      }
      // Tests are verifiers, not production consumers; they may refer to the
      // removed symbol in descriptions or assertion strings (e.g.,
      // session-transcript.test.ts asserts that a transcript no longer carries
      // the runningToolProgress field). Restrict the scan to production code.
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
        continue;
      }
      const text = readSource(file);
      if (/runningToolProgress\b/.test(text)) {
        offenders.push(path.relative(RUNTIME_SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("E4.4 RunningToolProgress symbol absence is asserted across the transcript test source", () => {
    const offenders: string[] = [];
    for (const file of listTsFilesRecursive(TUI_OPENCLAUDE_DIR)) {
      // Same exclusion as E4.2: tests are verifiers, not production consumers.
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
        continue;
      }
      const text = readSource(file);
      if (/RunningToolProgress(?!Indicator)/.test(text)) {
        offenders.push(path.relative(TUI_OPENCLAUDE_DIR, file));
      }
      if (/RunningToolProgressIndicator\b/.test(text)) {
        offenders.push(path.relative(TUI_OPENCLAUDE_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("E4.1 tool_progress events still arrive without throwing — adapter just stops capturing them; streamingToolUses is the new live-tool surface (populated by R5)", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "turn",
        msg: { type: "turn_started", payload: { turnId: "t1" } },
      },
      {
        id: "begin",
        msg: {
          type: "exec_command_begin",
          payload: { callId: "c1", toolName: "Bash" },
        },
      },
      {
        id: "p1",
        msg: {
          type: "tool_progress",
          payload: { callId: "c1", chunk: "ignored" },
        },
      },
    ]);
    expect(Array.isArray(transcript.streamingToolUses)).toBe(true);
    expect(transcript.streamingToolUses).toEqual([]);
  });
});
