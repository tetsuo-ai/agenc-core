import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadConfig } from "../../config/loader.js";
import { getMcpConfigFromConfig } from "../../session/mcp-startup.js";
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

beforeEach(async () => {
  agencHome = await mkdtemp(join(tmpdir(), "agenc-mcp-config-"));
  process.env.AGENC_HOME = agencHome;
  process.env.HOME = agencHome;
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
  test("user-scoped stdio servers are written to mcp_servers and loaded by session startup", async () => {
    await addUserMcpServerToToml(
      "github",
      {
        type: "stdio",
        command: "gh-mcp",
        args: ["--stdio"],
        env: { GITHUB_TOKEN: "token" },
      },
    );

    const toml = await readConfigToml();
    expect(toml).toContain('["mcp_servers"."github"]');
    expect(toml).toContain('"command" = "gh-mcp"');
    expect(toml).not.toContain("mcpServers");

    const loaded = await loadConfig({ home: agencHome });
    const runtimeConfigs = getMcpConfigFromConfig(loaded.config);
    expect(runtimeConfigs).toEqual([
      {
        name: "github",
        transport: "stdio",
        command: "gh-mcp",
        args: ["--stdio"],
        env: { GITHUB_TOKEN: "token" },
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
    );

    const loaded = await loadConfig({ home: agencHome });
    expect(loaded.config.mcp_servers?.docs).toMatchObject({
      transport: "http",
      endpoint: "https://agenc.tech/mcp",
      headers: { Authorization: "Bearer token" },
    });
    expect(getMcpConfigFromConfig(loaded.config)[0]).toMatchObject({
      name: "docs",
      transport: "http",
      endpoint: "https://agenc.tech/mcp",
    });

    const scoped = getUserMcpConfigsFromToml();
    expect(scoped.errors).toEqual([]);
    expect(scoped.servers.docs).toMatchObject({
      scope: "user",
      type: "http",
      url: "https://agenc.tech/mcp",
    });
  });

  test("remove deletes user-scoped servers from canonical mcp_servers", async () => {
    await addUserMcpServerToToml(
      "github",
      { type: "stdio", command: "gh-mcp", args: [] },
    );
    await removeUserMcpServerFromToml("github");

    const loaded = await loadConfig({ home: agencHome });
    expect(loaded.config.mcp_servers?.github).toBeUndefined();
    expect(getMcpConfigFromConfig(loaded.config)).toEqual([]);
  });

  test("addMcpConfig rejects local scope because it is not loaded by session startup", async () => {
    const source = await readFile(
      join(process.cwd(), "src/services/mcp/config.ts"),
      "utf8",
    );
    expect(source).toContain("scope === 'local'");
    expect(source).toContain("local MCP config is not loaded by the runtime");
  });

});
