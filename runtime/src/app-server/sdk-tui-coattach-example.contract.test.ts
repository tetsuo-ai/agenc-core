import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

describe("AgenC SDK plus TUI co-attach example", () => {
  it("drives one daemon session through SDK and TUI client attachments", () => {
    const exampleDir = siblingSdkPath("examples", "daemon-coattach");
    const packageJson = JSON.parse(
      readSiblingSdkSource("examples", "daemon-coattach", "package.json"),
    ) as {
      readonly dependencies?: Record<string, string>;
      readonly scripts?: Record<string, string>;
    };
    const source = readSiblingSdkSource(
      "examples",
      "daemon-coattach",
      "index.ts",
    );
    const testSource = readSiblingSdkSource(
      "examples",
      "daemon-coattach",
      "index.test.ts",
    );
    const readme = readSiblingSdkSource(
      "examples",
      "daemon-coattach",
      "README.md",
    );

    expect(packageJson.dependencies?.["@tetsuo-ai/sdk"]).toBe("file:../..");
    expect(packageJson.scripts?.test).toBe("vitest run index.test.ts");
    expect(packageJson.scripts?.typecheck).toBe("tsc --noEmit -p tsconfig.json");
    expect(source).toContain("export async function runDaemonCoAttach");
    expect(source).toContain("client.attachSession");
    expect(source).toContain("client.sendMessage");
    expect(source).toContain("client.streamMessage");
    expect(source).toContain("client.listSessions");
    expect(source).toContain("activeAttachmentIds");
    expect(source).toContain("tuiClientId");
    expect(source).toContain("sdkClientId");
    expect(source).not.toMatch(/createAgent|agent\.create/);
    expect(testSource).toContain("attach:sdk-test");
    expect(testSource).toContain("attach:tui-test");
    expect(testSource).toContain("sdk:session_1");
    expect(testSource).toContain("tui:session_1");
    expect(readme).toContain("one daemon session");
    expect(readme).toContain("TUI client ID");

    const typecheck = spawnSync("npm", ["run", "typecheck"], {
      cwd: exampleDir,
      encoding: "utf8",
    });
    expect(typecheck.status, typecheck.stderr || typecheck.stdout).toBe(0);

    const test = spawnSync("npm", ["test"], {
      cwd: exampleDir,
      encoding: "utf8",
    });
    expect(test.status, test.stderr || test.stdout).toBe(0);
  });
});
