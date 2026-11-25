import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { canonicalRolloutHoldsNoInput } from "../../src/session/rollout-input.js";

const MAX_UNTOUCHED_ROLLOUT_BYTES = 1024 * 1024;

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function rolloutPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-rollout-input-"));
  cleanups.push(dir);
  return join(dir, "rollout.jsonl");
}

function writeRollout(lines: readonly string[]): string {
  const path = rolloutPath();
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  return path;
}

function sessionMeta(): string {
  return JSON.stringify({
    type: "session_meta",
    payload: { sessionId: "conv-a", cwd: "/work" },
  });
}

function event(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event_msg",
    payload: { id: "e-1", msg: { type, ...extra } },
  });
}

describe("canonicalRolloutHoldsNoInput", () => {
  test("only a header and bookkeeping events are an unused TUI prewarm", () => {
    expect(canonicalRolloutHoldsNoInput(writeRollout([]))).toBe(true);
    expect(canonicalRolloutHoldsNoInput(writeRollout([sessionMeta()]))).toBe(true);
    expect(
      canonicalRolloutHoldsNoInput(
        writeRollout([
          sessionMeta(),
          "",
          event("session_configured"),
          event("session_usage"),
          event("run_terminal"),
        ]),
      ),
    ).toBe(true);
  });

  test("a turn, a submission or a user message means someone used the session", () => {
    for (const type of ["turn_started", "message_submission", "user_message"]) {
      expect(canonicalRolloutHoldsNoInput(writeRollout([sessionMeta(), event(type)]))).toBe(
        false,
      );
    }
  });

  test("anything uncertain counts as input so --continue cannot skip a used thread", () => {
    const path = rolloutPath();
    expect(canonicalRolloutHoldsNoInput(path)).toBe(false);

    mkdirSync(path);
    expect(canonicalRolloutHoldsNoInput(path)).toBe(false);

    const target = writeRollout([sessionMeta(), event("session_configured")]);
    const link = join(target, "..", "alias.jsonl");
    symlinkSync(target, link);
    expect(canonicalRolloutHoldsNoInput(link)).toBe(false);

    const oversized = rolloutPath();
    writeFileSync(oversized, Buffer.alloc(MAX_UNTOUCHED_ROLLOUT_BYTES + 1, 0x20));
    expect(canonicalRolloutHoldsNoInput(oversized)).toBe(false);

    expect(canonicalRolloutHoldsNoInput(writeRollout([sessionMeta(), "{not json"]))).toBe(
      false,
    );
    expect(canonicalRolloutHoldsNoInput(writeRollout(["[1]"]))).toBe(false);
    expect(canonicalRolloutHoldsNoInput(writeRollout(["null"]))).toBe(false);
    expect(canonicalRolloutHoldsNoInput(writeRollout(['"session_meta"']))).toBe(false);
    expect(
      canonicalRolloutHoldsNoInput(
        writeRollout([
          sessionMeta(),
          JSON.stringify({
            type: "response_item",
            payload: { role: "user", content: "fix the tests" },
          }),
        ]),
      ),
    ).toBe(false);
    expect(
      canonicalRolloutHoldsNoInput(
        writeRollout([JSON.stringify({ type: "event_msg", payload: "bookkeeping" })]),
      ),
    ).toBe(false);
    expect(
      canonicalRolloutHoldsNoInput(
        writeRollout([JSON.stringify({ type: "event_msg", payload: { msg: "session_usage" } })]),
      ),
    ).toBe(false);
    expect(
      canonicalRolloutHoldsNoInput(
        writeRollout([
          JSON.stringify({ type: "event_msg", payload: { msg: { type: 1 } } }),
        ]),
      ),
    ).toBe(false);
  });
});
