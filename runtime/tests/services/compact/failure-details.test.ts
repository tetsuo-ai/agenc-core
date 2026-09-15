import { describe, expect, it } from "vitest";

import {
  CompactionTransactionFailureWithDetails,
  MAX_FAILURE_CAUSE_DEPTH,
  MAX_FAILURE_DETAIL_MESSAGE_LENGTH,
  compactionFailureDetails,
  describeFailureCause,
} from "../../../src/services/compact/failure-details.js";
import { CompactionTransactionError } from "../../../src/services/compact/transaction-types.js";

/** The flattened error chain behind an `auto_compact_failed` warning (#2499). */
describe("compactionFailureDetails", () => {
  const nodeError = (message: string, fields: Record<string, unknown>) =>
    Object.assign(new Error(message), fields);

  it("flattens the failure, its cause, and the root cause into scalar fields", () => {
    const root = nodeError("ENOSPC: no space left on device, write", {
      code: "ENOSPC",
      errno: -28,
      syscall: "write",
      path: "/tmp/rollout.jsonl",
    });
    const middle = new Error("journal append failed", { cause: root });
    const failure = new CompactionTransactionFailureWithDetails(
      "commit_failed",
      "durable compaction commit failed",
      { replacement_history_bytes: 4096, payload_bundle_count: 3 },
      { cause: new Error("adapter commit threw", { cause: middle }) },
    );

    expect(compactionFailureDetails(failure)).toEqual({
      replacement_history_bytes: 4096,
      payload_bundle_count: 3,
      error_name: "CompactionTransactionError",
      error_message: "durable compaction commit failed",
      error_reason: "commit_failed",
      cause_name: "Error",
      cause_message: "adapter commit threw",
      root_cause_name: "Error",
      root_cause_message: "ENOSPC: no space left on device, write",
      root_cause_code: "ENOSPC",
      root_cause_errno: -28,
      root_cause_syscall: "write",
      root_cause_path: "/tmp/rollout.jsonl",
    });
  });

  it("describes a plain error, a non-error, and an aggregate without payload bytes", () => {
    expect(compactionFailureDetails(new CompactionTransactionError("no_shrink", "saves 3 tokens")))
      .toEqual({
        error_name: "CompactionTransactionError",
        error_message: "saves 3 tokens",
        error_reason: "no_shrink",
      });
    expect(compactionFailureDetails("boom")).toEqual({ error_message: "boom" });
    const aggregate = new AggregateError([new Error("a"), new Error("b")], "two failures");
    expect(compactionFailureDetails(aggregate)).toMatchObject({
      error_name: "AggregateError",
      error_message: "two failures",
      error_errors: 2,
    });
  });

  describe("a cause chain that loops or runs deep", () => {
    // A regression spins synchronously, which no test timeout can interrupt, so each looping
    // `cause` below is a getter that throws once it has been read more often than a bounded walk
    // ever needs: the test then fails fast instead of hanging the worker.
    const loopingCause = (error: Error, next: () => unknown): Error => {
      let reads = 0;
      Object.defineProperty(error, "cause", {
        configurable: true,
        get() {
          reads += 1;
          if (reads > 50) {
            throw new Error(`cause of "${error.message}" read ${reads} times: the walk has no bound`);
          }
          return next();
        },
      });
      return error;
    };

    it("stops at an error that is its own cause", () => {
      const failure = new Error("durable compaction commit failed");
      loopingCause(failure, () => failure);
      expect(compactionFailureDetails(failure)).toEqual({
        error_name: "Error",
        error_message: "durable compaction commit failed",
        cause_chain_stopped: "cycle",
      });
    });

    it("stops when two errors name each other, keeping both descriptions", () => {
      const failure = new Error("adapter commit threw");
      const wrapper = new Error("journal append failed");
      loopingCause(failure, () => wrapper);
      loopingCause(wrapper, () => failure);
      expect(compactionFailureDetails(failure)).toEqual({
        error_name: "Error",
        error_message: "adapter commit threw",
        cause_name: "Error",
        cause_message: "journal append failed",
        cause_chain_stopped: "cycle",
      });
    });

    it("keeps the root facts of a loop that starts below the first cause", () => {
      const failure = new Error("durable compaction commit failed");
      const middle = new Error("journal append failed");
      const disk = nodeError("ENOSPC: no space left on device, write", { code: "ENOSPC" });
      loopingCause(failure, () => middle);
      loopingCause(middle, () => disk);
      loopingCause(disk, () => middle);
      expect(compactionFailureDetails(failure)).toMatchObject({
        cause_message: "journal append failed",
        root_cause_message: "ENOSPC: no space left on device, write",
        root_cause_code: "ENOSPC",
        cause_chain_stopped: "cycle",
      });
    });

    it("stops a very deep chain at the depth bound", () => {
      let chain = new Error("link 100");
      for (let link = 99; link >= 0; link -= 1) chain = new Error(`link ${link}`, { cause: chain });
      expect(compactionFailureDetails(chain)).toMatchObject({
        error_message: "link 0",
        cause_message: "link 1",
        root_cause_message: `link ${1 + MAX_FAILURE_CAUSE_DEPTH}`,
        cause_chain_stopped: "depth_limit",
      });
    });

    it("reports no stop for an ordinary chain", () => {
      const chain = new Error("outer", { cause: new Error("middle", { cause: new Error("root") }) });
      const details = compactionFailureDetails(chain);
      expect(details).toMatchObject({ cause_message: "middle", root_cause_message: "root" });
      expect(details).not.toHaveProperty("cause_chain_stopped");
    });
  });

  it("truncates long messages", () => {
    const details = compactionFailureDetails(new Error("x".repeat(10_000)));
    expect(details.error_message).toHaveLength(MAX_FAILURE_DETAIL_MESSAGE_LENGTH);
    expect(String(details.error_message).endsWith("…")).toBe(true);
  });

  it("names the cause with its Node error facts on one line", () => {
    expect(describeFailureCause(nodeError("EACCES: permission denied, open", {
      code: "EACCES",
      syscall: "open",
      path: "/app/x",
    }))).toBe("Error: EACCES: permission denied, open (code=EACCES, syscall=open, path=/app/x)");
    expect(describeFailureCause(new RangeError("too big"))).toBe("RangeError: too big");
    expect(describeFailureCause(42)).toBe("42");
  });
});
