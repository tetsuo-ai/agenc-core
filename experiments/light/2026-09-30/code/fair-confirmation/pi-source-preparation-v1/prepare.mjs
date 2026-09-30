// Reduced SDK preparation check only: no prompt(), provider or tool execution.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const INSTALL = '/private/tmp/light-pi-prospective-0731-wFnQft';
const LOCK = 'b80f5fc994c169a37c21809dc81bca2def2e29a06951317aa8f3548861763bb3';
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const need = (ok, label) => { if (!ok) throw new Error(label); };
let stage = 'preflight', denied = 0, session;
const deny = () => { denied++; throw new Error('fixture_external_operation_refused'); };
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = deny;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny;
dgram.createSocket = deny;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = deny;
syncBuiltinESMExports();
// This JavaScript tripwire is not an OS sandbox. Fresh env contains no keys.
const ActualDate = Date;
globalThis.Date = class extends ActualDate {
  constructor(...args) { super(...(args.length ? args : ['2026-09-30T12:00:00.000Z'])); }
  static now() { return ActualDate.parse('2026-09-30T12:00:00.000Z'); }
};
const base = path.join(INSTALL, 'node_modules/@mariozechner/pi-coding-agent/dist/core');
const load = name => import(pathToFileURL(path.join(base, name)).href);
const pick = tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters });
try {
  need(sha(fs.readFileSync(path.join(INSTALL, 'package-lock.json'))) === LOCK, 'lock_mismatch');
  const workspace = fs.mkdtempSync('/private/tmp/pi-source-preparation-v1-');
  const agentDir = path.join(workspace, 'agent'); fs.mkdirSync(agentDir);
  stage = 'canonical_imports';
  const { createCodingToolDefinitions } = await load('tools/index.js');
  const { buildSystemPrompt } = await load('system-prompt.js');
  const { createExtensionRuntime } = await load('extensions/loader.js');
  const { AuthStorage } = await load('auth-storage.js');
  const { ModelRegistry } = await load('model-registry.js');
  const { SettingsManager } = await load('settings-manager.js');
  const { SessionManager } = await load('session-manager.js');
  const { createAgentSession } = await load('sdk.js');
  stage = 'independent_preparation';
  const names = ['read', 'bash', 'edit', 'write'];
  const tools = createCodingToolDefinitions(workspace, { read: { autoResizeImages: false }, bash: { shellPath: '/bin/sh' } });
  const snippets = Object.fromEntries(tools.map(t => [t.name, t.promptSnippet.trim()]));
  const guidelines = tools.flatMap(t => t.promptGuidelines ?? []);
  const system = buildSystemPrompt({ cwd: workspace, selectedTools: names,
    toolSnippets: snippets, promptGuidelines: guidelines, contextFiles: [], skills: [] });
  const sealed = Object.freeze({ system: sha(system), tools: sha(JSON.stringify(tools.map(pick))),
    names: JSON.stringify(names), task: sha('Reply with a short acknowledgement; do not call tools.') });
  stage = 'fresh_actual_session';
  const runtime = createExtensionRuntime();
  const resources = {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getAppendSystemPrompt: () => [],
    extendResources: () => { throw new Error('unexpected_resource_extension'); },
    reload: async () => { throw new Error('unexpected_resource_reload'); },
  };
  const auth = AuthStorage.inMemory();
  const settings = SettingsManager.inMemory({ images: { autoResize: false }, shellPath: '/bin/sh',
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } });
  // A predeclared synthetic descriptor, not a price/capability claim about live service.
  const model = { id: 'gpt-6-luna', name: 'Synthetic Luna fixture', api: 'openai-responses',
    provider: 'openai', baseUrl: 'https://api.openai.com/v1', reasoning: true, input: ['text'],
    contextWindow: 1050000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  ({ session } = await createAgentSession({ cwd: workspace, agentDir,
    authStorage: auth, modelRegistry: ModelRegistry.inMemory(auth), settingsManager: settings,
    sessionManager: SessionManager.inMemory(workspace), resourceLoader: resources,
    model, thinkingLevel: 'low', tools: names }));
  stage = 'compare_sealed_preparation';
  need(sha(session.systemPrompt) === sealed.system, 'system_mismatch');
  need(sha(JSON.stringify(names.map(n => pick(session.getToolDefinition(n))))) === sealed.tools, 'tools_mismatch');
  need(JSON.stringify(session.getActiveToolNames()) === sealed.names, 'tool_names_mismatch');
  need(session.messages.length === 0 && session.sessionManager.buildSessionContext().messages.length === 0, 'history_present');
  need(resources.getExtensions().extensions.length === 0 && runtime.pendingProviderRegistrations.length === 0, 'hooks_present');
  need(session.model.id === model.id && session.thinkingLevel === 'low', 'model_selection_mismatch');
  need(settings.getProviderRetrySettings().maxRetries === 0 && !settings.getRetryEnabled(), 'retry_mismatch');
  stage = 'dispose'; session.dispose(); session = undefined;
  need(denied === 0, 'external_attempt_detected');
  console.log(JSON.stringify({ status: 'passed', scope: 'reduced-sdk-preparation-only',
    lockSha256: LOCK, workspace, sealed, externalAttempts: denied, providerCalls: 0,
    tools: names.length, history: 0, disposed: true }));
} catch (error) {
  try { session?.dispose(); } catch { /* Preserve original stage failure. */ }
  console.log(JSON.stringify({ status: 'failed', stage, errorName: error?.name,
    reason: /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'dependency_or_unclassified_failure',
    externalAttempts: denied }));
  process.exitCode = 1;
}
