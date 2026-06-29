import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_INSTRUCTIONS_FILENAME } from "../config/project-init.js";
import type { Session } from "../session/session.js";
import { initCommand } from "./init.js";
import type { SlashCommandContext } from "./types.js";

function stubSession(): Session {
  return {
    services: {},
    nextInternalSubId: () => "sub-init-test",
    emit: () => {},
  } as unknown as Session;
}

function stubCtx(cwd: string, argsRaw = ""): SlashCommandContext {
  return {
    session: stubSession(),
    argsRaw,
    cwd,
    home: "/home/test",
  };
}

describe("initCommand", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "agenc-init-command-"));
    tempDirs.push(dir);
    return dir;
  }

  it("analyzes the repository and writes project instructions", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "README.md"), "# Slash Init\n", "utf8");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "slash-init-fixture",
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
        },
      }),
      "utf8",
    );

    const result = await initCommand.execute(stubCtx(cwd));

    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.text).toContain("Initialized AgenC project");
    const instructions = readFileSync(
      join(cwd, PROJECT_INSTRUCTIONS_FILENAME),
      "utf8",
    );
    expect(instructions).toContain("Project/package name: slash-init-fixture");
    expect(instructions).toContain("`npm run typecheck`");
    expect(instructions).toContain("`src/` contains source code");
  });

  it("keeps existing files unless --force is provided", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, PROJECT_INSTRUCTIONS_FILENAME), "existing\n", "utf8");

    const result = await initCommand.execute(stubCtx(cwd));

    expect(result.kind).toBe("text");
    expect(readFileSync(join(cwd, PROJECT_INSTRUCTIONS_FILENAME), "utf8")).toBe(
      "existing\n",
    );
  });

  it("prints usage for --help", async () => {
    const result = await initCommand.execute(stubCtx(tempProject(), "--help"));
    expect(result).toEqual({ kind: "text", text: "Usage: /init [--force]" });
  });
});
