import { describe, expect, it } from "vitest";

import {
  APPARMOR_USERNS_REMEDIATION,
  isAppArmorUserNamespaceDenial,
  renderAgenCAppArmorProfile,
} from "../../src/sandbox/apparmor.js";

describe("AppArmor user-namespace diagnostics", () => {
  it("recognizes Ubuntu's bubblewrap loopback denial only when the restriction is enabled", () => {
    const diagnostic =
      "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
    expect(isAppArmorUserNamespaceDenial(diagnostic, "1")).toBe(true);
    expect(isAppArmorUserNamespaceDenial(diagnostic, "0")).toBe(false);
    expect(isAppArmorUserNamespaceDenial(diagnostic, null)).toBe(false);
  });

  it("does not mislabel unrelated bubblewrap failures as AppArmor", () => {
    expect(
      isAppArmorUserNamespaceDenial(
        "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
        "1",
      ),
    ).toBe(false);
  });

  it("provides the profile-generation and reload commands", () => {
    expect(APPARMOR_USERNS_REMEDIATION).toContain(
      "agenc doctor --apparmor-profile",
    );
    expect(APPARMOR_USERNS_REMEDIATION).toContain(
      "sudo apparmor_parser -r /etc/apparmor.d/agenc-native-userns",
    );
  });

  it("renders a narrow profile attached to the verified command path", () => {
    const profile = renderAgenCAppArmorProfile(
      '/home/example/AgenC tools/agenc"stable',
    );
    expect(profile).toContain(
      'profile agenc-native-userns "/home/example/AgenC tools/agenc\\"stable"',
    );
    expect(profile).toContain("flags=(unconfined)");
    expect(profile).toContain("  userns,");
    expect(profile).not.toContain("/usr/bin/node");
  });

  it("rejects unsafe or non-absolute attachment paths", () => {
    expect(() => renderAgenCAppArmorProfile("agenc")).toThrow(
      "absolute single-line path",
    );
    expect(() =>
      renderAgenCAppArmorProfile("/tmp/agenc\nprofile escape"),
    ).toThrow("absolute single-line path");
  });
});
