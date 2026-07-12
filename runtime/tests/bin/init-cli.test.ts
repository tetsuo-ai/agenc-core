import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_CONFIG_DIR,
  PROJECT_CONFIG_FILENAME,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "../config/project-init.js";
import {
  formatAgenCInitCliHelpText,
  parseAgenCInitCliArgs,
  runAgenCInitCli,
  type AgenCInitCliIo,
} from "./init-cli.js";

function createIo(): AgenCInitCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

describe("agenc init CLI", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "agenc-init-cli-"));
    tempDirs.push(dir);
    return dir;
  }

  function configPath(cwd: string): string {
    return join(cwd, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
  }

  function instructionsPath(cwd: string): string {
    return join(cwd, PROJECT_INSTRUCTIONS_FILENAME);
  }

  it("parses init arguments", () => {
    expect(parseAgenCInitCliArgs(["hello"])).toBeNull();
    expect(parseAgenCInitCliArgs(["init"])).toEqual({
      kind: "init",
      force: false,
    });
    expect(parseAgenCInitCliArgs(["init", "--force"])).toEqual({
      kind: "init",
      force: true,
    });
    expect(parseAgenCInitCliArgs(["init", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCInitCliHelpText(),
    });
    expect(parseAgenCInitCliArgs(["init", "extra"])).toEqual({
      kind: "error",
      message: "init command does not accept argument 'extra'",
    });
  });

  it("creates .agenc/config.json and AGENC.md in the current project", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "src"));
    writeFileSync(
      join(cwd, "README.md"),
      "# Init Fixture\n\nUses FIXTURE_API_KEY for local integration checks.\n",
      "utf8",
    );
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "init-fixture",
        packageManager: "npm@11.0.0",
        scripts: {
          build: "tsc",
          test: "vitest run",
        },
        devDependencies: {
          vitest: "^3.0.0",
        },
      }),
      "utf8",
    );
    const io = createIo();

    const code = await runAgenCInitCli(
      { kind: "init", force: false },
      { cwd, io },
    );

    expect(code).toBe(0);
    expect(io.stderrText()).toBe("");
    expect(io.stdoutText()).toContain("Initialized AgenC project");
    expect(io.stdoutText()).toContain(".agenc/config.json");
    expect(io.stdoutText()).toContain("AGENC.md");

    const config = JSON.parse(readFileSync(configPath(cwd), "utf8")) as {
      model_provider?: string;
      model?: string;
      sandbox?: { mode?: string };
    };
    expect(config.model_provider).toBe("grok");
    expect(config.model).toBe("grok-4.5");
    expect(config.sandbox?.mode).toBe("workspace-write");
    expect(readFileSync(instructionsPath(cwd), "utf8")).toContain(
      "# Repository Guidelines",
    );
    expect(readFileSync(instructionsPath(cwd), "utf8")).toContain(
      "Project/package name: init-fixture",
    );
    expect(readFileSync(instructionsPath(cwd), "utf8")).toContain(
      "`npm run build`",
    );
    expect(readFileSync(instructionsPath(cwd), "utf8")).toContain(
      "`FIXTURE_API_KEY`",
    );
    expect(readFileSync(instructionsPath(cwd), "utf8")).not.toContain(
      "Fill this file",
    );
  });

  it("keeps existing files unless --force is provided", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, PROJECT_CONFIG_DIR));
    writeFileSync(configPath(cwd), "{\"model\":\"custom\"}\n", "utf8");
    writeFileSync(instructionsPath(cwd), "existing guide\n", "utf8");
    const io = createIo();

    const code = await runAgenCInitCli(
      { kind: "init", force: false },
      { cwd, io },
    );

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("AgenC project already initialized");
    expect(io.stdoutText()).toContain("kept .agenc/config.json");
    expect(io.stdoutText()).toContain("kept AGENC.md");
    expect(readFileSync(configPath(cwd), "utf8")).toBe(
      "{\"model\":\"custom\"}\n",
    );
    expect(readFileSync(instructionsPath(cwd), "utf8")).toBe(
      "existing guide\n",
    );
  });

  it("overwrites existing project files with --force", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, PROJECT_CONFIG_DIR));
    writeFileSync(configPath(cwd), "{\"model\":\"custom\"}\n", "utf8");
    writeFileSync(instructionsPath(cwd), "existing guide\n", "utf8");
    const io = createIo();

    const code = await runAgenCInitCli(
      { kind: "init", force: true },
      { cwd, io },
    );

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("overwrote .agenc/config.json");
    expect(io.stdoutText()).toContain("overwrote AGENC.md");
    expect(readFileSync(configPath(cwd), "utf8")).toContain(
      "\"model\": \"grok-4.5\"",
    );
    expect(readFileSync(instructionsPath(cwd), "utf8")).toContain(
      "## Operational Notes",
    );
  });

  it("prints help and errors without creating files", async () => {
    const cwd = tempProject();
    const helpIo = createIo();
    const errorIo = createIo();

    expect(
      await runAgenCInitCli(
        { kind: "help", text: formatAgenCInitCliHelpText() },
        { cwd, io: helpIo },
      ),
    ).toBe(0);
    expect(helpIo.stdoutText()).toContain("Usage: agenc init");

    expect(
      await runAgenCInitCli(
        { kind: "error", message: "bad input" },
        { cwd, io: errorIo },
      ),
    ).toBe(1);
    expect(errorIo.stderrText()).toContain("agenc: bad input");
    expect(existsSync(configPath(cwd))).toBe(false);
    expect(existsSync(instructionsPath(cwd))).toBe(false);
  });
});
