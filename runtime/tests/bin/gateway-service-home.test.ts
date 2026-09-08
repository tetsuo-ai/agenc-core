import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadXml } from "cheerio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgenCDaemonSocketPath } from "../../src/app-server/daemon-cli.js";
import { installGatewayService } from "../../src/bin/gateway-cli.js";
import { resolveAgencHome } from "../../src/config/env.js";
import { canonicalizeHomePath } from "../../src/config/home.js";
import { serializeConfigToml } from "../../src/config/serialize.js";
import { PairingStore } from "../../src/gateway/pairing.js";

type ServicePlatform = "linux" | "darwin";

describe("gateway service home persistence", () => {
  let home: string;
  let commands: string[][];
  let previousKey: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-service-home-"));
    commands = [];
    previousKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "service-must-not-copy-this-key";
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
    rmSync(home, { recursive: true, force: true });
  });

  function definitionPath(platform: ServicePlatform): string {
    return platform === "linux"
      ? join(home, ".config/systemd/user/agenc-gateway.service")
      : join(home, "Library/LaunchAgents/dev.agenc.gateway.plist");
  }

  function install(platform: ServicePlatform, agencHome: string): Promise<number> {
    return installGatewayService({
      platform, home, agencHome,
      execPath: "/usr/bin/node",
      entryPath: "/opt/agenc/bin/agenc.js",
      stdout: () => undefined,
      stderr: () => undefined,
      runCommand: (command, args) => { commands.push([command, ...args]); return true; },
    });
  }

  function serviceEnvironment(platform: ServicePlatform): Record<string, string> {
    const definition = readFileSync(definitionPath(platform), "utf8");
    expect(definition).not.toContain("service-must-not-copy-this-key");
    expect(definition).not.toContain("XAI_API_KEY");
    expect(definition).not.toContain("EnvironmentFile=");
    if (platform === "linux") {
      const entries = definition.split("\n").filter(line => line.startsWith("Environment="));
      expect(entries).toHaveLength(1);
      const assignment = JSON.parse(entries[0]!.slice("Environment=".length)).replaceAll("%%", "%") as string;
      expect(assignment.startsWith("AGENC_HOME=")).toBe(true);
      return { AGENC_HOME: assignment.slice("AGENC_HOME=".length) };
    }
    const document = loadXml(definition, { xmlMode: true });
    const dictionary = document("plist > dict > key").filter((_, key) =>
      document(key).text() === "EnvironmentVariables",
    ).next("dict");
    expect(dictionary).toHaveLength(1);
    const keys = dictionary.children("key");
    expect(keys.map((_, key) => document(key).text()).get()).toEqual(["AGENC_HOME"]);
    return { AGENC_HOME: keys.next("string").text() };
  }

  for (const platform of ["linux", "darwin"] as const) {
    it.each(["alternate", "space = home", 'quoted "home" and \'single\'', "%h %n %% $HOME ${TOKEN}", "a & <home>", "学習 😀"])(
      `${platform} preserves the canonical selected home (%s)`, async (suffix) => {
        const selected = join(home, suffix);
        expect(await install(platform, selected)).toBe(0);
        expect(serviceEnvironment(platform)).toEqual({ AGENC_HOME: canonicalizeHomePath(selected) });
        expect(commands).toHaveLength(platform === "linux" ? 2 : 1);
      },
    );

    it(`${platform} preserves a selected default home`, async () => {
      const selected = resolveAgencHome({ HOME: home });
      expect(await install(platform, selected)).toBe(0);
      expect(serviceEnvironment(platform)).toEqual({ AGENC_HOME: selected });
    });

    it(`${platform} records the physical parent of a home that does not exist yet`, async () => {
      const parent = join(home, "physical");
      const alias = join(home, "alias");
      mkdirSync(parent, { mode: 0o700 });
      symlinkSync(parent, alias, "junction");
      expect(await install(platform, join(alias, "future-home"))).toBe(0);
      expect(serviceEnvironment(platform)).toEqual({ AGENC_HOME: join(canonicalizeHomePath(parent), "future-home") });
    });

    it(`${platform} launches a new process with the selected config, pairing store and socket identity`, async () => {
      const selected = join(home, "alternate");
      mkdirSync(selected, { mode: 0o700 });
      writeFileSync(join(selected, "config.toml"), serializeConfigToml({
        config_version: 2,
        gateway: { defaultAgent: "selected-home-agent", channels: { tg: { dmPolicy: "pairing", allowlist: [] } } },
      }), { mode: 0o600 });
      const pairing = new PairingStore({ agencHome: selected });
      await pairing.approve("tg", "selected-peer");
      expect(pairing.isPaired("tg", "selected-peer")).toBe(true);
      expect(await install(platform, selected)).toBe(0);
      const environment = { HOME: home, ...serviceEnvironment(platform) };
      const runtimeRoot = join(import.meta.dirname, "../..");
      const child = spawnSync(process.execPath, [
        "--import", "tsx", join(import.meta.dirname, "fixtures/gateway-service-home.mjs"),
      ], {
        cwd: runtimeRoot,
        env: { ...environment, PATH: process.env.PATH, TSX_TSCONFIG_PATH: join(runtimeRoot, "tsconfig.json") },
        encoding: "utf8", timeout: 15_000,
      });
      expect(child.status, `${child.error ?? ""}\n${child.stderr}`).toBe(0);
      const report = JSON.parse(child.stdout);
      expect(report.home).toBe(canonicalizeHomePath(selected));
      expect(report.socket).toBe(resolveAgenCDaemonSocketPath({ AGENC_HOME: selected, HOME: home }));
      expect(report.socket).not.toBe(resolveAgenCDaemonSocketPath({ HOME: home }));
      expect(report.status.defaultAgent).toBe("selected-home-agent");
      expect(report.status.channels).toContainEqual(expect.objectContaining({ channelId: "tg", pairedCount: 1 }));
    });

    it.each(["line\nbreak", "carriage\rreturn", "tab\tpath", "null\0path", "\ud800", "\ufffe"])(
      `${platform} rejects unrepresentable homes before writing or starting a service (%j)`, async (suffix) => {
        await expect(install(platform, join(home, suffix))).rejects.toThrow(/AGENC_HOME/);
        expect(existsSync(definitionPath(platform))).toBe(false);
        expect(commands).toEqual([]);
      },
    );

    it(`${platform} leaves an existing service unchanged when the new home is invalid`, async () => {
      expect(await install(platform, join(home, "original"))).toBe(0);
      const original = readFileSync(definitionPath(platform), "utf8");
      commands = [];
      await expect(install(platform, join(home, "bad\nhome"))).rejects.toThrow(/AGENC_HOME/);
      expect(readFileSync(definitionPath(platform), "utf8")).toBe(original);
      expect(commands).toEqual([]);
    });
  }

  it("systemd quotes backslashes and percent specifiers without expanding dollar signs", async () => {
    const selected = join(home, 'literal\\name %h $HOME "value"');
    expect(await install("linux", selected)).toBe(0);
    const definition = readFileSync(definitionPath("linux"), "utf8");
    expect(definition).toContain('\\\\name %%h $HOME \\"value\\"');
    expect(serviceEnvironment("linux").AGENC_HOME).toBe(canonicalizeHomePath(selected));
  });

  it("launchd escapes XML text instead of introducing plist elements", async () => {
    expect(await install("darwin", join(home, "a & <home>"))).toBe(0);
    const definition = readFileSync(definitionPath("darwin"), "utf8");
    expect(definition).toContain("a &amp; &lt;home&gt;");
    const document = loadXml(definition, { xmlMode: true });
    expect(document("home")).toHaveLength(0);
  });
});
