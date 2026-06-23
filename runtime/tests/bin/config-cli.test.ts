import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseToml } from "../config/loader.js";
import { CONFIG_FILE_VERSION_KEY, CURRENT_CONFIG_FILE_VERSION } from "../config/migrate.js";
import {
  formatAgenCConfigCliHelpText,
  parseAgenCConfigCliArgs,
  runAgenCConfigCli,
  type AgenCConfigCliOptions,
  type AgenCConfigCliIo,
} from "./config-cli.js";
import { main } from "./agenc.js";

function createIo(): AgenCConfigCliIo & {
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

const tempDirs: string[] = [];

function makeHome(prefix = "agenc-config-cli"): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function configPath(home: string): string {
  return join(home, "config.toml");
}

function readRawConfig(home: string): Record<string, unknown> {
  return parseToml(readFileSync(configPath(home), "utf8")) as Record<string, unknown>;
}

async function run(
  command: ReturnType<typeof parseAgenCConfigCliArgs>,
  home: string,
  io = createIo(),
  options: Omit<AgenCConfigCliOptions, "agencHome" | "io"> = {},
): Promise<{ readonly code: number; readonly io: ReturnType<typeof createIo> }> {
  if (command === null) throw new Error("expected config command");
  const code = await runAgenCConfigCli(command, { ...options, agencHome: home, io });
  return { code, io };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("agenc config CLI", () => {
  it("parses help and subcommands", () => {
    expect(parseAgenCConfigCliArgs(["prompt"])).toBeNull();
    expect(parseAgenCConfigCliArgs(["config"])).toEqual({
      kind: "help",
      text: formatAgenCConfigCliHelpText(),
    });
    expect(parseAgenCConfigCliArgs(["config", "show"])).toEqual({ kind: "show" });
    expect(parseAgenCConfigCliArgs(["config", "get", "model"])).toEqual({
      kind: "get",
      key: "model",
    });
    expect(parseAgenCConfigCliArgs(["config", "set", "model", "grok-3"])).toEqual({
      kind: "set",
      key: "model",
      value: "grok-3",
    });
    expect(parseAgenCConfigCliArgs(["config", "set", "model", "--help"])).toEqual({
      kind: "set",
      key: "model",
      value: "--help",
    });
    expect(parseAgenCConfigCliArgs(["config", "unset", "model"])).toEqual({
      kind: "unset",
      key: "model",
    });
    expect(parseAgenCConfigCliArgs(["config", "validate"])).toEqual({
      kind: "validate",
    });
    expect(parseAgenCConfigCliArgs(["config", "edit"])).toEqual({ kind: "edit" });
    expect(parseAgenCConfigCliArgs(["config", "path"])).toEqual({ kind: "path" });
    expect(parseAgenCConfigCliArgs(["config", "set", "model"])).toEqual({
      kind: "error",
      message: "config set requires a value",
    });
    expect(formatAgenCConfigCliHelpText()).toContain("agenc config validate");
    expect(formatAgenCConfigCliHelpText()).toContain("keys containing literal dots");
  });

  it("prints the config path and opens the editor with an injectable spawner", async () => {
    const home = makeHome();
    const pathIo = createIo();
    const pathExit = await runAgenCConfigCli({ kind: "path" }, { agencHome: home, io: pathIo });
    expect(pathExit).toBe(0);
    expect(pathIo.stdoutText()).toBe(`${configPath(home)}\n`);

    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
    const editIo = createIo();
    const editExit = await runAgenCConfigCli(
      { kind: "edit" },
      {
        agencHome: home,
        env: { EDITOR: "code --wait" },
        io: editIo,
        spawner: async (command, args) => {
          calls.push({ command, args });
          return 0;
        },
      },
    );
    expect(editExit).toBe(0);
    expect(calls).toEqual([{ command: "code", args: ["--wait", configPath(home)] }]);
    expect(existsSync(home)).toBe(true);
    expect(editIo.stdoutText()).toContain(`Edited ${configPath(home)}`);

    const failedIo = createIo();
    const failedExit = await runAgenCConfigCli(
      { kind: "edit" },
      {
        agencHome: home,
        env: { VISUAL: "vim -n" },
        io: failedIo,
        spawner: async (command, args) => {
          calls.push({ command, args });
          return 42;
        },
      },
    );
    expect(failedExit).toBe(1);
    expect(calls.at(-1)).toEqual({ command: "vim", args: ["-n", configPath(home)] });
    expect(failedIo.stderrText()).toContain('editor "vim" exited with code 42');
  });

  it("migrates legacy JSON before edit and refuses unsafe JSON shadowing", async () => {
    const home = makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ provider: "xai", model: "legacy" }),
      "utf8",
    );
    const editIo = createIo();
    const calls: string[][] = [];
    const exit = await runAgenCConfigCli(
      { kind: "edit" },
      {
        agencHome: home,
        env: { EDITOR: "vim" },
        io: editIo,
        spawner: async (_command, args) => {
          calls.push([...args]);
          expect(existsSync(configPath(home))).toBe(true);
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(calls).toEqual([[configPath(home)]]);
    expect(existsSync(join(home, "config.json.bak-cf12"))).toBe(true);
    expect(readRawConfig(home)).toMatchObject({
      model: "legacy",
      model_provider: "grok",
    });

    const invalidHome = makeHome();
    writeFileSync(join(invalidHome, "config.json"), "{not json", "utf8");
    const refusedIo = createIo();
    const spawner = vi.fn(async () => 0);
    const refused = await runAgenCConfigCli(
      { kind: "edit" },
      {
        agencHome: invalidHome,
        env: { EDITOR: "vim" },
        io: refusedIo,
        spawner,
      },
    );
    expect(refused).toBe(1);
    expect(spawner).not.toHaveBeenCalled();
    expect(existsSync(configPath(invalidHome))).toBe(false);
    expect(refusedIo.stderrText()).toContain("skipped config migration");
  });

  it("shows, gets, and validates effective config without hiding invalid files", async () => {
    const home = makeHome();
    writeFileSync(configPath(home), `model = "grok-3"\n`, "utf8");

    const show = await run(parseAgenCConfigCliArgs(["config", "show"]), home);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.io.stdoutText())).toMatchObject({ model: "grok-3" });

    const get = await run(parseAgenCConfigCliArgs(["config", "get", "model"]), home);
    expect(get.code).toBe(0);
    expect(get.io.stdoutText()).toBe("grok-3\n");

    const envGet = await run(
      parseAgenCConfigCliArgs(["config", "get", "model"]),
      home,
      createIo(),
      { env: { AGENC_MODEL: "grok-env" } },
    );
    expect(envGet.code).toBe(0);
    expect(envGet.io.stdoutText()).toBe("grok-env\n");

    const envShow = await run(
      parseAgenCConfigCliArgs(["config", "show"]),
      home,
      createIo(),
      { env: { AGENC_MODEL: "grok-env" } },
    );
    expect(envShow.code).toBe(0);
    expect(JSON.parse(envShow.io.stdoutText())).toMatchObject({ model: "grok-env" });

    const validate = await run(parseAgenCConfigCliArgs(["config", "validate"]), home);
    expect(validate.code).toBe(0);
    expect(validate.io.stdoutText()).toContain(`Config valid: ${configPath(home)}`);

    writeFileSync(configPath(home), `[plugins]\nenabled = "bad"\n`, "utf8");
    const invalid = await run(parseAgenCConfigCliArgs(["config", "validate"]), home);
    expect(invalid.code).toBe(1);
    expect(invalid.io.stderrText()).toContain("invalid config");
  });

  it("sets TOML values, versions the file, and preserves sibling config", async () => {
    const home = makeHome();

    for (const args of [
      ["config", "set", "model", "grok-3"],
      ["config", "set", "plugins.enabled", "true"],
      ["config", "set", "project_root_markers", "[\".git\", \"package.json\"]"],
      ["config", "set", "custom.inline", "{ enabled = true }"],
      ["config", "set", "custom.label", "plain text"],
    ] as const) {
      const result = await run(parseAgenCConfigCliArgs(args), home);
      expect(result.code, args.join(" ")).toBe(0);
    }

    const raw = readRawConfig(home);
    expect(raw[CONFIG_FILE_VERSION_KEY]).toBe(CURRENT_CONFIG_FILE_VERSION);
    expect(raw.model).toBe("grok-3");
    expect(raw.plugins).toEqual({ enabled: true });
    expect(raw.project_root_markers).toEqual([".git", "package.json"]);
    expect(raw.custom).toEqual({
      inline: { enabled: true },
      label: "plain text",
    });
  });

  it("normalizes BOM-prefixed TOML before set and unset", async () => {
    const setHome = makeHome();
    writeFileSync(
      configPath(setHome),
      `\ufeffconfigVersion = ${CURRENT_CONFIG_FILE_VERSION}\nmodel = "old"\n`,
      "utf8",
    );
    const set = await run(parseAgenCConfigCliArgs(["config", "set", "model", "grok-3"]), setHome);
    expect(set.code).toBe(0);
    expect(readRawConfig(setHome).model).toBe("grok-3");

    const unsetHome = makeHome();
    writeFileSync(
      configPath(unsetHome),
      `\ufeffconfigVersion = ${CURRENT_CONFIG_FILE_VERSION}\n\n[custom]\nlabel = "remove"\n`,
      "utf8",
    );
    const unset = await run(parseAgenCConfigCliArgs(["config", "unset", "custom.label"]), unsetHome);
    expect(unset.code).toBe(0);
    expect(readRawConfig(unsetHome).custom).toBeUndefined();
  });

  it("migrates legacy JSON before set and refuses unsafe JSON shadowing", async () => {
    const home = makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ provider: "xai", providers: { xai: { default_model: "grok-4-fast" } } }),
      "utf8",
    );

    const migrated = await run(parseAgenCConfigCliArgs(["config", "set", "model", "grok-3"]), home);
    expect(migrated.code).toBe(0);
    expect(existsSync(join(home, "config.json.bak-cf12"))).toBe(true);
    expect(readRawConfig(home)).toMatchObject({
      model_provider: "grok",
      model: "grok-3",
      providers: { grok: { default_model: "grok-4-fast" } },
    });

    const invalidHome = makeHome();
    writeFileSync(join(invalidHome, "config.json"), "{not json", "utf8");
    const invalidValidate = await run(
      parseAgenCConfigCliArgs(["config", "validate"]),
      invalidHome,
    );
    expect(invalidValidate.code).toBe(1);
    expect(invalidValidate.io.stderrText()).toContain("skipped config migration");
    expect(invalidValidate.io.stdoutText()).not.toContain("Config valid");

    const rejected = await run(parseAgenCConfigCliArgs(["config", "set", "model", "grok-3"]), invalidHome);
    expect(rejected.code).toBe(1);
    expect(existsSync(configPath(invalidHome))).toBe(false);
    expect(rejected.io.stderrText()).toContain("skipped config migration");
  });

  it("rejects managed fields, malformed structured values, and invalid schema writes", async () => {
    const home = makeHome();
    writeFileSync(
      configPath(home),
      `configVersion = ${CURRENT_CONFIG_FILE_VERSION}\n\n[plugins]\nenabled = true\n`,
      "utf8",
    );
    const before = readFileSync(configPath(home), "utf8");

    const managed = await run(parseAgenCConfigCliArgs(["config", "set", "configVersion", "99"]), home);
    expect(managed.code).toBe(1);
    expect(managed.io.stderrText()).toContain("configVersion is managed");

    const managedUnset = await run(parseAgenCConfigCliArgs(["config", "unset", "configVersion"]), home);
    expect(managedUnset.code).toBe(1);
    expect(managedUnset.io.stderrText()).toContain("configVersion is managed");

    const malformed = await run(parseAgenCConfigCliArgs(["config", "set", "custom.bad", "{ broken"]), home);
    expect(malformed.code).toBe(1);
    expect(malformed.io.stderrText()).toContain("invalid TOML value");

    const invalidSchema = await run(parseAgenCConfigCliArgs(["config", "set", "plugins.enabled", "nope"]), home);
    expect(invalidSchema.code).toBe(1);
    expect(invalidSchema.io.stderrText()).toContain("Invalid plugins.enabled");
    expect(readFileSync(configPath(home), "utf8")).toBe(before);
  });

  it("rejects prototype-polluting path segments on set and unset", async () => {
    const home = makeHome();

    const setPollution = await run(parseAgenCConfigCliArgs([
      "config",
      "set",
      "__proto__.polluted",
      "true",
    ]), home);
    expect(setPollution.code).toBe(1);
    expect(setPollution.io.stderrText()).toContain("path segment is not allowed");
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(existsSync(configPath(home))).toBe(false);

    const unsetPollution = await run(parseAgenCConfigCliArgs([
      "config",
      "unset",
      "constructor.prototype.polluted",
    ]), home);
    expect(unsetPollution.code).toBe(1);
    expect(unsetPollution.io.stderrText()).toContain("path segment is not allowed");
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();

    const readPollution = await run(parseAgenCConfigCliArgs([
      "config",
      "get",
      "__proto__.toString",
    ]), home);
    expect(readPollution.code).toBe(1);
    expect(readPollution.io.stderrText()).toContain("path segment is not allowed");

    for (const inheritedKey of ["toString", "valueOf", "hasOwnProperty"]) {
      const inherited = await run(parseAgenCConfigCliArgs([
        "config",
        "get",
        inheritedKey,
      ]), home);
      expect(inherited.code, inheritedKey).toBe(0);
      expect(inherited.io.stdoutText()).toBe(`not set: ${inheritedKey}\n`);
    }
  });

  it("rejects invalid permissions config on validate and set", async () => {
    const home = makeHome();
    writeFileSync(
      configPath(home),
      `configVersion = ${CURRENT_CONFIG_FILE_VERSION}\n\n[permissions]\ndefault_mode = "bad"\n`,
      "utf8",
    );

    const validate = await run(parseAgenCConfigCliArgs(["config", "validate"]), home);
    expect(validate.code).toBe(1);
    expect(validate.io.stderrText()).toContain("Invalid permissions.default_mode");

    const setHome = makeHome();
    writeFileSync(
      configPath(setHome),
      `configVersion = ${CURRENT_CONFIG_FILE_VERSION}\nmodel = "grok-3"\n`,
      "utf8",
    );
    const before = readFileSync(configPath(setHome), "utf8");
    const setInvalid = await run(parseAgenCConfigCliArgs([
      "config",
      "set",
      "permissions.default_mode",
      "bad",
    ]), setHome);
    expect(setInvalid.code).toBe(1);
    expect(setInvalid.io.stderrText()).toContain("Invalid permissions.default_mode");
    expect(readFileSync(configPath(setHome), "utf8")).toBe(before);
  });

  it("unsets nested values, prunes empty records, and leaves missing config absent", async () => {
    const home = makeHome();
    writeFileSync(
      configPath(home),
      [
        `configVersion = ${CURRENT_CONFIG_FILE_VERSION}`,
        "",
        "[plugins]",
        "enabled = true",
        "",
        "[plugins.plugins.alpha]",
        "enabled = false",
      ].join("\n") + "\n",
      "utf8",
    );

    const removed = await run(parseAgenCConfigCliArgs(["config", "unset", "plugins.plugins.alpha.enabled"]), home);
    expect(removed.code).toBe(0);
    expect(removed.io.stdoutText()).toContain("Unset plugins.plugins.alpha.enabled");
    expect(readRawConfig(home).plugins).toEqual({ enabled: true });

    const beforeMissing = readFileSync(configPath(home), "utf8");
    const missing = await run(parseAgenCConfigCliArgs(["config", "unset", "plugins.plugins.alpha.enabled"]), home);
    expect(missing.code).toBe(0);
    expect(missing.io.stdoutText()).toBe("not set: plugins.plugins.alpha.enabled\n");
    expect(readFileSync(configPath(home), "utf8")).toBe(beforeMissing);

    const emptyHome = makeHome();
    const emptyMissing = await run(parseAgenCConfigCliArgs(["config", "unset", "model"]), emptyHome);
    expect(emptyMissing.code).toBe(0);
    expect(emptyMissing.io.stdoutText()).toBe("not set: model\n");
    expect(existsSync(configPath(emptyHome))).toBe(false);
  });

  it("writes through an existing config symlink target", async () => {
    const home = makeHome();
    const targetRoot = makeHome("agenc-config-target");
    const target = join(targetRoot, "real-config.toml");
    writeFileSync(target, `model = "old"\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(target, 0o600);
    symlinkSync(target, configPath(home));

    const result = await run(parseAgenCConfigCliArgs(["config", "set", "model", "grok-3"]), home);
    expect(result.code).toBe(0);
    expect(lstatSync(configPath(home)).isSymbolicLink()).toBe(true);
    expect(parseToml(readFileSync(target, "utf8"))).toMatchObject({ model: "grok-3" });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("routes agenc config through the top-level main dispatcher", async () => {
    const home = makeHome();
    const previousArgv = [...process.argv];
    const previousHome = process.env.AGENC_HOME;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.argv = ["/usr/bin/node", "/opt/agenc/bin/agenc.js", "config", "path"];
    process.env.AGENC_HOME = home;

    try {
      await expect(main()).resolves.toBe(0);
      const stdout = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(stdout).toBe(`${configPath(home)}\n`);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = previousArgv;
      if (previousHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousHome;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("does not report a contradictory hardcoded autoUpdates default on a fresh home", async () => {
    // Cross-surface consistency guard. `agenc doctor` derives the effective
    // auto-update state from getAutoUpdaterDisabledReason() over the GLOBAL
    // config, which is "enabled" when the user has not explicitly disabled it
    // (unset => null reason => "enabled"). The TOML `AgenCConfig.autoUpdates`
    // field is not read by the auto-updater. Previously `defaultConfig()`
    // injected a concrete `autoUpdates: false`, so on a fresh home with no
    // config.toml `config get autoUpdates` printed "false" — directly
    // contradicting doctor's "Auto-updates: enabled". Assert the two surfaces
    // no longer disagree: with nothing configured, `config get autoUpdates`
    // must NOT assert a concrete `false`; it reports "not set" instead.
    //
    // Revert-sensitive: restore `autoUpdates: false` in schema.ts defaultConfig()
    // and this expectation flips to `"false\n"`, failing the test.
    const freshHome = makeHome();
    expect(existsSync(configPath(freshHome))).toBe(false);

    const get = await run(
      parseAgenCConfigCliArgs(["config", "get", "autoUpdates"]),
      freshHome,
    );
    expect(get.code).toBe(0);
    expect(get.io.stdoutText()).not.toBe("false\n");
    expect(get.io.stdoutText()).toBe("not set: autoUpdates\n");

    // `config show` must likewise not surface a concrete `autoUpdates` value
    // the auto-updater never honors.
    const show = await run(parseAgenCConfigCliArgs(["config", "show"]), freshHome);
    expect(show.code).toBe(0);
    const snapshot = JSON.parse(show.io.stdoutText()) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(snapshot, "autoUpdates")).toBe(false);
  });
});
