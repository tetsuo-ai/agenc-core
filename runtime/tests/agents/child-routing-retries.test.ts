import { describe, expect, it } from "vitest";
import {
  childRoutingSupervisorCanFallback,
  superviseChildRoutingRetries,
} from "../../src/agents/child-routing-retries.js";
import type { LiveAgent } from "../../src/agents/control.js";

function liveAgent(): LiveAgent {
  return {} as LiveAgent;
}

describe("child routing retry handoff", () => {
  it("keeps provider retries when no supervisor is watching", () => {
    expect(childRoutingSupervisorCanFallback(liveAgent())).toBe(false);
  });

  it("reports the live supervisor's current fallback decision", () => {
    const live = liveAgent();
    let allowed = true;
    const release = superviseChildRoutingRetries(live, () => allowed);
    expect(childRoutingSupervisorCanFallback(live)).toBe(true);
    allowed = false;
    expect(childRoutingSupervisorCanFallback(live)).toBe(false);
    release();
    expect(childRoutingSupervisorCanFallback(live)).toBe(false);
  });

  it("treats a throwing supervisor as unable to fall back", () => {
    const live = liveAgent();
    const release = superviseChildRoutingRetries(live, () => {
      throw new Error("routing state disappeared");
    });
    expect(childRoutingSupervisorCanFallback(live)).toBe(false);
    release();
  });

  it("does not let a stale release drop a later supervisor", () => {
    const live = liveAgent();
    const first = superviseChildRoutingRetries(live, () => false);
    const second = superviseChildRoutingRetries(live, () => true);
    first();
    expect(childRoutingSupervisorCanFallback(live)).toBe(true);
    second();
    expect(childRoutingSupervisorCanFallback(live)).toBe(false);
  });

  it("scopes the supervisor to the watched child only", () => {
    const watched = liveAgent();
    const other = liveAgent();
    const release = superviseChildRoutingRetries(watched, () => true);
    expect(childRoutingSupervisorCanFallback(watched)).toBe(true);
    expect(childRoutingSupervisorCanFallback(other)).toBe(false);
    release();
  });
});
