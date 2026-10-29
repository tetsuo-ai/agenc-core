import { describe, expect, it } from "vitest";

import {
  compareAgenCRuntimeBuilds,
  formatKeptNewerDaemonNotice,
  sameAgenCRuntimeBuild,
} from "../../src/app-server/daemon-build-order.js";

const base = { runtimeVersion: "0.19.25", commit: "a", buildTime: "2026-10-29T10:00:00.000Z" };

describe("AgenC build order", () => {
  it("orders by version first, then a rebuild by its build time", () => {
    expect(compareAgenCRuntimeBuilds({ ...base, runtimeVersion: "0.19.24" }, base)).toBe(-1);
    expect(compareAgenCRuntimeBuilds({ ...base, runtimeVersion: "0.19.26" }, base)).toBe(1);
    expect(compareAgenCRuntimeBuilds({ ...base, runtimeVersion: "0.19.25-rc.1" }, base)).toBe(-1);
    expect(compareAgenCRuntimeBuilds({ ...base, commit: "b", buildTime: "2026-10-29T11:00:00.000Z" }, base)).toBe(1);
    expect(compareAgenCRuntimeBuilds({ ...base, commit: "b" }, base)).toBe(0);
    expect(sameAgenCRuntimeBuild({ ...base }, base)).toBe(true);
    expect(sameAgenCRuntimeBuild({ ...base, commit: "b" }, base)).toBe(false);
  });

  it("cannot order an unparsable version or build time", () => {
    expect(compareAgenCRuntimeBuilds({ ...base, runtimeVersion: "dev" }, base)).toBeUndefined();
    expect(compareAgenCRuntimeBuilds({ ...base, buildTime: "unknown" }, { ...base, commit: "b" })).toBeUndefined();
  });

  it("tells an older client why the daemon keeps running", () => {
    expect(formatKeptNewerDaemonNotice({ ...base, runtimeVersion: "0.19.26" }, base)).toBe(
      "agenc: the daemon runs AgenC 0.19.26 and this agenc is 0.19.25, so the daemon keeps running. " +
        "Quit and start agenc again to use the same version.",
    );
    expect(formatKeptNewerDaemonNotice({ ...base, commit: "b", buildTime: "2026-10-30T00:00:00.000Z" }, base))
      .toContain("a newer build of AgenC 0.19.25");
  });
});
