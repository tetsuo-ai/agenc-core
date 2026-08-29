import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  rollbackConfigV2Migration,
} from "../../src/config/migration.js";

const temporaryDirectories: string[] = [];

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "agenc-mcp-json-migration-"));
  temporaryDirectories.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function json(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function migrationOptions(root: string, cwd: string, id: string) {
  return {
    env: {},
    home: join(root, "home"),
    cwd,
    projectRoot: join(root, "project"),
    managedConfigPath: join(root, "managed", "config.toml"),
    managedSettingsPath: join(root, "managed", "managed-settings.json"),
    globalStatePath: join(root, "missing-global-state.json"),
    id,
  } as const;
}

describe("retired MCP JSON authority migration", () => {
  test("converts every in-project and managed server, archives sources, and rolls back", async () => {
    const root = temp();
    const project = join(root, "project");
    const cwd = join(project, "packages", "app");
    const projectSource = join(project, ".mcp.json");
    const nestedSource = join(cwd, ".mcp.json");
    const managedSource = join(root, "managed", "managed-mcp.json");
    const projectTarget = join(project, ".agenc", "config.toml");
    const managedTarget = join(root, "managed", "config.toml");
    mkdirSync(cwd, { recursive: true });

    json(projectSource, {
      mcpServers: {
        local: {
          command: "npx",
          args: ["-y", "@example/mcp"],
          env: { MODE: "readonly" },
          default_tools_approval_mode: "on-request",
          tools: { inspect: { default_permission_mode: "never" } },
        },
      },
    });
    json(nestedSource, {
      mcpServers: {
        socket: {
          type: "ws",
          url: "wss://mcp.example.test/socket",
          headers: { Authorization: "${MCP_TOKEN}" },
          required: true,
        },
      },
    });
    json(managedSource, {
      mcpServers: {
        policy: {
          type: "http",
          url: "https://mcp.example.test/api",
          enabled_tools: ["search"],
        },
      },
    });

    const options = migrationOptions(root, cwd, "mcp-json-success");
    const plan = await checkConfigV2Migration(options);

    expect(plan.conflicts).toEqual([]);
    expect(plan.archivePaths).toEqual(expect.arrayContaining([
      projectSource,
      nestedSource,
      managedSource,
    ]));
    expect(plan.writes.map((item) => item.targetPath)).toEqual(
      expect.arrayContaining([projectTarget, managedTarget]),
    );
    const projectConfig = parseToml(
      plan.writes.find((item) => item.targetPath === projectTarget)?.content ?? "",
    );
    expect(projectConfig).toMatchObject({
      config_version: 2,
      mcp_servers: {
        local: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@example/mcp"],
          env: { MODE: "readonly" },
          default_tools_approval_mode: "on-request",
          tools: { inspect: { default_permission_mode: "never" } },
        },
        socket: {
          transport: "websocket",
          endpoint: "wss://mcp.example.test/socket",
          headers: { Authorization: "${MCP_TOKEN}" },
          required: true,
        },
      },
    });
    expect(parseToml(
      plan.writes.find((item) => item.targetPath === managedTarget)?.content ?? "",
    )).toMatchObject({
      config_version: 2,
      mcp_servers: {
        policy: {
          transport: "http",
          endpoint: "https://mcp.example.test/api",
          enabled_tools: ["search"],
        },
      },
    });

    await applyConfigV2Migration(plan);
    for (const source of [projectSource, nestedSource, managedSource]) {
      expect(existsSync(source)).toBe(false);
      expect(existsSync(`${source}.migrated-v2-mcp-json-success`)).toBe(true);
    }
    expect(parseToml(readFileSync(projectTarget, "utf8"))).toMatchObject(
      projectConfig,
    );

    await rollbackConfigV2Migration("mcp-json-success", {
      env: {},
      home: join(root, "home"),
    });
    for (const source of [projectSource, nestedSource, managedSource]) {
      expect(existsSync(source)).toBe(true);
      expect(existsSync(`${source}.migrated-v2-mcp-json-success`)).toBe(false);
    }
    expect(existsSync(projectTarget)).toBe(false);
    expect(existsSync(managedTarget)).toBe(false);
  });

  test("merges equal definitions but blocks conflicting canonical definitions", async () => {
    const root = temp();
    const project = join(root, "project");
    const source = join(project, ".mcp.json");
    const target = join(project, ".agenc", "config.toml");
    mkdirSync(project, { recursive: true });
    write(target, [
      "config_version = 2",
      "[mcp_servers.shared]",
      'transport = "http"',
      'endpoint = "https://canonical.example.test/mcp"',
      "",
    ].join("\n"));
    json(source, {
      mcpServers: {
        shared: {
          type: "http",
          url: "https://retired.example.test/mcp",
        },
      },
    });

    const plan = await checkConfigV2Migration(
      migrationOptions(root, project, "mcp-json-conflict"),
    );

    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      field: "mcp_servers.shared.endpoint",
      sourcePath: source,
      reason: expect.stringMatching(/refuses to choose/u),
    }));
    expect(plan.writes).toEqual([]);
  });

  test("blocks unsupported JSON features instead of silently dropping them", async () => {
    const root = temp();
    const project = join(root, "project");
    const source = join(project, ".mcp.json");
    mkdirSync(project, { recursive: true });
    json(source, {
      mcpServers: {
        oauth: {
          type: "http",
          url: "https://mcp.example.test/api",
          oauth: { clientId: "client" },
        },
        internal: { type: "sdk", name: "internal" },
      },
      futureAuthority: true,
    });

    const plan = await checkConfigV2Migration(
      migrationOptions(root, project, "mcp-json-unsupported"),
    );

    expect(plan.conflicts.map((item) => item.field)).toEqual(
      expect.arrayContaining([
        "mcpServers.oauth",
        "mcpServers.internal.type",
      ]),
    );
    expect(plan.conflicts.map((item) => item.reason).join("\n")).toMatch(
      /unsupported top-level fields|no lossless canonical TOML transform|unsupported MCP transport/u,
    );
    expect(plan.writes).toEqual([]);
  });

  test("blocks ancestor JSON outside the selected project root", async () => {
    const root = temp();
    const project = join(root, "workspace", "project");
    const cwd = join(project, "src");
    const ancestorSource = join(root, ".mcp.json");
    mkdirSync(cwd, { recursive: true });
    json(ancestorSource, {
      mcpServers: { inherited: { command: "mcp-server" } },
    });

    const options = {
      ...migrationOptions(root, cwd, "mcp-json-ancestor"),
      projectRoot: project,
    };
    const plan = await checkConfigV2Migration(options);

    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      sourcePath: ancestorSource,
      field: "mcpServers",
      reason: expect.stringMatching(/outside the canonical project root/u),
    }));
    expect(plan.archivePaths).not.toContain(ancestorSource);
    expect(plan.writes).toEqual([]);
  });
});
