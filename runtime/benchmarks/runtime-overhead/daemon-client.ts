/** Time the SDK socket path after imports, connect and a model-free priming session. */
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "../../../packages/agenc-sdk/src/socket.js";
import { collectClientEnvOverrides } from "../../../packages/agenc-sdk/src/client.js";
const [inputPath, outputPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath!, "utf8"));
const client = await connect({ autostart: false });
const params = {
  objective: input.prompt, instructions: input.prompt, cwd: input.cwd,
  provider: "deepseek", model: "deepseek-flash", initialContent: [],
  envOverrides: collectClientEnvOverrides(),
  runtimeOptions: {
    simpleMode: false, dangerouslyBypassApprovalsAndSandbox: true,
    stdinDataMode: false, remoteMode: false, allowUntrustedHooks: false,
    nonInteractive: true, exactOutput: true, pluginStorageRoot: `${process.env.AGENC_HOME}/plugins`,
  },
};
const primeStart = Date.now();
const primed = await client.spawnAgent(params);
await client.stopAgent(primed.agentId, "replay warmup complete");
const primingMs = Date.now() - primeStart;
const start_ms = performance.timeOrigin + performance.now();
const agent = await client.spawnAgent(params);
const created_ms = performance.timeOrigin + performance.now();
try {
  const attached = await client.attachAgent(agent.agentId);
  if (!attached.session) throw new Error("missing replay session");
  const result = await attached.session.prompt(input.prompt).result();
  const turn_end_ms = performance.timeOrigin + performance.now();
  await client.stopAgent(agent.agentId, "replay complete");
  const end_ms = performance.timeOrigin + performance.now();
  writeFileSync(outputPath!, JSON.stringify({start_ms, created_ms, turn_end_ms, end_ms,
    wall_ms:end_ms-start_ms, session_create_ms:created_ms-start_ms,
    teardown_ms:end_ms-turn_end_ms, priming_ms:primingMs, stop_reason:result.stopReason}));
} finally { await client.close(); }
