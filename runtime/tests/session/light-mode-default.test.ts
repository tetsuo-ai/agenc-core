import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { validateAgenCConfigBlocks, type AgenCConfig } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  DEFAULT_LIGHT_MODE,
  resolveDefaultLightMode,
  withDefaultLightMode,
} from "../../src/session/light-mode-default.js";

describe("Light is the default session mode", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("a new session without a flag or light_mode starts in Light", () => {
    expect(DEFAULT_LIGHT_MODE).toBe(true);
    expect(resolveDefaultLightMode(undefined)).toBe(true);
    expect(withDefaultLightMode({ simpleMode: false }, undefined)).toEqual({ simpleMode: false, lightMode: true });
  });

  test("precedence: an explicit flag, then light_mode, then the default", () => {
    expect(resolveDefaultLightMode(false)).toBe(false);
    expect(resolveDefaultLightMode(true)).toBe(true);
    expect(withDefaultLightMode({ simpleMode: false }, false)).toEqual({ simpleMode: false, lightMode: false });
    // --standard beats light_mode = true, --light beats light_mode = false.
    const standard = Object.freeze({ simpleMode: false, lightMode: false });
    const light = Object.freeze({ simpleMode: false, lightMode: true });
    expect(withDefaultLightMode(standard, true)).toBe(standard);
    expect(withDefaultLightMode(light, false)).toBe(light);
  });

  test("settling the default returns a new frozen value and leaves the input alone", () => {
    const unset = Object.freeze({ simpleMode: true });
    const settled = withDefaultLightMode(unset, undefined);
    expect(Object.isFrozen(settled)).toBe(true);
    expect(unset).not.toHaveProperty("lightMode");
  });

  test("light_mode is a boolean config key", () => {
    expect(() => validateAgenCConfigBlocks({ light_mode: false })).not.toThrow();
    expect(() => validateAgenCConfigBlocks({ light_mode: true })).not.toThrow();
    expect(() => validateAgenCConfigBlocks({ light_mode: "false" } as unknown as AgenCConfig)).toThrow(/light_mode/);
  });

  test.each(["user", "project"])("config.toml light_mode = false loads from the %s layer", async (layer) => {
    const root = mkdtempSync(join(tmpdir(), "agenc-light-mode-config-"));
    roots.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".agenc"), { recursive: true });
    const target = layer === "user" ? join(home, "config.toml") : join(project, ".agenc", "config.toml");
    writeFileSync(target, "config_version = 2\nlight_mode = false\n");
    const store = new ConfigStore({
      home,
      cwd: project,
      projectRoot: project,
      projectTrusted: true,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedDropInDir: join(root, "managed", "config.d"),
      env: { HOME: root },
    });
    const config = await store.reload();
    expect(config.light_mode).toBe(false);
    expect(withDefaultLightMode({ simpleMode: false }, config.light_mode).lightMode).toBe(false);
  });
});
