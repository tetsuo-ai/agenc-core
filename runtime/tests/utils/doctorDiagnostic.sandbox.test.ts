import { describe, expect, it } from "vitest";

import {
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

  it("does not warn for an explicit danger-full-access selection", async () => {
    const status = await getSandboxDoctorStatus({
      config: { sandbox_mode: "danger-full-access" },
      cwd: process.cwd(),
    });

    expect(status.kind).toBe("not_required");
    expect(buildSandboxWarning(status)).toBeNull();
  });
});
