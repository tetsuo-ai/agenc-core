/** Real built daemon + SDK + scripted loopback model + authenticated HTTP MCP.
 * No operator profile, cloud provider, global MCP config, or Electron instance.
 * Run after build: node scripts/check-desktop-mcp-delivery.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID, generateKeyPairSync, createHash, sign } from "node:crypto";
import { readFile, mkdir, writeFile, appendFile, mkdtemp, chmod, realpath, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../packages/agenc-sdk/dist/index.js";
import { createTuiGateState, createTuiGateProject, writeTuiGateDefaultConfig, writeTuiGateTrust, startTuiGateDaemon, teardownTuiGateState } from "./tui-gate-state.mjs";

const bin = fileURLToPath(new URL("../dist/bin/agenc.js", import.meta.url));
// Desktop inventory runs the CLI directly. Official package mode
// canonicalization intentionally leaves dist JS non-executable; use the
// shipped executable wrapper, as an installed app does.
const desktopBin = fileURLToPath(new URL("../bin/agenc", import.meta.url));
const sdkRequests = [];
const calls = [];
let token = randomBytes(24).toString("hex");
const secrets = [token];
let initializes = 0;
let callId = 0;
let keys;
const model = "gpt-4.1-mini"; // Wire-compatible fixture only; every request stays on loopback.
const namespace = "mcp.agenc-desktop-control.";
const serve = process.argv.includes("--serve");
const terminalPolicy = process.argv.includes("--terminal-policy");
assert(!(serve && terminalPolicy), "terminal-policy cannot be combined with serve");
const steps = terminalPolicy ? ["terminal_open"] : ["desktop_state", "desktop_window_state", "desktop_settings_open"];
const providerEnv = url => ({ AGENC_PROVIDER: "openai", AGENC_MODEL: model, OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_KEY: "isolated-scripted-key", AGENC_AUTH_MANAGED_KEYS_ENABLED: "0" });

async function bodyOf(request) {
  let raw = "";
  for await (const chunk of request) { raw += chunk; assert(raw.length < 4_000_000); }
  return raw ? JSON.parse(raw) : {};
}
function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
async function listen(handler, socketPath) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => { console.error("Fixture request error:", error.message); json(response, 500, { error: String(error.message) }); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); if (socketPath) server.listen(socketPath, resolve); else server.listen(0, "127.0.0.1", resolve); });
  if (socketPath) await chmod(socketPath, 0o600);
  return { server, socketPath, url: socketPath ? "http://127.0.0.1:43117" : `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function replyModel(response, body, call) {
  if (Array.isArray(body.input)) {
    const id = `desktop_smoke_${++callId}`;
    const item = call ? { type: "function_call", id: `fc_${id}`, call_id: id, name: call.name, arguments: JSON.stringify(call.args), status: "completed" }
      : { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "DESKTOP_MCP_DELIVERY_OK", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = [{ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: `resp_${id}`, status: "completed", model: body.model, output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }];
    if (!call) events.unshift({ type: "response.output_text.delta", delta: "DESKTOP_MCP_DELIVERY_OK" });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
    return;
  }
  const frame = (delta, finish_reason = null) => ({ id: `local-${callId}`, object: "chat.completion.chunk", created: 1, model: body.model ?? model, choices: [{ index: 0, delta, finish_reason }] });
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunks = [frame({ role: "assistant" })];
  if (call) chunks.push(frame({ tool_calls: [{ index: 0, id: `desktop_smoke_${++callId}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
  else chunks.push(frame({ content: "DESKTOP_MCP_DELIVERY_OK" }));
  chunks.push({ ...frame({}, call ? "tool_calls" : "stop"), usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

let state;
let client;
let provider;
let mcp;
let socketRoot;
const deadline = setTimeout(() => { console.error("Desktop MCP delivery gate timed out"); process.exitCode = 1; void cleanup(); }, serve ? 12 * 60 * 60 * 1000 : 150_000);
let cleaning;
function cleanup() {
  return cleaning ??= (async () => {
    clearTimeout(deadline);
    await client?.close();
    if (state) await teardownTuiGateState(state, bin);
    await mcp?.close();
    if (socketRoot) await rm(socketRoot, { recursive: true, force: true });
    await provider?.close();
  })();
}
try {
  provider = await listen(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") return json(response, 200, { object: "list", data: [{ id: model, object: "model", owned_by: "fixture" }] });
    if (request.url === "/api/show") return json(response, 404, { error: "not an Ollama fixture" });
    assert(["/v1/chat/completions", "/v1/responses"].includes(request.url));
    const body = await bodyOf(request);
    sdkRequests.push(body);
    console.log(`Scripted provider request ${sdkRequests.length}`);
    for (const secret of secrets) assert(!JSON.stringify(body).includes(secret), "credential reached provider");
    const messages = body.messages ?? body.input ?? [];
    // Runtime tool-discovery attachments can themselves use role=user. Anchor
    // the scripted turn to its explicit human trigger, not the latest wrapper.
    const userIndex = messages.findLastIndex(message => message.role === "user" && JSON.stringify(message.content).includes("DESKTOP_CONTROL_SMOKE"));
    const results = messages.slice(userIndex + 1).filter(message => message.role === "tool" || message.type === "function_call_output");
    const available = body.tools ?? [];
    if (available.length === 0) { console.error("No-tool provider request", JSON.stringify(messages).slice(-4500)); return replyModel(response, body); }
    const find = name => available.map(tool => tool.function?.name ?? tool.name).find(candidate => candidate === name || candidate?.endsWith(name));
    if (results.length >= steps.length + 1) return replyModel(response, body);
    if (results.length === 0) {
      const name = find("system_searchTools") ?? find("system.searchTools") ?? find("searchTools");
      assert(name, `search tool unavailable: ${available.map(tool => tool.function?.name).join(",")}`);
      return replyModel(response, body, { name, args: { select: steps.map(step => `${namespace}${step}`), maxResults: 3 } });
    }
    const target = steps[results.length - 1];
    const name = find(target);
    if (!name) {
      console.error(`${target} absent after selection; schemas: ${JSON.stringify(available.map(tool => ({ name: tool.name, type: tool.type, function: tool.function?.name })))}`);
      return replyModel(response, body);
    }
    replyModel(response, body, { name, args: target === "desktop_settings_open" ? { section: "appearance" } : {} });
  });
  socketRoot = await mkdtemp(join(await realpath("/tmp"), "agenc-dc-"));
  await chmod(socketRoot, 0o700);
  mcp = await listen(async (request, response) => {
    if (request.url === "/mcp/authority") {
      assert.equal(request.headers.authorization, undefined);
      const challenge = await bodyOf(request);
      assert.equal(challenge.authorizationHash, createHash("sha256").update(`Bearer ${token}`).digest("hex"));
      const payload = JSON.stringify([3, "agenc-desktop-control", `${mcp.url}/mcp`, challenge.authorizationHash, challenge.nonce, mcp.socketPath]);
      return json(response, 200, { signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64") });
    }
    if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });
    if (request.method !== "POST") return json(response, 405, { error: "method" });
    const message = await bodyOf(request);
    if (!Object.hasOwn(message, "id")) { response.writeHead(202); response.end(); return; }
    let result;
    if (message.method === "initialize") { initializes++; result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "desktop-smoke-fixture", version: "1" }, instructions: "Authenticated fixture for the visible Desktop window. Inspect desktop_state before window_open." }; }
    else if (message.method === "tools/list") result = { tools: [
      { name: "desktop_state", description: "Read current Desktop state", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
      { name: "desktop_window_state", description: "Read current window bounds", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "desktop_settings_open", description: "Open a Desktop Settings panel", inputSchema: { type: "object", properties: { section: { type: "string", enum: ["appearance"] } }, required: ["section"], additionalProperties: false } },
      ...(terminalPolicy ? [{ name: "terminal_open", description: "Fixture only: record a request to create a terminal without starting any process", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] : []),
    ] };
    else if (message.method === "tools/call") {
      assert(message.params._meta?.["agenccode/toolUseId"], "trusted tool identity missing");
      calls.push({ name: message.params.name, args: message.params.arguments });
      result = { content: [{ type: "text", text: JSON.stringify({ fixture: true, windowId: "fixture-window", target: message.params.arguments?.target ?? null }) }], _meta: { "agenc.desktopControl.effect": { version: 1, toolUseId: message.params._meta["agenccode/toolUseId"], toolName: message.params.name, disposition: "confirmed_committed", evidence: "Fixture operation observed synchronously" } } };
    } else if (message.method === "ping") result = {};
    else return json(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
    json(response, 200, { jsonrpc: "2.0", id: message.id, result });
  }, join(socketRoot, "control.sock"));
  state = await createTuiGateState({ prefix: "agenc-desktop-mcp-delivery-", injectedEnv: providerEnv(provider.url) });
  const project = createTuiGateProject(state);
  const configPath = await writeTuiGateDefaultConfig(state);
  // Desktop intentionally forwards credentials, not arbitrary endpoint env.
  // Pin the canonical provider configuration before the daemon starts so its
  // ordinary session creation path cannot fall back to a cloud endpoint.
  const providerBaseUrl = `${provider.url}/v1`;
  assert.equal(new URL(providerBaseUrl).hostname, "127.0.0.1");
  await appendFile(configPath, `\n[providers.openai]\nbase_url = ${JSON.stringify(providerBaseUrl)}\ndefault_model = ${JSON.stringify(model)}\ntimeout_ms = 10000\n`);
  await writeTuiGateTrust(state.env, [project]);
  const before = await readFile(configPath, "utf8");
  await startTuiGateDaemon(state, bin);
  if (serve) {
    await access(desktopBin, constants.X_OK);
    const launch = { bin: desktopBin, project, provider: "openai", model, env: state.env, prompt: "DESKTOP_CONTROL_SMOKE: inspect Desktop state and window, then open Appearance settings using the authenticated Desktop tools." };
    const path = join(state.root, "desktop-launch.json");
    await writeFile(path, JSON.stringify(launch, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "READY", launchRecipe: path, agencHome: state.agencHome, modelBaseUrl: provider.url, project }));
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
  client = await connect({ env: state.env, autostart: false, clientName: "desktop-control-delivery-gate", onPermissionRequest: (event) => { console.log(`Approved once: ${event.toolName}`); return { behavior: "allow", scope: "once" }; } });
  const created = await client.spawnAgent({ objective: "Desktop MCP delivery gate", cwd: project, initialContent: [], provider: "openai", model,
    permissionMode: terminalPolicy ? "bypassPermissions" : "default",
    // Match Desktop ingress: endpoint is deliberately NOT an env override.
    envOverrides: { OPENAI_API_KEY: "isolated-scripted-key", AGENC_AUTH_MANAGED_KEYS_ENABLED: "0" },
    runtimeOptions: { simpleMode: false, dangerouslyBypassApprovalsAndSandbox: terminalPolicy, stdinDataMode: false, remoteMode: false, pluginStorageRoot: project, allowUntrustedHooks: false },
  });
  const { session } = await client.attachAgent(created.agentId);
  assert(session, "agent did not expose a session");
  keys = generateKeyPairSync("ed25519"); const authorityId = randomUUID();
  const directory = join(state.agencHome, "desktop-control-authorities"); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, `${authorityId}.json`), JSON.stringify({ version: 2, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }), expiresAt: Date.now() + 600_000, socketPath: mcp.socketPath }), { mode: 0o600 });
  const attach = (sessionId = session.sessionId) => {
    const config = { name: "agenc-desktop-control", transport: "http", endpoint: `${mcp.url}/mcp`, localOnly: true, headers: { Authorization: `Bearer ${token}` } };
    const payload = JSON.stringify([2, config.name, config.endpoint, createHash("sha256").update(config.headers.Authorization).digest("hex"), 1, mcp.socketPath]);
    return client.request("session.mcp.addServer", { sessionId, replace: true, config: { ...config, desktopAuthority: { id: authorityId, signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64") } } }).then(result => {
      if (!result.success) { let diagnostic = JSON.stringify(result); for (const secret of secrets) diagnostic = diagnostic.replaceAll(secret, "[redacted]"); console.error("Attachment failure:", diagnostic); }
      return result;
    });
  };
  console.log("Created isolated daemon and session; attaching Desktop fixture.");
  assert.equal((await attach()).success, true);
  console.log("First authenticated attachment ready.");
  assert.equal((await attach()).success, true);
  assert.equal(initializes, 1, "identical attachment reconnected");
  token = randomBytes(24).toString("hex"); secrets.push(token);
  assert.equal((await attach()).success, true);
  console.log("Idempotency and credential rotation verified; sending local SDK turn.");
  assert.equal(initializes, 2, "credential rotation did not reconnect");
  await writeFile(join(directory, `${authorityId}.json`), JSON.stringify({ version: 2, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }), expiresAt: Date.now() + 660_000, socketPath: mcp.socketPath }), { mode: 0o600 });
  assert.equal((await attach()).success, true);
  assert.equal(initializes, 3, "renewed authority record did not refresh the connection grant");
  const run = session.prompt(terminalPolicy ? "DESKTOP_CONTROL_SMOKE: use terminal_open against the fixture only; it never starts a process." : "DESKTOP_CONTROL_SMOKE: inspect Desktop state and open Settings using the authenticated Desktop tools.", { includeUsage: false });
  const events = [];
  for await (const event of run) { events.push(event); if (event.type === "tool_call") console.log(`SDK tool call: ${event.toolName}`); }
  const result = await run.result();
  if (result.finalMessage !== "DESKTOP_MCP_DELIVERY_OK" || calls.length !== steps.length) {
    const diagnostic = JSON.stringify({ result, calls, transcript: await session.transcript() });
    for (const secret of secrets) assert(!diagnostic.includes(secret));
    console.error("Smoke diagnostic", diagnostic.slice(-6500));
  }
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.finalMessage, "DESKTOP_MCP_DELIVERY_OK");
  assert.deepEqual(calls.map(call => call.name), steps);
  if (!terminalPolicy) assert.deepEqual(calls[2].args, { section: "appearance" });
  assert(sdkRequests.some(request => JSON.stringify(request).includes("authenticated local AgenC Desktop")), "Desktop discovery instructions missing");
  const visible = JSON.stringify({ events, result, transcript: await session.transcript(), mcp: await client.request("session.mcp.status", { sessionId: session.sessionId }) });
  for (const secret of secrets) assert(!visible.includes(secret), "credential reached session output");
  if (terminalPolicy) {
    const restricted = await client.spawnAgent({ objective: "Desktop restricted terminal refusal gate", cwd: project, initialContent: [], provider: "openai", model,
      permissionMode: "default", envOverrides: { OPENAI_API_KEY: "isolated-scripted-key", AGENC_AUTH_MANAGED_KEYS_ENABLED: "0" },
      runtimeOptions: { simpleMode: false, dangerouslyBypassApprovalsAndSandbox: false, stdinDataMode: false, remoteMode: false, pluginStorageRoot: project, allowUntrustedHooks: false },
    });
    const attached = await client.attachAgent(restricted.agentId); assert(attached.session);
    assert.equal((await attach(attached.session.sessionId)).success, true);
    const restrictedRequestStart = sdkRequests.length;
    const refused = attached.session.prompt("DESKTOP_CONTROL_SMOKE: attempt the terminal_open fixture in this restricted session; report refusal without changing permissions.", { includeUsage: false });
    const restrictedEvents = []; for await (const event of refused) restrictedEvents.push(event);
    const restrictedResult = await refused.result();
    assert.equal(calls.length, 1, "restricted session dispatched an unsandboxed native terminal operation");
    const restrictedTranscript = JSON.stringify(await attached.session.transcript());
    const restrictedToolResults = sdkRequests.slice(restrictedRequestStart).flatMap(request => {
      const messages = request.messages ?? request.input ?? [];
      const terminalCalls = new Set(messages.flatMap(message => message.type === "function_call" ? [message] : message.tool_calls ?? [])
        .filter(call => (call.name ?? call.function?.name)?.endsWith("terminal_open"))
        .map(call => call.call_id ?? call.id));
      return messages.filter(message => (message.role === "tool" || message.type === "function_call_output") && terminalCalls.has(message.call_id ?? message.tool_call_id));
    });
    if (!/sandbox|full-access|permission denied|not permitted|write target/i.test(JSON.stringify(restrictedToolResults))) {
      const diagnostic = JSON.stringify({ restrictedEvents, restrictedResult, restrictedTranscript, restrictedToolResults });
      for (const secret of secrets) assert(!diagnostic.includes(secret));
      console.error("Restricted terminal diagnostic", diagnostic.slice(-12000));
    }
    assert(restrictedToolResults.length > 0, "restricted session did not attempt the terminal tool");
    assert(/sandbox|full-access|permission denied|not permitted|write target/i.test(JSON.stringify(restrictedToolResults)), "restricted terminal refusal was not surfaced to the model");
    for (const secret of secrets) assert(!JSON.stringify({ restrictedEvents, restrictedResult, restrictedTranscript }).includes(secret));
    console.log(JSON.stringify({ terminalPolicy: "PASS", fullAccessDispatched: true, restrictedDispatched: false, restrictedSessionId: attached.session.sessionId }));
  }
  assert.equal(await readFile(configPath, "utf8"), before, "global MCP configuration changed");
  console.log(JSON.stringify({ result: "DESKTOP_MCP_DELIVERY_OK", providerRequests: sdkRequests.length, authenticatedInitializations: initializes, calls, globalConfigUnchanged: true, secretsRedacted: true, sessionId: session.sessionId }));
  }
} finally {
  await cleanup();
}
