/**
 * Integration tests for skill CLI routing via runCli.
 *
 * These import index.ts which transitively pulls in @tetsuo-ai/sdk via replay.ts.
 * They will fail at module resolution until @tetsuo-ai/sdk is built/linked.
 *
 * To run: npx vitest run src/cli/skills-cli-integration.test.ts
 */
import { Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";

function createNullStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
}

function captureStream(): { stream: Writable; data: string } {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      data += chunk.toString();
      cb();
    },
  });
  return {
    stream,
    get data() {
      return data;
    },
  };
}

async function runCliWithIsolatedConfig(options: {
  argv: string[];
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const workspace = mkdtempSync(join(tmpdir(), "agenc-skill-cli-"));
  const configPath = join(workspace, "config.json");
  const previousAgencConfig = process.env.AGENC_CONFIG;
  const previousLegacyConfig = process.env.AGENC_RUNTIME_CONFIG;

  writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { port: 3100 },
      agent: { name: "skill-cli-test-agent" },
      connection: { rpcUrl: "https://test.rpc" },
    }),
    "utf8",
  );
  process.env.AGENC_CONFIG = configPath;
  delete process.env.AGENC_RUNTIME_CONFIG;

  try {
    return await runCli(options);
  } finally {
    if (previousAgencConfig === undefined) {
      delete process.env.AGENC_CONFIG;
    } else {
      process.env.AGENC_CONFIG = previousAgencConfig;
    }
    if (previousLegacyConfig === undefined) {
      delete process.env.AGENC_RUNTIME_CONFIG;
    } else {
      process.env.AGENC_RUNTIME_CONFIG = previousLegacyConfig;
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("skill cli integration", () => {
  it("skill list routes correctly", async () => {
    const out = captureStream();
    const err = createNullStream();

    const code = await runCliWithIsolatedConfig({
      argv: ["skill", "list"],
      stdout: out.stream,
      stderr: err,
    });

    expect(code).toBe(0);
    const payload = JSON.parse(out.data.trim());
    expect(payload.status).toBe("ok");
    expect(payload.command).toBe("skill.list");
  });

  it("skill with missing subcommand returns exit 2", async () => {
    const out = createNullStream();
    const err = captureStream();

    const code = await runCliWithIsolatedConfig({
      argv: ["skill"],
      stdout: out,
      stderr: err.stream,
    });

    expect(code).toBe(2);
    const payload = JSON.parse(err.data.trim());
    expect(payload.code).toBe("MISSING_SKILL_COMMAND");
  });

  it("skill with unknown subcommand returns exit 2", async () => {
    const out = createNullStream();
    const err = captureStream();

    const code = await runCliWithIsolatedConfig({
      argv: ["skill", "bogus"],
      stdout: out,
      stderr: err.stream,
    });

    expect(code).toBe(2);
    const payload = JSON.parse(err.data.trim());
    expect(payload.code).toBe("UNKNOWN_SKILL_COMMAND");
  });

  it("skill info without name returns exit 2", async () => {
    const out = createNullStream();
    const err = captureStream();

    const code = await runCliWithIsolatedConfig({
      argv: ["skill", "info"],
      stdout: out,
      stderr: err.stream,
    });

    expect(code).toBe(2);
    const payload = JSON.parse(err.data.trim());
    expect(payload.code).toBe("MISSING_TARGET");
  });

  it("skill --help shows help text", async () => {
    const out = captureStream();
    const err = createNullStream();

    const code = await runCliWithIsolatedConfig({
      argv: ["skill", "list", "--help"],
      stdout: out.stream,
      stderr: err,
    });

    expect(code).toBe(0);
    expect(out.data).toContain("Skill subcommands");
  });
});
