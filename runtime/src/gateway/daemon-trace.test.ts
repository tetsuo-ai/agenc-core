import { describe, expect, it } from "vitest";

import {
  buildRuntimeContractSessionTraceId,
  buildRuntimeContractTaskTraceId,
  buildRuntimeContractVerifierTraceId,
  buildRuntimeContractWorkerTraceId,
} from "./daemon-trace.js";

describe("runtime contract trace ids", () => {
  it("builds deterministic session, task, worker, and verifier trace ids", () => {
    expect(buildRuntimeContractSessionTraceId("session-a")).toBe(
      "contract:session:session-a",
    );
    expect(buildRuntimeContractTaskTraceId("session-a", "7")).toBe(
      "contract:task:session-a:7",
    );
    expect(buildRuntimeContractWorkerTraceId("session-a", "worker-2")).toBe(
      "contract:worker:session-a:worker-2",
    );
    expect(buildRuntimeContractVerifierTraceId("session-a")).toBe(
      "contract:verifier:session-a",
    );
    expect(buildRuntimeContractVerifierTraceId("session-a", "11")).toBe(
      "contract:task:session-a:11",
    );
  });
});
