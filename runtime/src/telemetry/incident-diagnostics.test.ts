import { describe, expect, it } from "vitest";
import { RuntimeIncidentDiagnostics } from "./incident-diagnostics.js";

describe("RuntimeIncidentDiagnostics", () => {
  it("tracks degraded and safe-mode dependencies and clears them", () => {
    const diagnostics = new RuntimeIncidentDiagnostics();

    diagnostics.report({
      domain: "provider",
      mode: "degraded",
      severity: "warn",
      code: "provider_timeout",
      message: "Primary provider timed out.",
    });

    let snapshot = diagnostics.getSnapshot();
    expect(snapshot.runtimeMode).toBe("degraded");
    expect(snapshot.dependencies).toHaveLength(1);
    expect(snapshot.dependencies[0]?.domain).toBe("provider");

    diagnostics.report({
      domain: "persistence",
      mode: "safe_mode",
      severity: "error",
      code: "persistence_failure",
      message: "SQLite write failed.",
    });

    snapshot = diagnostics.getSnapshot();
    expect(snapshot.runtimeMode).toBe("safe_mode");
    expect(
      snapshot.dependencies.some((entry) => entry.domain === "persistence"),
    ).toBe(true);

    diagnostics.clearDomain("persistence");
    snapshot = diagnostics.getSnapshot();
    expect(snapshot.runtimeMode).toBe("degraded");
    expect(
      snapshot.dependencies.some((entry) => entry.domain === "persistence"),
    ).toBe(false);
  });

  it("increments repeated incident counts per dependency code", () => {
    const diagnostics = new RuntimeIncidentDiagnostics();
    diagnostics.report({
      domain: "provider",
      mode: "degraded",
      severity: "warn",
      code: "provider_timeout",
      message: "timeout one",
    });
    diagnostics.report({
      domain: "provider",
      mode: "degraded",
      severity: "warn",
      code: "provider_timeout",
      message: "timeout two",
    });

    const snapshot = diagnostics.getSnapshot();
    expect(snapshot.dependencies[0]?.count).toBe(2);
    expect(snapshot.recentIncidents[0]?.count).toBe(2);
  });
});
