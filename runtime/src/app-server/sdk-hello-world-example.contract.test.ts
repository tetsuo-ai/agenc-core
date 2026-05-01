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

describe("AgenC SDK hello-world daemon example", () => {
  it("creates a session, sends a message, and awaits the SDK response", () => {
    const packageJson = JSON.parse(
      readSiblingSdkSource(
        "examples",
        "daemon-hello-world",
        "package.json",
      ),
    ) as {
      readonly dependencies?: Record<string, string>;
      readonly scripts?: Record<string, string>;
    };
    const source = readSiblingSdkSource(
      "examples",
      "daemon-hello-world",
      "index.ts",
    );
    const readme = readSiblingSdkSource(
      "examples",
      "daemon-hello-world",
      "README.md",
    );

    expect(packageJson.dependencies?.["@tetsuo-ai/sdk"]).toBe("file:../..");
    expect(packageJson.scripts?.start).toBe("tsx index.ts");
    expect(source).toContain("createAgenCDaemonClient");
    expect(source).toContain("client.createSession");
    expect(source).toContain("client.sendMessage");
    expect(source).toContain("await client.sendMessage");
    expect(source).toContain("AGENC_DAEMON_SOCKET");
    expect(source).not.toMatch(/from ["']\.\.\/\.\.\/src\//);
    expect(source).not.toMatch(/createAgent|agent\.create/);
    expect(readme).toContain("creates a session");
    expect(readme).toContain("message.send");
  });
});
