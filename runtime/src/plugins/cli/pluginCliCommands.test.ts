import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  defaultRunProcess,
  marketplaceInstalledPath,
  marketplaceIndexPath,
  marketplaceStoreRoot,
  writeMarketplaceIndex,
  type FetchResponse,
} from "../marketplace/marketplace.js";
import {
  formatAgenCPluginCliHelpText,
  parseAgenCPluginCliArgs,
  runAgenCPluginCli,
  type AgenCPluginCliOptions,
} from "./pluginCliCommands.js";
import type { PluginCliIo } from "./pluginOperations.js";

function createIo(): PluginCliIo & {
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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): FetchResponse {
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, "utf8");
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

async function tempRuntime(): Promise<{
  readonly root: string;
  readonly agencHome: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-cli-"));
  const agencHome = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  await mkdir(agencHome, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { root, agencHome, workspaceRoot };
}

async function writePlugin(root: string, name = "alpha"): Promise<string> {
  const pluginRoot = join(root, name);
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      description: "Test plugin",
      commands: "./commands",
    }, null, 2),
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), "# Hello\n");
  return pluginRoot;
}

function options(
  agencHome: string,
  workspaceRoot: string,
  io: PluginCliIo,
): AgenCPluginCliOptions {
  return {
    agencHome,
    workspaceRoot,
    io,
    now: () => new Date("2026-05-05T00:00:00.000Z"),
  };
}

describe("agenc plugin CLI", () => {
  it("documents marketplace source forms in help text", () => {
    const help = formatAgenCPluginCliHelpText();

    expect(help).toContain("marketplace add <path|git|url|github>");
    expect(help).toContain("Add local, git, URL, or GitHub marketplace");
  });

  it("parses plugin and marketplace commands", () => {
    expect(parseAgenCPluginCliArgs(["prompt"])).toBeNull();
    expect(parseAgenCPluginCliArgs(["plugin"])).toEqual({
      kind: "help",
      text: formatAgenCPluginCliHelpText(),
    });
    expect(parseAgenCPluginCliArgs(["plugin", "list", "--json"])).toEqual({
      kind: "list",
      json: true,
    });
    expect(parseAgenCPluginCliArgs([
      "plugin",
      "install",
      "./plugin",
      "--scope=project",
      "--name",
      "toolbox",
      "--force",
    ])).toEqual({
      kind: "install",
      source: "./plugin",
      scope: "project",
      name: "toolbox",
      force: true,
    });
    expect(parseAgenCPluginCliArgs([
      "plugin",
      "update",
      "toolbox",
      "--scope",
      "user",
      "--source=./plugin",
    ])).toEqual({
      kind: "update",
      pluginId: "toolbox",
      scope: "user",
      source: "./plugin",
    });
    expect(parseAgenCPluginCliArgs([
      "plugin",
      "install",
      "./plugin",
      "--name",
    ])).toEqual({
      kind: "error",
      message: "--name requires a value",
    });
    expect(parseAgenCPluginCliArgs([
      "plugin",
      "marketplace",
      "add",
      "./marketplace",
      "--name=team",
      "--ref",
      "main",
      "--sparse",
      "plugins",
    ])).toEqual({
      kind: "marketplace-add",
      source: "./marketplace",
      name: "team",
      ref: "main",
      sparse: "plugins",
      force: false,
    });
  });

  it("installs, lists, and disables a local plugin", async () => {
    const { agencHome, workspaceRoot, root } = await tempRuntime();
    const source = await writePlugin(root, "alpha");
    const io = createIo();
    const installExit = await runAgenCPluginCli({
      kind: "install",
      source,
      scope: "user",
      force: false,
    }, options(agencHome, workspaceRoot, io));
    expect(installExit).toBe(0);
    await expect(stat(join(agencHome, "plugins", "alpha", ".agenc-plugin", "plugin.json")))
      .resolves.toMatchObject({ size: expect.any(Number) });

    const listIo = createIo();
    const listExit = await runAgenCPluginCli({
      kind: "list",
      json: true,
    }, options(agencHome, workspaceRoot, listIo));
    expect(listExit).toBe(0);
    expect(JSON.parse(listIo.stdoutText())).toMatchObject({
      plugins: [{ name: "alpha", enabled: true }],
    });

    const disableIo = createIo();
    const disableExit = await runAgenCPluginCli({
      kind: "disable",
      pluginId: "alpha",
    }, options(agencHome, workspaceRoot, disableIo));
    expect(disableExit).toBe(0);
    expect(await readFile(join(agencHome, "config.toml"), "utf8"))
      .toContain("[plugins.plugins.\"alpha\"]\nenabled = false");

    const disabledListIo = createIo();
    await runAgenCPluginCli({
      kind: "list",
      json: true,
    }, options(agencHome, workspaceRoot, disabledListIo));
    expect(JSON.parse(disabledListIo.stdoutText())).toMatchObject({
      plugins: [{ name: "alpha", enabled: false }],
    });
  });

  it("adds, upgrades, lists, and removes a local marketplace", async () => {
    const { agencHome, workspaceRoot, root } = await tempRuntime();
    const marketplaceRoot = join(root, "marketplace");
    await mkdir(marketplaceRoot, { recursive: true });
    await writePlugin(marketplaceRoot, "alpha");
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "Team Marketplace" },
        plugins: [{ name: "alpha", source: "./alpha" }],
      }, null, 2),
    );

    const addIo = createIo();
    const addExit = await runAgenCPluginCli({
      kind: "marketplace-add",
      source: marketplaceRoot,
      name: "team",
      force: false,
    }, options(agencHome, workspaceRoot, addIo));
    expect(addExit).toBe(0);
    expect(addIo.stdoutText()).toContain("Added marketplace team");

    const listIo = createIo();
    await runAgenCPluginCli({
      kind: "marketplace-list",
      json: true,
    }, options(agencHome, workspaceRoot, listIo));
    expect(JSON.parse(listIo.stdoutText())).toMatchObject({
      marketplaces: [{ name: "team", sourceType: "local" }],
    });

    const upgradeIo = createIo();
    const upgradeExit = await runAgenCPluginCli({
      kind: "marketplace-upgrade",
      name: "team",
    }, options(agencHome, workspaceRoot, upgradeIo));
    expect(upgradeExit).toBe(0);
    expect(upgradeIo.stdoutText()).toContain("Upgraded 1 marketplace");

    const removeIo = createIo();
    const removeExit = await runAgenCPluginCli({
      kind: "marketplace-remove",
      name: "team",
    }, options(agencHome, workspaceRoot, removeIo));
    expect(removeExit).toBe(0);

    const emptyListIo = createIo();
    await runAgenCPluginCli({
      kind: "marketplace-list",
      json: true,
    }, options(agencHome, workspaceRoot, emptyListIo));
    expect(JSON.parse(emptyListIo.stdoutText())).toEqual({ marketplaces: [] });
  });

  it("adds URL and GitHub shorthand marketplaces through the CLI parser grammar", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const urlIo = createIo();
    const urlExit = await runAgenCPluginCli({
      kind: "marketplace-add",
      source: "http://127.0.0.1/marketplace.json",
      name: "url-team",
      force: false,
    }, {
      ...options(agencHome, workspaceRoot, urlIo),
      fetcher: async () => jsonResponse({
        metadata: { name: "url-team" },
        plugins: [],
      }),
      runProcess: async () => {
        throw new Error("git should not run for URL marketplaces");
      },
    });
    expect(urlExit).toBe(0);
    expect(urlIo.stdoutText()).toContain("Added marketplace url-team");

    const cloneCalls: string[][] = [];
    const gitIo = createIo();
    const gitExit = await runAgenCPluginCli({
      kind: "marketplace-add",
      source: "agenc-org/plugins#stable",
      name: "github-team",
      force: false,
    }, {
      ...options(agencHome, workspaceRoot, gitIo),
      runProcess: async (_command, args) => {
        if (args[0] === "clone") {
          cloneCalls.push([...args]);
          const target = args.at(-1);
          if (target === undefined) throw new Error("missing clone target");
          await mkdir(target, { recursive: true });
          await writeFile(
            join(target, "marketplace.json"),
            JSON.stringify({ metadata: { name: "github-team" }, plugins: [] }),
          );
        }
        if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });
    expect(gitExit).toBe(0);
    expect(cloneCalls[0]).toContain("https://github.com/agenc-org/plugins.git");
    expect(cloneCalls[0]).toContain("stable");
    const repositorySeparator = cloneCalls[0]!.indexOf("--");
    expect(repositorySeparator).toBeGreaterThan(-1);
    expect(cloneCalls[0]![repositorySeparator + 1]).toBe("https://github.com/agenc-org/plugins.git");
  });

  it("updates an installed plugin from its recorded source", async () => {
    const { agencHome, workspaceRoot, root } = await tempRuntime();
    const source = await writePlugin(root, "alpha");
    const installIo = createIo();
    await runAgenCPluginCli({
      kind: "install",
      source,
      scope: "user",
      force: false,
    }, options(agencHome, workspaceRoot, installIo));

    await writeFile(
      join(source, ".agenc-plugin", "plugin.json"),
      JSON.stringify({
        name: "alpha",
        version: "2.0.0",
        description: "Updated plugin",
        commands: "./commands",
      }, null, 2),
    );

    const updateIo = createIo();
    const updateExit = await runAgenCPluginCli({
      kind: "update",
      pluginId: "alpha",
      scope: "user",
    }, options(agencHome, workspaceRoot, updateIo));
    expect(updateExit).toBe(0);

    const listIo = createIo();
    await runAgenCPluginCli({
      kind: "list",
      json: true,
    }, options(agencHome, workspaceRoot, listIo));
    expect(JSON.parse(listIo.stdoutText())).toMatchObject({
      plugins: [{ name: "alpha", version: "2.0.0" }],
    });
  });

  it("rejects unsafe marketplace names and sparse paths before mutating", async () => {
    const { agencHome, workspaceRoot, root } = await tempRuntime();
    const marketplaceRoot = join(root, "marketplace");
    await mkdir(marketplaceRoot, { recursive: true });
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({ metadata: { name: "bad/name" }, plugins: [] }),
    );

    const nameIo = createIo();
    const nameExit = await runAgenCPluginCli({
      kind: "marketplace-add",
      source: marketplaceRoot,
      force: false,
    }, options(agencHome, workspaceRoot, nameIo));
    expect(nameExit).toBe(1);
    expect(nameIo.stderrText()).toContain("marketplace name must be an alphanumeric segment");

    const sparseIo = createIo();
    const sparseExit = await runAgenCPluginCli({
      kind: "marketplace-add",
      source: "repo.git",
      name: "team",
      sparse: "../marketplace",
      force: false,
    }, {
      ...options(agencHome, workspaceRoot, sparseIo),
      runProcess: async () => {
        throw new Error("git should not run for invalid sparse paths");
      },
    });
    expect(sparseExit).toBe(1);
    expect(sparseIo.stderrText()).toContain("--sparse must not contain");
  });

  it("rejects leading-dash git marketplace CLI sources before spawning git", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const io = createIo();

    const exitCode = await runAgenCPluginCli({
      kind: "marketplace-add",
      source: "--upload-pack=x.git",
      name: "team",
      force: false,
    }, {
      ...options(agencHome, workspaceRoot, io),
      runProcess: async () => {
        throw new Error("git should not run for unsafe leading-dash sources");
      },
    });

    expect(exitCode).toBe(1);
    expect(io.stderrText()).toContain("must not start with '-'");
  });

  it("removes marketplaces by computed install root instead of trusted index paths", async () => {
    const { agencHome, workspaceRoot, root } = await tempRuntime();
    const io = createIo();
    await mkdir(marketplaceStoreRoot({ agencHome }), { recursive: true });
    const installedPath = marketplaceInstalledPath("team", { agencHome });
    const hostilePath = join(root, "outside");
    await mkdir(installedPath, { recursive: true });
    await mkdir(hostilePath, { recursive: true });
    await writeMarketplaceIndex({
      version: 1,
      marketplaces: {
        team: {
          name: "team",
          source: "local",
          sourceType: "local",
          sourceDescriptor: { source: "local", path: installedPath },
          installedPath: hostilePath,
          manifestPath: join(hostilePath, "marketplace.json"),
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
      },
    }, { agencHome });

    const removeExit = await runAgenCPluginCli({
      kind: "marketplace-remove",
      name: "team",
    }, options(agencHome, workspaceRoot, io));
    expect(removeExit).toBe(0);
    expect((await stat(hostilePath)).isDirectory()).toBe(true);
    await expect(stat(installedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(marketplaceIndexPath({ agencHome }), "utf8")))
      .toEqual({ version: 1, marketplaces: {} });
  });

  it("redacts credential-bearing git failures", async () => {
    await expect(defaultRunProcess(process.execPath, [
      "-e",
      "process.stderr.write('https://token@agenc.tech/repo?token=secret'); process.exit(2)",
    ], {
      timeoutMs: 1_000,
      maxOutputBytes: 512,
    })).rejects.toThrow("https://<redacted>@agenc.tech/repo?token=<redacted>");
  });
});
