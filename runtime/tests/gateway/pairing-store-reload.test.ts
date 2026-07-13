import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PairingStore } from "../../src/gateway/pairing.js";

describe("PairingStore disk reload (GW-02)", () => {
  let home: string;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("CLI approve is visible to a separate live store without restart", () => {
    home = mkdtempSync(join(tmpdir(), "agenc-pair-"));
    const live = new PairingStore({ agencHome: home });
    const code = live.challenge("telegram", {
      peerId: "42",
      displayName: "u",
    });
    expect(code.length).toBeGreaterThan(0);

    // Host CLI uses a second process/store instance.
    const cli = new PairingStore({ agencHome: home });
    cli.approve("telegram", "42");

    // Live gateway must see the pair without reconstructing.
    expect(live.isPaired("telegram", "42")).toBe(true);

    // Further live challenge must not wipe the CLI pairing on save.
    live.challenge("discord", {
      peerId: "99",
      displayName: "other",
    });
    expect(live.isPaired("telegram", "42")).toBe(true);
    const cliAgain = new PairingStore({ agencHome: home });
    expect(cliAgain.isPaired("telegram", "42")).toBe(true);
  });
});
