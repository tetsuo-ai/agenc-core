import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ConfigStore } from "../../config/store.js";
import {
  isProjectTrustedSync,
  trustProjectSync,
} from "../../permissions/trust/project-trust.js";
import { resolveSessionMcpConfig } from "../../session/mcp-startup.js";
import {
  addMcpConfig,
  getMcpConfigByName,
  getMcpConfigsByScope,
  hasManagedMcpAuthority,
  isMcpServerDisabled,
  removeMcpConfig,
} from "./config.js";
import {
  addUserMcpServerToToml,
  getUserMcpConfigsFromToml,
  removeUserMcpServerFromToml,
} from "./user-config-toml.js";

const originalEnv = {
  AGENC_HOME: process.env.AGENC_HOME,
  HOME: process.env.HOME,
};

let agencHome: string;
let configStore: ConfigStore;

beforeEach(async () => {
  agencHome = await mkdtemp(join(tmpdir(), "agenc-mcp-config-"));
  process.env.AGENC_HOME = agencHome;
  process.env.HOME = agencHome;
  configStore = new ConfigStore({
    home: agencHome,
    env: { AGENC_HOME: agencHome, HOME: agencHome },
    cwd: agencHome,
    projectRoot: agencHome,
    projectTrusted: true,
    managedConfigPath: join(agencHome, "missing-managed.toml"),
    managedDropInDir: join(agencHome, "missing-managed.d"),
  });
  await configStore.reload();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

async function readConfigToml(): Promise<string> {
  return readFile(join(agencHome, "config.toml"), "utf8");
}

describe("MCP config TOML namespace", () => {
  test("uses the canonical MCP server-name contract for persisted additions", async () => {
    await expect(
      addMcpConfig(
        "plugin:sample:local",
        { type: "stdio", command: "plugin-mcp", args: [] },
        "user",
        configStore,
      ),
    ).resolves.toBeUndefined();
    expect(configStore.current().mcp_servers).toHaveProperty(
      "plugin:sample:local",
    );

    for (const name of [
      "bad.name",
      "bad name",
      "bad\nname",
      "a".repeat(257),
    ]) {
      await expect(
        addMcpConfig(
          name,
          { type: "stdio", command: "bad-mcp", args: [] },
          "user",
          configStore,
        ),
      ).rejects.toThrow(/Invalid MCP server name/u);
    }
  });

  test("user-scoped stdio servers are written to mcp_servers and loaded by session startup", async () => {
    await addUserMcpServerToToml(
      "github",
      {
        type: "stdio",
        command: "gh-mcp",
        args: ["--stdio"],
        env: { GITHUB_TOKEN: "token" },
      },
      configStore,
    );

    const toml = await readConfigToml();
    expect(toml).toContain('"config_version" = 2');
    expect(toml).toContain('["mcp_servers"."github"]');
    expect(toml).toContain('"command" = "gh-mcp"');
    expect(toml).not.toContain("mcpServers");

    const runtimeConfigs = await resolveSessionMcpConfig(
      configStore,
      {},
      join(agencHome, "plugins"),
    );
    expect(runtimeConfigs).toEqual([
      {
        name: "github",
        transport: "stdio",
        command: "gh-mcp",
        args: ["--stdio"],
        env: { GITHUB_TOKEN: "token" },
        origin: { scope: "user" },
      },
    ]);
  });

  test("remote servers are persisted with endpoint for the live MCP manager", async () => {
    await addUserMcpServerToToml(
      "docs",
      {
        type: "http",
        url: "https://agenc.tech/mcp",
        headers: { Authorization: "Bearer token" },
      },
      configStore,
    );

    expect(configStore.current().mcp_servers?.docs).toMatchObject({
      transport: "http",
      endpoint: "https://agenc.tech/mcp",
      headers: { Authorization: "Bearer token" },
    });
    expect((await resolveSessionMcpConfig(
      configStore,
      {},
      join(agencHome, "plugins"),
    ))[0]).toMatchObject({
      name: "docs",
      transport: "http",
      endpoint: "https://agenc.tech/mcp",
      origin: { scope: "user" },
    });

    const scoped = getUserMcpConfigsFromToml(configStore);
    expect(scoped.errors).toEqual([]);
    expect(scoped.servers.docs).toMatchObject({
      scope: "user",
      type: "http",
      url: "https://agenc.tech/mcp",
    });
  });

  test("persists the internal ws service discriminant as canonical websocket", async () => {
    await addUserMcpServerToToml(
      "socket",
      {
        type: "ws",
        url: "wss://agenc.tech/mcp",
      },
      configStore,
    );

    expect(configStore.current().mcp_servers?.socket).toMatchObject({
      transport: "websocket",
      endpoint: "wss://agenc.tech/mcp",
    });
    expect((await resolveSessionMcpConfig(
      configStore,
      {},
      join(agencHome, "plugins"),
    ))[0]).toMatchObject({
      name: "socket",
      transport: "websocket",
    });

    expect(getUserMcpConfigsFromToml(configStore).servers.socket).toMatchObject({
      type: "ws",
      url: "wss://agenc.tech/mcp",
    });
  });

  test("remove deletes user-scoped servers from canonical mcp_servers", async () => {
    await addUserMcpServerToToml(
      "github",
      { type: "stdio", command: "gh-mcp", args: [] },
      configStore,
    );
    await removeUserMcpServerFromToml("github", configStore);

    expect(configStore.current().mcp_servers?.github).toBeUndefined();
    await expect(resolveSessionMcpConfig(
      configStore,
      {},
      join(agencHome, "plugins"),
    )).resolves.toEqual([]);
  });

  test("project MCP definitions read and write only canonical project config.toml", async () => {
    await addMcpConfig(
      "project_docs",
      {
        type: "http",
        url: "https://project.example.test/mcp",
      },
      "project",
      configStore,
    );

    const projectPath = join(agencHome, ".agenc", "config.toml");
    const toml = await readFile(projectPath, "utf8");
    expect(toml).toContain('["mcp_servers"."project_docs"]');
    expect(toml).toContain('"endpoint" = "https://project.example.test/mcp"');
    await expect(access(join(agencHome, ".mcp.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      getMcpConfigsByScope("project", configStore).servers.project_docs,
    ).toMatchObject({
      scope: "project",
      type: "http",
      url: "https://project.example.test/mcp",
    });
  });

  test("an explicit managed mcp_servers table is exclusive even when empty", async () => {
    await addUserMcpServerToToml(
      "user_docs",
      { type: "stdio", command: "user-docs", args: [] },
      configStore,
    );
    const managedPath = join(agencHome, "managed.toml");
    await writeFile(
      managedPath,
      ["config_version = 2", "[mcp_servers]", ""].join("\n"),
      { mode: 0o600 },
    );
    const managedStore = new ConfigStore({
      home: agencHome,
      env: { AGENC_HOME: agencHome, HOME: agencHome },
      cwd: agencHome,
      projectRoot: agencHome,
      projectTrusted: true,
      managedConfigPath: managedPath,
      managedDropInDir: join(agencHome, "missing-managed.d"),
    });
    await managedStore.reload();

    expect(hasManagedMcpAuthority(managedStore)).toBe(true);
    expect(getMcpConfigByName("user_docs", managedStore)).toBeNull();
    await expect(
      addMcpConfig(
        "blocked",
        { type: "stdio", command: "blocked", args: [] },
        "user",
        managedStore,
      ),
    ).rejects.toThrow("canonical managed config.toml has exclusive MCP authority");
  });

  test("local MCP definitions and enabled policy come only from canonical config.local.toml", async () => {
    const localConfigDir = join(agencHome, ".agenc");
    await mkdir(localConfigDir, { recursive: true });
    await writeFile(
      join(localConfigDir, "config.local.toml"),
      [
        "config_version = 2",
        '[mcp_servers.untrusted_probe]',
        'transport = "stdio"',
        'command = "probe"',
        "",
      ].join("\n"),
    );
    const store = new ConfigStore({
      home: agencHome,
      env: { AGENC_HOME: agencHome, HOME: agencHome },
      cwd: agencHome,
      projectRoot: agencHome,
      managedConfigPath: join(agencHome, "missing-managed.toml"),
      managedDropInDir: join(agencHome, "missing-managed.d"),
    });
    await store.reload();
    expect(getMcpConfigsByScope("local", store).servers).toEqual({});

    trustProjectSync({ agencHome, projectRoot: agencHome });
    expect(isProjectTrustedSync({ agencHome, projectRoot: agencHome })).toBe(true);
    await store.reload();
    expect(store.sources("local")).toHaveLength(1);
    expect(getMcpConfigsByScope("local", store).servers.untrusted_probe).toMatchObject({
      command: "probe",
      scope: "local",
    });
    await addMcpConfig(
      "local_docs",
      {
        type: "stdio",
        command: "local-docs",
        args: [],
        enabled: false,
      },
      "local",
      store,
    );

    const local = getMcpConfigsByScope("local", store);
    expect(local.errors).toEqual([]);
    expect(local.servers.local_docs).toMatchObject({
      scope: "local",
      type: "stdio",
      command: "local-docs",
      enabled: false,
    });
    expect(
      isMcpServerDisabled("local_docs", local.servers.local_docs),
    ).toBe(true);
    expect(
      await readFile(join(localConfigDir, "config.local.toml"), "utf8"),
    ).not.toContain("mcpServers");

    await removeMcpConfig("local_docs", "local", store);
    expect(getMcpConfigsByScope("local", store).servers.local_docs).toBeUndefined();
    await removeMcpConfig("untrusted_probe", "local", store);
    expect(getMcpConfigsByScope("local", store).servers).toEqual({});
  });
});
