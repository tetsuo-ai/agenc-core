import { describe, expect, it } from "vitest";

import { rolloutRetentionPolicy } from "../../src/app-server/daemon-cli.js";

// #2228: rollout retention defaults to 30 days; 0 keeps every session, and a
// zero-day window must never reach the sweep, which would otherwise delete
// everything but the active session at its first tick.
describe("rollout retention policy from config", () => {
  it("maps a positive window to the sweep policy", () => {
    expect(rolloutRetentionPolicy({ rollout_days: 30 })).toEqual({ retention_days: 30 });
    expect(rolloutRetentionPolicy({ rollout_days: 1 })).toEqual({ retention_days: 1 });
  });

  it("disables the sweep for 0, negative, non-finite and unset windows", () => {
    expect(rolloutRetentionPolicy({ rollout_days: 0 })).toBeUndefined();
    expect(rolloutRetentionPolicy({ rollout_days: -3 })).toBeUndefined();
    expect(rolloutRetentionPolicy({ rollout_days: Number.NaN })).toBeUndefined();
    expect(rolloutRetentionPolicy({})).toBeUndefined();
    expect(rolloutRetentionPolicy(undefined)).toBeUndefined();
  });
});
