// `agenc gateway` CLI (TODO task 6): parse matrix + status/pairing against a
// temp home with a real config.json + pairing store.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  formatAgenCGatewayCliHelpText,
  parseAgenCGatewayCliArgs,
  runAgenCGatewayCli,
} from "../../src/bin/gateway-cli.js";
import { PairingStore } from "../../src/gateway/pairing.js";

describe("parseAgenCGatewayCliArgs", () => {
  test("null for non-gateway argv", () => {
    expect(parseAgenCGatewayCliArgs(["security"])).toBeNull();
  });
  test("bare gateway → help", () => {
    expect(parseAgenCGatewayCliArgs(["gateway"])).toEqual({
      kind: "help",
      text: formatAgenCGatewayCliHelpText(),
    });
  });
  test("status + json", () => {
    expect(parseAgenCGatewayCliArgs(["gateway", "status"])).toEqual({
      kind: "status",
      json: false,
    });
    expect(parseAgenCGatewayCliArgs(["gateway", "status", "--json"])).toEqual({
      kind: "status",
      json: true,
    });
  });
  test("pairing list + revoke", () => {
    expect(parseAgenCGatewayCliArgs(["gateway", "pairing", "list"])).toEqual({
      kind: "pairing-list",
      json: false,
    });
    expect(
      parseAgenCGatewayCliArgs(["gateway", "pairing", "revoke", "tg", "alice"]),
    ).toEqual({ kind: "pairing-revoke", channelId: "tg", peerId: "alice" });
  });
  test("revoke without args errors", () => {
    expect(
      parseAgenCGatewayCliArgs(["gateway", "pairing", "revoke", "tg"]),
    ).toMatchObject({ kind: "error" });
  });
});

describe("gateway CLI against a temp home", () => {
  let home: string;
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-gw-cli-"));
    env = { AGENC_HOME: home, HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function writeConfig(config: unknown): void {
    mkdirSync(join(home, "gateway"), { recursive: true });
    writeFileSync(join(home, "gateway", "config.json"), JSON.stringify(config));
  }

  test("status: no config → fail-closed summary", async () => {
    const out: string[] = [];
    const code = await runAgenCGatewayCli(
      { kind: "status", json: true },
      { env, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.defaultAgent).toBe("default");
    expect(report.channels).toEqual([]);
  });

  test("status: reports channel policy + paired count", async () => {
    writeConfig({
      channels: { tg: { dmPolicy: "pairing", allowlist: [] } },
      bindings: [{ agent: "work", channelId: "tg", peerId: "alice" }],
      defaultAgent: "home",
    });
    const store = new PairingStore({ agencHome: home, generateCode: () => "C" });
    store.challenge("tg", { peerId: "alice" });
    store.redeem("tg", { peerId: "alice" }, "C");

    const out: string[] = [];
    const code = await runAgenCGatewayCli(
      { kind: "status", json: true },
      { env, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.defaultAgent).toBe("home");
    expect(report.bindingCount).toBe(1);
    const tg = report.channels.find((c: { channelId: string }) => c.channelId === "tg");
    expect(tg).toMatchObject({ dmPolicy: "pairing", pairedCount: 1 });
  });

  test("pairing list shows paired senders; revoke removes them", async () => {
    writeConfig({ channels: { tg: { dmPolicy: "pairing", allowlist: [] } } });
    const store = new PairingStore({ agencHome: home, generateCode: () => "C" });
    store.challenge("tg", { peerId: "alice" });
    store.redeem("tg", { peerId: "alice" }, "C");

    const listOut: string[] = [];
    await runAgenCGatewayCli(
      { kind: "pairing-list", json: false },
      { env, stdout: (l) => listOut.push(l) },
    );
    expect(listOut.join("\n")).toContain("alice");

    const revokeOut: string[] = [];
    const code = await runAgenCGatewayCli(
      { kind: "pairing-revoke", channelId: "tg", peerId: "alice" },
      { env, stdout: (l) => revokeOut.push(l) },
    );
    expect(code).toBe(0);
    expect(revokeOut.join("\n")).toContain("Revoked");

    // A fresh store confirms persistence of the revoke.
    const store2 = new PairingStore({ agencHome: home });
    expect(store2.isPaired("tg", "alice")).toBe(false);
  });

  test("revoke of a non-paired sender exits 1", async () => {
    writeConfig({ channels: { tg: { dmPolicy: "pairing", allowlist: [] } } });
    const err: string[] = [];
    const code = await runAgenCGatewayCli(
      { kind: "pairing-revoke", channelId: "tg", peerId: "ghost" },
      { env, stderr: (l) => err.push(l) },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not paired");
  });

  test("malformed channel policy is dropped, not coerced permissive", async () => {
    writeConfig({
      channels: {
        good: { dmPolicy: "allowlist", allowlist: ["x"] },
        bad: { dmPolicy: "wide-open" },
      },
    });
    const out: string[] = [];
    const warn: string[] = [];
    await runAgenCGatewayCli(
      { kind: "status", json: true },
      { env, stdout: (l) => out.push(l), stderr: (l) => warn.push(l) },
    );
    const report = JSON.parse(out.join("\n"));
    const ids = report.channels.map((c: { channelId: string }) => c.channelId);
    expect(ids).toContain("good");
    expect(ids).not.toContain("bad");
    expect(warn.join("\n")).toContain("invalid dmPolicy");
  });
});
