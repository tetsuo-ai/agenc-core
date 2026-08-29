import { describe, expect, it } from "vitest";

import {
  buildLandlockFallbackWarning,
  buildSandboxWarning,
  getSandboxDoctorStatus,
} from "../../src/utils/doctorDiagnostic.js";

describe("sandbox doctor diagnostic", () => {
  it("reports an unhealthy required sandbox with actionable stable output", async () => {
    const status = await getSandboxDoctorStatus({
      config: { sandbox_mode: "workspace-write" },
      cwd: process.cwd(),
      probe: ({ mode, platform }) => ({
        kind: "unavailable",
        mode,
        platform,
        reason: "probe: user namespaces are disabled",
        remediation: "enable unprivileged user namespaces",
      }),
    });

    expect(status).toMatchObject({
      kind: "unavailable",
      mode: "workspace_write",
      reason: "probe: user namespaces are disabled",
    });
    expect(buildSandboxWarning(status)).toEqual({
      issue:
        "[sandbox_required_unavailable] probe: user namespaces are disabled",
      fix: "enable unprivileged user namespaces",
    });
  });

  it("warns loudly when readiness came through the Landlock fallback", async () => {
    const status = await getSandboxDoctorStatus({
      config: { sandbox_mode: "workspace-write" },
      cwd: process.cwd(),
      probe: ({ mode, platform }) => ({
        kind: "ready",
        mode,
        platform,
        landlock: "full",
        reason:
          "probe: bubblewrap could not create the required namespaces; the Landlock fallback is active",
        landlockFallback: {
          reason: "probe: bubblewrap could not create the required namespaces",
          remediation:
            "Install AgenC's narrow per-command profile with: agenc doctor --apparmor-profile | sudo tee /etc/apparmor.d/agenc-native-userns >/dev/null && sudo apparmor_parser -r /etc/apparmor.d/agenc-native-userns; then run `agenc doctor` again.",
        },
      }),
    });

    const warning = buildLandlockFallbackWarning(status);
    expect(warning).toMatchObject({
      issue: expect.stringMatching(
        /\[sandbox_landlock_fallback\] bubblewrap is unusable .*\.git\/\.agenc.*MCP stdio servers/s,
      ),
      fix: expect.stringContaining("agenc doctor --apparmor-profile"),
    });
    // The plain unavailable warning must NOT double-fire on ready status.
    expect(buildSandboxWarning(status)).toBeNull();
  });

  it("does not emit the fallback warning on a healthy bubblewrap host", async () => {
    const status = await getSandboxDoctorStatus({
      config: { sandbox_mode: "workspace-write" },
      cwd: process.cwd(),
      probe: ({ mode, platform }) => ({
        kind: "ready",
        mode,
        platform,
      }),
    });

    expect(buildLandlockFallbackWarning(status)).toBeNull();
  });

  it("does not warn for an explicit danger-full-access selection", async () => {
    const status = await getSandboxDoctorStatus({
      config: { sandbox_mode: "danger-full-access" },
      cwd: process.cwd(),
    });

    expect(status.kind).toBe("not_required");
    expect(buildSandboxWarning(status)).toBeNull();
  });
});
