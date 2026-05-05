#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message, detail = "") {
  process.stderr.write(`${message}\n`);
  if (detail) process.stderr.write(`${detail}\n`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Failed to parse JSON at ${filePath}`, error instanceof Error ? error.message : String(error));
  }
}

function candidatePackageDirs() {
  return [
    process.env.AGENC_PLUGIN_KIT_DIR,
    path.resolve(root, "..", "agenc-plugin-kit"),
  ].filter(Boolean);
}

function findPluginKitDir() {
  for (const candidate of candidatePackageDirs()) {
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  fail(
    "Could not find agenc-plugin-kit checkout.",
    `Checked:\n${candidatePackageDirs().map((p) => `  - ${p}`).join("\n")}`,
  );
}

function assertFile(filePath, label) {
  assert(existsSync(filePath), `${label} missing: ${filePath}`);
  assert(statSync(filePath).isFile(), `${label} is not a file: ${filePath}`);
}

function assertRelativePath(pluginRoot, field, value) {
  assert(typeof value === "string", `${field} must be a string`);
  assert(value.startsWith("./"), `${field} must start with ./`);
  const rest = value.slice(2);
  assert(rest.length > 0, `${field} must not be ./`);
  const rawParts = rest.split(/[\\/]/u);
  assert(
    rawParts.every((part) => part.length > 0 && part !== "." && part !== ".."),
    `${field} must be normalized`,
  );
  const resolved = path.resolve(pluginRoot, rest);
  const normalizedRoot = path.resolve(pluginRoot);
  assert(
    resolved.startsWith(`${normalizedRoot}${path.sep}`),
    `${field} escapes the plugin root`,
  );
  return resolved;
}

function assertStringArray(value, field) {
  assert(Array.isArray(value), `${field} must be an array`);
  assert(value.every((entry) => typeof entry === "string"), `${field} must only contain strings`);
}

function assertManifest(exampleRoot) {
  const manifestPath = path.join(exampleRoot, ".agenc-plugin", "plugin.json");
  assertFile(manifestPath, "hello-tool manifest");
  const manifest = readJson(manifestPath);
  assert(manifest.name === "hello-tool", "hello-tool manifest name drifted");
  assert(manifest.version === "0.1.0", "hello-tool manifest version drifted");
  assert(typeof manifest.description === "string", "hello-tool manifest needs a description");
  assertStringArray(manifest.interface?.capabilities, "interface.capabilities");
  assert(
    manifest.interface.capabilities.includes("prompt-command") &&
      manifest.interface.capabilities.includes("mcp-tool"),
    "hello-tool interface capabilities must cover prompt command and MCP tool behavior",
  );

  const helloCommand = manifest.commands?.hello;
  assert(helloCommand && typeof helloCommand === "object", "hello command metadata missing");
  const commandPath = assertRelativePath(exampleRoot, "commands.hello.source", helloCommand.source);
  assertFile(commandPath, "hello command markdown");
  assertStringArray(helloCommand.allowedTools, "commands.hello.allowedTools");
  assert(
    helloCommand.allowedTools.includes("mcp.plugin:hello-tool:hello-tool.say_hello"),
    "hello command allowed tool does not match the scoped MCP tool",
  );

  const defaultName = manifest.userConfig?.defaultName;
  assert(defaultName?.type === "string", "defaultName user config must be a string option");
  assert(defaultName.default === "AgenC", "defaultName user config default drifted");

  const server = manifest.mcpServers?.["hello-tool"];
  assert(server && typeof server === "object", "hello-tool MCP server missing");
  assert(server.transport === "stdio", "hello-tool MCP server must use stdio");
  assert(server.command === "node", "hello-tool MCP server command drifted");
  assertStringArray(server.args, "mcpServers.hello-tool.args");
  assert(
    server.args.includes("${AGENC_PLUGIN_ROOT}/tools/hello-tool-server.mjs"),
    "hello-tool MCP server must use AGENC_PLUGIN_ROOT for its entrypoint",
  );
  assert(server.cwd === "${AGENC_PLUGIN_ROOT}", "hello-tool MCP server cwd must use AGENC_PLUGIN_ROOT");
  assert(
    server.env?.HELLO_TOOL_DEFAULT_NAME === "${user_config.defaultName}",
    "hello-tool MCP server must wire defaultName through user_config template",
  );
  assertFile(path.join(exampleRoot, "tools", "hello-tool-server.mjs"), "hello-tool MCP server script");
}

function assertPackage(exampleRoot) {
  const packageJsonPath = path.join(exampleRoot, "package.json");
  assertFile(packageJsonPath, "hello-tool package manifest");
  const packageJson = readJson(packageJsonPath);
  assert(packageJson.private === true, "hello-tool example package must stay private");
  for (const dependency of [
    "@modelcontextprotocol/sdk",
    "@tetsuo-ai/plugin-kit",
    "@tetsuo-ai/sdk",
  ]) {
    assert(
      Object.prototype.hasOwnProperty.call(packageJson.dependencies ?? {}, dependency),
      `hello-tool example package missing dependency ${dependency}`,
    );
  }
}

function assertServerSelfTest(exampleRoot) {
  const output = execFileSync(
    process.execPath,
    [path.join(exampleRoot, "tools", "hello-tool-server.mjs"), "--self-test"],
    { cwd: exampleRoot, encoding: "utf8" },
  ).trim();
  assert(output === "hello-tool-self-test-ok", `unexpected hello-tool self-test output: ${output}`);
}

function assertRuntimeContractStillSupportsExampleShape() {
  const loader = readFileSync(path.join(root, "runtime/src/plugins/loader.ts"), "utf8");
  const common = readFileSync(path.join(root, "runtime/src/plugins/registration/common.ts"), "utf8");
  const mcp = readFileSync(path.join(root, "runtime/src/plugins/registration/mcp-plugin-integration.ts"), "utf8");
  assert(
    loader.includes("PLUGIN_MANIFEST_RELATIVE_PATH") && loader.includes("loadCommands"),
    "runtime plugin loader no longer advertises canonical manifest command loading",
  );
  assert(
    common.includes("AGENC_PLUGIN_ROOT") &&
      common.includes("AGENC_PLUGIN_DATA") &&
      common.includes("user_config"),
    "runtime plugin registration no longer supports plugin/user config templates",
  );
  assert(
    mcp.includes("AGENC_PLUGIN_NAME") && mcp.includes("plugin:${plugin.name}:${name}"),
    "runtime plugin MCP registration no longer scopes plugin MCP servers",
  );
}

const packageDir = findPluginKitDir();
const packageJson = readJson(path.join(packageDir, "package.json"));
assert(packageJson.name === "@tetsuo-ai/plugin-kit", `unexpected package name in ${packageDir}`);

const exampleRoot = path.join(packageDir, "examples", "hello-tool");
assert(existsSync(exampleRoot), `hello-tool example directory missing: ${exampleRoot}`);
assertManifest(exampleRoot);
assertPackage(exampleRoot);
assertServerSelfTest(exampleRoot);
assertRuntimeContractStillSupportsExampleShape();

process.stdout.write(`plugin-kit hello-tool example ok (${path.relative(tmpdir(), exampleRoot) || exampleRoot})\n`);
