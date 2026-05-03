import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigParseError } from "../agenc/upstream/utils/errors.js";
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
  type FsOperations,
} from "../agenc/upstream/utils/fsOperations.js";
import {
  __resetEnableConfigsForTest,
  assertConfigReadsEnabled,
  configReadsEnabled,
  enableConfigs,
} from "./upstream-init.js";

describe("enableConfigs", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConfigDir = process.env.AGENC_CONFIG_DIR;
  const originalDiagnosticsFile = process.env.AGENC_DIAGNOSTICS_FILE;
  const tempDirs: string[] = [];

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalConfigDir === undefined) {
      delete process.env.AGENC_CONFIG_DIR;
    } else {
      process.env.AGENC_CONFIG_DIR = originalConfigDir;
    }
    if (originalDiagnosticsFile === undefined) {
      delete process.env.AGENC_DIAGNOSTICS_FILE;
    } else {
      process.env.AGENC_DIAGNOSTICS_FILE = originalDiagnosticsFile;
    }
    setOriginalFsImplementation();
    __resetEnableConfigsForTest();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function useConfigDir(configContents?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agenc-upstream-init-"));
    tempDirs.push(dir);
    process.env.AGENC_CONFIG_DIR = dir;
    if (configContents !== undefined) {
      await writeFile(join(dir, ".agenc.json"), configContents);
    }
    __resetEnableConfigsForTest();
    return dir;
  }

  it("enables mirrored config reads idempotently", async () => {
    const dir = await useConfigDir();
    process.env.AGENC_DIAGNOSTICS_FILE = join(dir, "diagnostics.log");

    expect(configReadsEnabled()).toBe(false);

    enableConfigs();
    enableConfigs();

    expect(configReadsEnabled()).toBe(true);
    const events = (await readFile(process.env.AGENC_DIAGNOSTICS_FILE, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string })
      .map((entry) => entry.event);
    expect(events).toEqual([
      "enable_configs_started",
      "enable_configs_completed",
    ]);
  });

  it("guards config reads until startup enables them", async () => {
    await useConfigDir();
    process.env.NODE_ENV = "production";

    expect(() => assertConfigReadsEnabled()).toThrow(
      "Config accessed before allowed.",
    );

    enableConfigs();

    expect(() => assertConfigReadsEnabled()).not.toThrow();
  });

  it("fails fast on invalid global config during startup", async () => {
    await useConfigDir("{invalid-json");

    expect(() => enableConfigs()).toThrow(ConfigParseError);
  });

  it("validates through the active fs implementation", async () => {
    const dir = await useConfigDir();
    const originalFs = getFsImplementation();
    const expectedPath = join(dir, ".agenc.json");
    let readPath: string | undefined;
    setFsImplementation({
      ...originalFs,
      readFileSync(path, _options) {
        readPath = path;
        return "{invalid-json";
      },
    } as FsOperations);

    let thrown: unknown;
    try {
      enableConfigs();
    } catch (error) {
      thrown = error;
    }

    expect(readPath).toBe(expectedPath);
    expect(thrown).toBeInstanceOf(ConfigParseError);
    expect((thrown as ConfigParseError).filePath).toBe(expectedPath);
    expect((thrown as ConfigParseError).defaultConfig).toMatchObject({
      theme: "dark",
      env: {},
    });
  });

  it("keeps non-parse read failures non-fatal", async () => {
    await useConfigDir();
    const originalFs = getFsImplementation();
    setFsImplementation({
      ...originalFs,
      readFileSync() {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    } as FsOperations);

    expect(() => enableConfigs()).not.toThrow();
    expect(configReadsEnabled()).toBe(true);
  });
});
