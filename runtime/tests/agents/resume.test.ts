import { describe, expect, it } from "vitest";
import { ResumeManager, RESUME_MAX_ATTEMPTS, decideResume } from "./resume.js";
import { FallbackTriggeredError } from "../recovery/api-errors.js";

describe("decideResume", () => {
  it("aborts when parent is aborted", () => {
    const d = decideResume({
      consecutiveFailures: 0,
      error: new Error("anything"),
      parentAborted: true,
    });
    expect(d.kind).toBe("abort");
    expect(d.reason).toBe("parent_aborted");
  });

  it("aborts when over RESUME_MAX_ATTEMPTS", () => {
    const d = decideResume({
      consecutiveFailures: RESUME_MAX_ATTEMPTS,
      error: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }),
      parentAborted: false,
    });
    expect(d.kind).toBe("abort");
  });

  it("resumes on transient provider errors", () => {
    const d = decideResume({
      consecutiveFailures: 1,
      error: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }),
      parentAborted: false,
    });
    expect(d.kind).toBe("resume");
  });

  it("restarts on hard errors", () => {
    const d = decideResume({
      consecutiveFailures: 0,
      error: new FallbackTriggeredError("provider switch"),
      parentAborted: false,
    });
    expect(d.kind).toBe("restart");
  });
});

describe("ResumeManager", () => {
  it("increments per-thread failure count", () => {
    const mgr = new ResumeManager();
    const err = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    mgr.recordFailure("t1", err, false);
    expect(mgr.getFailureCount("t1")).toBe(1);
    mgr.recordFailure("t1", err, false);
    expect(mgr.getFailureCount("t1")).toBe(2);
  });

  it("independent threads have independent counters", () => {
    const mgr = new ResumeManager();
    const err = new Error("x");
    mgr.recordFailure("t1", err, false);
    mgr.recordFailure("t2", err, false);
    mgr.recordFailure("t2", err, false);
    expect(mgr.getFailureCount("t1")).toBe(1);
    expect(mgr.getFailureCount("t2")).toBe(2);
  });

  it("recordSuccess resets the counter", () => {
    const mgr = new ResumeManager();
    mgr.recordFailure("t1", new Error("x"), false);
    mgr.recordSuccess("t1");
    expect(mgr.getFailureCount("t1")).toBe(0);
  });

  it("clear wipes every tracked thread", () => {
    const mgr = new ResumeManager();
    mgr.recordFailure("t1", new Error("x"), false);
    mgr.clear();
    expect(mgr.getFailureCount("t1")).toBe(0);
  });

  it("returns abort after RESUME_MAX_ATTEMPTS failures", () => {
    const mgr = new ResumeManager();
    const err = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    let last = mgr.recordFailure("t1", err, false);
    for (let i = 1; i < RESUME_MAX_ATTEMPTS; i++) {
      last = mgr.recordFailure("t1", err, false);
    }
    expect(last.kind).toBe("abort");
  });
});
