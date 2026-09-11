import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SecureStorageData } from "../../../src/utils/secureStorage/index.js";

const credentials = vi.hoisted(() => new Map<string, SecureStorageData>());
vi.mock("../../../src/utils/secureStorage/native.js", () => ({
  readNativeSecureStorage: (home: { path: string }) => structuredClone(credentials.get(home.path) ?? {}),
  readNativeSecureStorageFresh: (home: { path: string }) => structuredClone(credentials.get(home.path) ?? {}),
  updateNativeSecureStorage: (home: { path: string }, update: (value: SecureStorageData) => SecureStorageData) => {
    const previous = structuredClone(credentials.get(home.path) ?? {}); const written = update(previous);
    credentials.set(home.path, structuredClone(written)); return { previous, written };
  },
}));

import { ConfigStore } from "../../../src/config/store.js";
import { AgenCConfigEditsBuilder } from "../../../src/config/edit.js";
import { validateMcpServersConfig } from "../../../src/config/schema.js";
import { mcpDesktopInventory, parseMcpDesktopPatch, upsertMcpDesktop, setMcpDesktopEnabled, logoutMcpDesktop, MCP_DESKTOP_CAPABILITIES } from "../../../src/services/mcp/desktop-management.js";
import { AgenCAuthProvider, getServerKey, saveMcpClientSecret } from "../../../src/services/mcp/auth.js";
import { parseAgenCMcpCliArgs, runAgenCMcpCli } from "../../../src/bin/mcp-cli.js";
import { loadPlugins } from "../../../src/plugins/loader.js";
import { mutateCanonicalUserConfigSync } from "../../../src/config/update-sync.js";

let root: string;
let authority: ConfigStore;
let context: { authority: ConfigStore; environment: Record<string, string>; pluginStorageRoot: string };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-mcp-desktop-"));
  const home = join(root, "home"), workspace = join(root, "workspace"), pluginStorageRoot = join(root, "plugins");
  await Promise.all([home, workspace, pluginStorageRoot].map((path) => mkdir(path, { recursive: true })));
  const environment = { AGENC_HOME: home, HOME: root };
  authority = new ConfigStore({ home, cwd: workspace, env: environment });
  await authority.reload(); context = { authority, environment, pluginStorageRoot };
});
afterEach(async () => { credentials.clear(); await rm(root, { recursive: true, force: true }); });

function patch(extra: Record<string, unknown> = {}) {
  return parseMcpDesktopPatch(JSON.stringify({ name: "sample", transport: "stdio", command: "node", args: [], env: [], envPassthrough: [], ...extra }));
}
async function seed(name: string, config: Record<string, unknown>) {
  await new AgenCConfigEditsBuilder(authority.homeContext.path).setMcpServer(name, config).apply(); await authority.reload();
}

describe("desktop MCP contract", () => {
  test("supports OAuth only on secure remote transport and disallows secret config fields", () => {
    expect(validateMcpServersConfig({ sample: { transport: "http", endpoint: "https://example.test/mcp", oauth: { clientId: "public", scopes: ["read"] } } })?.sample?.oauth?.scopes).toEqual(["read"]);
    for (const config of [{ transport: "stdio", command: "node", oauth: {} }, { transport: "http", endpoint: "http://example.test", oauth: {} }, { transport: "http", endpoint: "https://example.test", oauth: { clientSecret: "must-not-leak" } }, { transport: "http", endpoint: "https://example.test", oauth: {}, headers: { Authorization: "must-not-leak" } }]) expect(() => validateMcpServersConfig({ sample: config })).toThrow();
  });
  test("creates, inventories and edits with revision checks while retaining redacted environment", async () => {
    await upsertMcpDesktop(context, patch({ env: [{ name: "TOKEN", configured: true, value: "hidden-secret-value" }] }));
    const first = (await mcpDesktopInventory(context)).servers[0]!;
    expect(JSON.stringify(first)).not.toContain("hidden-secret-value");
    expect(first.env).toEqual([{ name: "TOKEN", configured: true, sensitive: true }]);
    await upsertMcpDesktop(context, patch({ originalName: first.name, revision: first.revision, name: "renamed", args: ["server.mjs"], env: first.env }));
    expect(authority.current().mcp_servers?.renamed?.env?.TOKEN).toBe("hidden-secret-value");
    expect(authority.current().mcp_servers?.sample).toBeUndefined();
    await expect(upsertMcpDesktop(context, patch({ originalName: "renamed", name: "renamed", revision: first.revision }))).rejects.toThrow("changed");
    await expect(upsertMcpDesktop(context, patch({ name: "renamed" }))).rejects.toThrow("changed");
  });
  test("preserves remote headers and omitted OAuth, replaces explicit OAuth, and supports removal", async () => {
    await seed("sample", { transport: "http", endpoint: "https://example.test/mcp", headers: { "X-Private": "hidden-header" }, oauth: { callbackPort: 3118, clientId: "public", scopes: ["read"], authServerMetadataUrl: "https://example.test/metadata" } });
    const first = (await mcpDesktopInventory(context)).servers[0]!;
    expect(first.authenticationSupported).toBe(true); expect(first.authenticated).toBe(false); expect(first.needsAuthentication).toBe(true);
    expect(JSON.stringify(first)).not.toContain("hidden-header");
    await upsertMcpDesktop(context, patch({ transport: "http", url: "https://example.test/mcp", originalName: "sample", revision: first.revision, oauth: { scopes: ["read", "files"] } }));
    expect(authority.current().mcp_servers?.sample?.headers?.["X-Private"]).toBe("hidden-header");
    expect(authority.current().mcp_servers?.sample?.oauth?.authServerMetadataUrl).toBeUndefined();
    const next = (await mcpDesktopInventory(context)).servers[0]!;
    await upsertMcpDesktop(context, patch({ transport: "http", url: "https://example.test/mcp", originalName: "sample", revision: next.revision, oauth: null }));
    expect(authority.current().mcp_servers?.sample?.oauth).toBeUndefined();
  });
  test("does not infer OAuth authentication from an anonymous remote connection", async () => {
    await seed("sample", { transport: "http", endpoint: "https://example.test/mcp" });
    expect((await mcpDesktopInventory(context)).servers[0]).toMatchObject({ authenticated: false, needsAuthentication: false, authenticationSupported: false });
  });
  test("sorts environment names alphabetically without exposing their values", async () => {
    await seed("sample", { command: "node", env: { ZEBRA: "zebra-private", alpha: "alpha-private", Beta: "beta-private" } });
    const inventory = await mcpDesktopInventory(context);
    expect(inventory.servers[0]?.env).toEqual(["alpha", "Beta", "ZEBRA"].map((name) => ({ name, configured: true, sensitive: true })));
    expect(JSON.stringify(inventory)).not.toMatch(/(?:zebra|alpha|beta)-private/u);
  });
  test("removes configured:false secrets, retains redacted values and accepts an explicit empty string", async () => {
    await seed("sample", { command: "node", env: { REMOVE: "removed-secret", KEEP: "retained-secret", EMPTY: "old" } });
    const first = (await mcpDesktopInventory(context)).servers[0]!;
    await upsertMcpDesktop(context, patch({ revision: first.revision, env: [{ name: "REMOVE", configured: false }, { name: "KEEP", configured: true }, { name: "EMPTY", configured: true, value: "" }] }));
    expect(authority.current().mcp_servers?.sample?.env).toEqual({ KEEP: "retained-secret", EMPTY: "" });
    for (const name of ["__proto__", "constructor", "prototype", "-option"]) expect(() => patch({ name })).toThrow();
    for (const entry of [{ name: "TOKEN", configured: "false" }, { name: "TOKEN", configured: true, sensitive: "true" }, { name: "constructor", configured: true }]) expect(() => patch({ env: [entry] })).toThrow();
  });
  test("toggles exact names and refuses unsupported identity guesses", async () => {
    await upsertMcpDesktop(context, patch());
    await setMcpDesktopEnabled(context, "sample", false);
    expect((await mcpDesktopInventory(context)).servers[0]?.enabled).toBe(false);
    await setMcpDesktopEnabled(context, "sample", true);
    await expect(setMcpDesktopEnabled(context, "sample@guessed", false)).rejects.toThrow("not found");
  });
  test("discovers a disabled plugin MCP, preserves scopes and toggles its canonical overlay", async () => {
    mutateCanonicalUserConfigSync(authority.homeContext.configTomlPath, (raw) => { raw.plugins = { enabled: true }; }); await authority.reload();
    const plugin = join(context.pluginStorageRoot, "sample-plugin"); await mkdir(join(plugin, ".agenc-plugin"), { recursive: true });
    await writeFile(join(plugin, ".agenc-plugin", "plugin.json"), JSON.stringify({ name: "sample-plugin", mcpServers: { api: { transport: "http", endpoint: "https://example.test/mcp", enabled: false, oauth: { scopes: ["read"] }, enabled_tools: ["read_item"] } } }));
    expect(await loadPlugins({ pluginStorageRoot: context.pluginStorageRoot, workspaceRoot: authority.projectRoot, config: authority.current(), readOnly: true })).toMatchObject({ enabled: [expect.objectContaining({ id: "sample-plugin" })], errors: [] });
    const inventory = await mcpDesktopInventory(context);
    const entry = inventory.servers.find((item) => item.pluginId === "sample-plugin")!;
    expect(inventory).toMatchObject({ servers: [expect.objectContaining({ name: "plugin:sample-plugin:api", enabled: false, editable: false, authenticationSupported: true, oauth: { scopes: ["read"] } })] });
    await setMcpDesktopEnabled(context, entry.name, true);
    expect(authority.current().plugins?.plugins?.["sample-plugin"]?.mcp_servers?.api?.enabled).toBe(true);
    expect((await mcpDesktopInventory(context)).servers.find((item) => item.name === entry.name)?.enabled).toBe(true);
    expect(() => patch({ originalName: entry.name })).toThrow();
  });
  test("loads separate plugins that both use node ./server/main.mjs", async () => {
    mutateCanonicalUserConfigSync(authority.homeContext.configTomlPath, (raw) => { raw.plugins = { enabled: true }; });
    await authority.reload();
    for (const name of ["first-plugin", "second-plugin"]) {
      const plugin = join(context.pluginStorageRoot, name);
      await mkdir(join(plugin, ".agenc-plugin"), { recursive: true });
      await mkdir(join(plugin, "server"));
      await writeFile(join(plugin, "server", "main.mjs"), "// Inventory must not execute this server.\n");
      await writeFile(join(plugin, ".agenc-plugin", "plugin.json"), JSON.stringify({
        name, mcpServers: { api: { transport: "stdio", command: "node", args: ["./server/main.mjs"] } },
      }));
    }
    const inventory = await mcpDesktopInventory(context);
    expect(inventory.errors).toEqual([]);
    expect(inventory.servers.map(server => server.pluginId).sort()).toEqual(["first-plugin", "second-plugin"]);
    for (const server of inventory.servers) {
      expect(server.cwd).toBe(join(context.pluginStorageRoot, server.pluginId!));
    }
  });
  test("does not report an intentional duplicate suppression as a load failure", async () => {
    await seed("manual", { transport: "http", endpoint: "https://example.test/mcp" });
    mutateCanonicalUserConfigSync(authority.homeContext.configTomlPath, (raw) => { raw.plugins = { enabled: true }; });
    await authority.reload();
    const plugin = join(context.pluginStorageRoot, "duplicate-plugin");
    await mkdir(join(plugin, ".agenc-plugin"), { recursive: true });
    await writeFile(join(plugin, ".agenc-plugin", "plugin.json"), JSON.stringify({
      name: "duplicate-plugin", mcpServers: { api: { transport: "http", endpoint: "https://example.test/mcp" } },
    }));
    const inventory = await mcpDesktopInventory(context);
    expect(inventory.servers.map(server => server.name)).toEqual(["manual"]);
    expect(inventory.errors).toEqual([]);
  });
  test("logout removes only exact-server OAuth state and client secret", async () => {
    const config = { type: "http" as const, url: "https://example.test/mcp", oauth: {} };
    await seed("sample", { transport: "http", endpoint: config.url, oauth: {} });
    for (const name of ["sample", "other"]) {
      await new AgenCAuthProvider(authority.homeContext, name, config).saveTokens({ access_token: `${name}-secret`, refresh_token: `${name}-refresh`, token_type: "Bearer" });
      saveMcpClientSecret(authority.homeContext, name, config, `${name}-client-secret`);
    }
    expect((await mcpDesktopInventory(context)).servers[0]?.authenticated).toBe(true);
    await logoutMcpDesktop(context, "sample");
    const stored = credentials.get(authority.homeContext.path)!;
    expect(stored.mcpOAuth?.[getServerKey("sample", config)]).toBeUndefined();
    expect(stored.mcpOAuthClientConfig?.[getServerKey("sample", config)]).toBeUndefined();
    expect(stored.mcpOAuth?.[getServerKey("other", config)]?.accessToken).toBe("other-secret");
  });
  test("refuses ambiguous normalized plugin MCP identities instead of binding credentials to one", async () => {
    mutateCanonicalUserConfigSync(authority.homeContext.configTomlPath, (raw) => { raw.plugins = { enabled: true }; }); await authority.reload();
    const plugin = join(context.pluginStorageRoot, "ambiguous"); await mkdir(join(plugin, ".agenc-plugin"), { recursive: true });
    const server = { transport: "http", endpoint: "https://example.test/mcp", oauth: {}, enabled: false };
    await writeFile(join(plugin, ".agenc-plugin", "plugin.json"), JSON.stringify({ name: "ambiguous", mcpServers: { "read.foo": server, "read/foo": server } }));
    const inventory = await mcpDesktopInventory(context);
    expect(inventory.servers).toEqual([]); expect(inventory.errors).toHaveLength(1);
    await expect(setMcpDesktopEnabled(context, "plugin:ambiguous:read_foo", true)).rejects.toThrow("not found");
  });
  test("CLI reports explicit capabilities and consumes only bounded stdin JSON", async () => {
    const run = async (argv: string[], input = "") => {
      let stdout = "", stderr = "";
      const command = parseAgenCMcpCliArgs(["mcp", ...argv])!;
      const code = await runAgenCMcpCli(command, { configStore: authority, environment: context.environment, pluginStorageRoot: context.pluginStorageRoot, io: { stdin: Readable.from([input]), stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }), stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }) } });
      return { code, stdout, stderr };
    };
    expect(JSON.parse((await run(["capabilities", "--json"])).stdout)).toEqual(MCP_DESKTOP_CAPABILITIES);
    expect((await run(["upsert", "--json"], JSON.stringify(patch()))).code).toBe(0);
    expect((await run(["disable", "sample"])).code).toBe(0);
    const result = await run(["upsert", "--json"], '{"name":"secret-invalid-json');
    expect(result.code).toBe(1); expect(result.stderr).not.toContain("secret-invalid-json");
    const persisted = await readFile(authority.homeContext.configTomlPath, "utf8");
    expect(persisted).toContain("sample");
  });
  test.each(['{"name":"a","name":"b"}', '{"name":"sample","clientSecret":"secret"}', JSON.stringify({ ...patch(), env: [{ name: "A", value: "x" }, { name: "A", value: "y" }] })])("rejects invalid patch without printing its contents", (input) => {
    expect(() => parseMcpDesktopPatch(input)).toThrow();
  });
});
