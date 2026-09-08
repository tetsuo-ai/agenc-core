import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadXml } from "cheerio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installGatewayService } from "../../src/bin/gateway-cli.js";

type ServicePlatform = "linux" | "darwin";

describe("gateway service executable paths", () => {
  let home: string;
  let commands: string[][];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-service-paths-"));
    commands = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function definitionPath(platform: ServicePlatform): string {
    return platform === "linux"
      ? join(home, ".config/systemd/user/agenc-gateway.service")
      : join(home, "Library/LaunchAgents/dev.agenc.gateway.plist");
  }

  function install(platform: ServicePlatform, execPath: string, entryPath?: string): Promise<number> {
    return installGatewayService({
      platform, home, agencHome: join(home, "state"), execPath, entryPath,
      stdout: () => undefined,
      stderr: () => undefined,
      runCommand: (command, args) => { commands.push([command, ...args]); return true; },
    });
  }

  function serviceArguments(platform: ServicePlatform): string[] {
    const definition = readFileSync(definitionPath(platform), "utf8");
    if (platform === "linux") {
      const entries = definition.split("\n").filter(line => line.startsWith("ExecStart="));
      expect(entries).toHaveLength(1);
      const prefix = "ExecStart=:/usr/bin/env ";
      expect(entries[0]!.startsWith(prefix)).toBe(true);
      const encoded = entries[0]!.slice(prefix.length);
      const values = encoded.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
      expect(values.join(" ")).toBe(encoded);
      const decoded = values.map(value => (JSON.parse(value) as string).replaceAll("%%", "%"));
      expect(decoded.shift()).toBe("--");
      return decoded;
    }
    const document = loadXml(definition, { xmlMode: true });
    const array = document("plist > dict > key").filter((_, key) =>
      document(key).text() === "ProgramArguments",
    ).next("array");
    expect(array).toHaveLength(1);
    expect(array.children()).toHaveLength(4);
    return array.children("string").map((_, value) => document(value).text()).get();
  }

  for (const platform of ["linux", "darwin"] as const) {
    it.each(["space path", 'double "quote"', "single 'quote'", "back\\slash", "%h %n %%", "$HOME ${TOKEN} $$", "a & <path>", "学習 😀", "semi ; colon"])(
      `${platform} preserves executable and entry arguments (%s)`, async suffix => {
        const executable = `/opt/${suffix}/node`;
        const entry = `/opt/${suffix}/agenc.js`;
        expect(await install(platform, executable, entry)).toBe(0);
        expect(serviceArguments(platform)).toEqual([executable, entry, "gateway", "run"]);
        expect(commands).toHaveLength(platform === "linux" ? 2 : 1);
      },
    );

    for (const field of ["executable", "entrypoint"] as const) {
      it.each(["", "relative/file", "../file", "/", "/directory/", "/line\nbreak", "/carriage\rreturn", "/tab\tpath", "/null\0path", "/\ud800", "/\ufffe"])(
        `${platform} rejects unsafe ${field} paths before writing or starting a service (%j)`, async value => {
          const executable = field === "executable" ? value : "/usr/bin/node";
          const entry = field === "entrypoint" ? value : "/opt/agenc/agenc.js";
          await expect(install(platform, executable, entry)).rejects.toThrow(/Cannot install gateway service/);
          expect(existsSync(definitionPath(platform))).toBe(false);
          expect(commands).toEqual([]);
        },
      );
    }

    it(`${platform} rejects a missing process entrypoint without replacing an existing service`, async () => {
      expect(await install(platform, "/usr/bin/node", "/opt/agenc/agenc.js")).toBe(0);
      const original = readFileSync(definitionPath(platform), "utf8");
      commands = [];
      const originalArgv = process.argv;
      try {
        process.argv = [process.execPath];
        await expect(install(platform, "/usr/bin/node")).rejects.toThrow(/entrypoint/);
      } finally {
        process.argv = originalArgv;
      }
      expect(readFileSync(definitionPath(platform), "utf8")).toBe(original);
      expect(commands).toEqual([]);
    });

    it(`${platform} launches the decoded command with exact executable and entry argv`, async () => {
      const directory = join(home, 'space %h %% $HOME ${TOKEN} & <xml> "quote" \\slash 学習');
      mkdirSync(directory, { mode: 0o700 });
      const executable = join(directory, "node");
      const entry = join(directory, "entry 'single'.cjs");
      symlinkSync(process.execPath, executable);
      writeFileSync(entry, 'process.stdout.write(JSON.stringify({argv0:process.argv0,argv:process.argv.slice(1)}));\n', { mode: 0o600 });
      expect(await install(platform, executable, entry)).toBe(0);
      const argv = serviceArguments(platform);
      const command = platform === "linux" ? "/usr/bin/env" : argv.shift()!;
      const args = platform === "linux" ? ["--", ...argv] : argv;
      const result = spawnSync(command, args, {
        env: { HOME: home, AGENC_HOME: join(home, "state") },
        encoding: "utf8", timeout: 10_000,
      });
      expect(result.status, `${result.error ?? ""}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ argv0: executable, argv: [entry, "gateway", "run"] });
    });
  }
});
