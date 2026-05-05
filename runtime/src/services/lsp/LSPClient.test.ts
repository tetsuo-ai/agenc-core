import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createLSPClient } from "./LSPClient.js";

const EXITING_SERVER = "setTimeout(() => process.exit(1), 10)";

describe("createLSPClient", () => {
  test("clears closed process state so a crashed server can be started again", async () => {
    let crashCount = 0;
    const client = createLSPClient("crashy", {
      onCrash: () => {
        crashCount += 1;
      },
    });

    await client.start(process.execPath, ["-e", EXITING_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crashCount).toBe(1);

    await client.start(process.execPath, ["-e", EXITING_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crashCount).toBe(2);
  });

  test("scrubs inherited secrets while preserving explicit config env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-env-"));
    const output = join(dir, "env.json");
    try {
      const client = createLSPClient("env", {
        baseEnv: {
          PATH: process.env.PATH,
          HOME: "/home/test",
          OPENAI_API_KEY: "secret",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
          INPUT_OPENAI_API_KEY: "duplicated",
        },
      });

      await client.start(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));`,
      ], {
        env: { LSP_EXPLICIT_ENV: "kept" },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const env = JSON.parse(await readFile(output, "utf8")) as Record<
        string,
        string | undefined
      >;
      expect(env.HOME).toBe("/home/test");
      expect(env.LSP_EXPLICIT_ENV).toBe("kept");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.INPUT_OPENAI_API_KEY).toBeUndefined();
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
