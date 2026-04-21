import { describe, expect, it } from "vitest";
import {
  createCompiledJobExecutionGovernor,
  resolveCompiledJobExecutionBudgetControls,
} from "./compiled-job-execution-governor.js";

describe("compiled job execution governor", () => {
  it("reads concurrency and rate limits from env", () => {
    const controls = resolveCompiledJobExecutionBudgetControls({
      env: {
        AGENC_COMPILED_JOB_MAX_CONCURRENT: "4",
        AGENC_COMPILED_JOB_MAX_CONCURRENT_BY_TYPE:
          "web_research_brief=2,product_comparison_report=1",
        AGENC_COMPILED_JOB_RATE_LIMIT: "12/60000",
        AGENC_COMPILED_JOB_RATE_LIMIT_BY_TYPE:
          "web_research_brief=6/60000,product_comparison_report=3/60000",
      },
    });

    expect(controls).toEqual({
      maxConcurrentRuns: 4,
      maxConcurrentRunsByJobType: {
        web_research_brief: 2,
        product_comparison_report: 1,
      },
      executionRateLimit: {
        limit: 12,
        windowMs: 60_000,
      },
      executionRateLimitByJobType: {
        web_research_brief: {
          limit: 6,
          windowMs: 60_000,
        },
        product_comparison_report: {
          limit: 3,
          windowMs: 60_000,
        },
      },
    });
  });

  it("enforces global concurrency and releases slots", () => {
    const governor = createCompiledJobExecutionGovernor({
      controls: {
        maxConcurrentRuns: 1,
      },
    });

    const first = governor.acquire("web_research_brief");
    const second = governor.acquire("web_research_brief");

    expect(first.allowed).toBe(true);
    expect(second).toEqual({
      allowed: false,
      message: "Compiled marketplace job concurrency limit reached (1/1 active)",
    });

    first.lease?.release();

    const third = governor.acquire("web_research_brief");
    expect(third.allowed).toBe(true);
  });

  it("enforces per-job rate limits with a sliding window", () => {
    let nowMs = 1_000;
    const governor = createCompiledJobExecutionGovernor({
      controls: {
        executionRateLimitByJobType: {
          web_research_brief: {
            limit: 2,
            windowMs: 60_000,
          },
        },
      },
      now: () => nowMs,
    });

    const first = governor.acquire("web_research_brief");
    first.lease?.release();
    const second = governor.acquire("web_research_brief");
    second.lease?.release();
    const blocked = governor.acquire("web_research_brief");

    expect(blocked).toEqual({
      allowed: false,
      message:
        'Compiled job type "web_research_brief" rate limit exceeded (2/2 per 60000ms)',
    });

    nowMs += 60_001;
    const reset = governor.acquire("web_research_brief");
    expect(reset.allowed).toBe(true);
  });
});
