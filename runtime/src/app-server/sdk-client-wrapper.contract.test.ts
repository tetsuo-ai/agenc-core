import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENC_DAEMON_METHODS } from "./protocol/index.js";

function siblingSdkPath(...segments: readonly string[]): string {
  const path = [
    resolve(process.cwd(), "..", "..", "agenc-sdk", ...segments),
    resolve(process.cwd(), "..", "agenc-sdk", ...segments),
  ].find(existsSync);

  if (path === undefined) {
    throw new Error(`Missing sibling agenc-sdk path: ${segments.join("/")}`);
  }
  return path;
}

function readSiblingSdkSource(...segments: readonly string[]): string {
  return readFileSync(siblingSdkPath(...segments), "utf8");
}

describe("AgenC SDK daemon client wrapper", () => {
  it("exposes a typed wrapper over every daemon method without SDK agent logic", () => {
    const daemonSource = readSiblingSdkSource("src", "daemon.ts");
    const indexSource = readSiblingSdkSource("src", "index.ts");

    expect(indexSource).toContain('export * from "./daemon";');
    expect(daemonSource).toContain("export class AgenCDaemonClient");
    expect(daemonSource).toContain("export interface AgenCDaemonTransport");

    for (const method of AGENC_DAEMON_METHODS) {
      expect(daemonSource).toContain(`"${method}"`);
    }

    expect(daemonSource).not.toMatch(/@solana\/web3\.js|@coral-xyz\/anchor/);
    expect(daemonSource).not.toMatch(
      /from "\.\/(agents|tasks|bid-marketplace|proofs|prover|queries|protocol)"/,
    );
  });
});
