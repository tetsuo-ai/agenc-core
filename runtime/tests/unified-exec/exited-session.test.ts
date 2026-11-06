/**
 * Polls and writes to a session that already exited.
 *
 * tb4h music-harmony__w74KdQJ (released 0.19.30, 2026-11-06): `pip install
 * music21` yielded as session 28; one poll returned its final output and
 * `[exit 0]`; the next three polls got `Unknown process id 28`, so the model
 * kept polling, the repeat guard refused the poll, and a later stale poll
 * ended the turn with 38 minutes left. A poll or write of an exited session
 * now gets its exit status and final output in plain words, the same text
 * every time.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import {
  exitedSessionMessage,
  finalOutputTail,
} from "../../src/unified-exec/exited-sessions.js";

describe("an exited session, through the process manager", () => {
  test("a poll after its final output gets the exit status and that output, identically every time", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
    try {
      const started = await manager.execCommand({
        cmd: "node -e \"setTimeout(()=>console.log('music21 10.5.2'), 350)\"",
        yield_time_ms: 250,
      });
      const id = started.process_id!;
      expect(id).toEqual(expect.any(Number));
      const final = await manager.writeStdin({ session_id: id, chars: "", yield_time_ms: 5_000 });
      expect(final.exitCode).toBe(0);
      expect(final.stdout).toContain("music21 10.5.2");
      expect(final.process_id).toBeUndefined();

      const answers: string[] = [];
      for (let poll = 0; poll < 3; poll += 1) {
        const error = await manager
          .writeStdin({ session_id: id, chars: "", yield_time_ms: 1_000, max_output_tokens: 100 })
          .then(() => undefined, (caught: unknown) => caught as { code?: string; message?: string });
        expect(error?.code).toBe("session_exited");
        answers.push(String(error?.message));
      }
      expect(answers[0]).toBe(
        `Session ${id} already exited with code 0. Nothing more will come from it, so there is ` +
          "nothing left to poll. Its final output, returned earlier, ended with:\nmusic21 10.5.2",
      );
      expect(new Set(answers).size).toBe(1);
    } finally {
      await manager.closeAll("test_cleanup");
    }
  }, 15_000);

  test("a write gets the exit status, says the input was not sent, and hands over the unread output", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
    try {
      const started = await manager.execCommand({
        cmd: "node -e \"setTimeout(()=>console.log('last line'), 300)\"",
        tty: true,
        yield_time_ms: 250,
      });
      const id = started.process_id!;
      await delay(1_200);
      const write = await manager
        .writeStdin({ session_id: id, chars: "y\n", yield_time_ms: 1_000 })
        .then(() => undefined, (caught: unknown) => caught as { code?: string; message?: string });
      expect(write?.code).toBe("session_exited");
      expect(write?.message).toContain(
        `Session ${id} already exited with code 0, so the input was not sent.`,
      );
      expect(write?.message).toContain("Its remaining output:\n");
      expect(write?.message).toContain("last line");

      // The output now counts as returned; a poll says so.
      const poll = await manager
        .writeStdin({ session_id: id, chars: "", yield_time_ms: 1_000 })
        .then(() => undefined, (caught: unknown) => caught as { code?: string; message?: string });
      expect(poll?.code).toBe("session_exited");
      expect(poll?.message).toContain("Its final output, returned earlier, ended with:\n");
      expect(poll?.message).toContain("last line");
    } finally {
      await manager.closeAll("test_cleanup");
    }
  }, 15_000);

  test("another owner, and an id that never existed, still get Unknown process id", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
    try {
      const started = await manager.execCommand({
        cmd: "node -e \"setTimeout(()=>console.log('mine'), 300)\"",
        yield_time_ms: 250,
        ownerId: "conversation-a",
      });
      const id = started.process_id!;
      await manager.writeStdin({ session_id: id, chars: "", yield_time_ms: 5_000, ownerId: "conversation-a" });
      await expect(
        manager.writeStdin({ session_id: id, chars: "", ownerId: "conversation-b" }),
      ).rejects.toMatchObject({ code: "unknown_process" });
      await expect(
        manager.writeStdin({ session_id: id, chars: "", ownerId: "conversation-a" }),
      ).rejects.toMatchObject({ code: "session_exited" });
      await expect(
        manager.writeStdin({ session_id: 99_999, chars: "" }),
      ).rejects.toMatchObject({ code: "unknown_process", message: "Unknown process id 99999" });
    } finally {
      await manager.closeAll("test_cleanup");
    }
  }, 15_000);
});

describe("exitedSessionMessage", () => {
  test("names a signal stop, an empty output and an output that was never kept", () => {
    expect(exitedSessionMessage(3, { exitCode: null, signal: "SIGTERM", finalOutput: "" }, "poll")).toBe(
      "Session 3 was already stopped by signal SIGTERM. Nothing more will come from it, so there " +
        "is nothing left to poll. Its final output, returned earlier, was empty.",
    );
    expect(exitedSessionMessage(4, { exitCode: 1 }, "write")).toBe(
      "Session 4 already exited with code 1, so the input was not sent. Start a new command if you " +
        "need to run it again. Its output was not kept.",
    );
  });

  test("the remembered tail is the last 20 lines, at most 2,000 characters, without terminal codes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `\u001b[32mline ${i}\u001b[0m`).join("\n");
    expect(finalOutputTail(`${lines}\n\n`)).toBe(
      Array.from({ length: 20 }, (_, i) => `line ${i + 10}`).join("\n"),
    );
    expect(finalOutputTail("x".repeat(5_000))).toHaveLength(2_000);
  });
});
