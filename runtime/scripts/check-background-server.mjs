// Linux real-product proof for the background server guidance fallback.
// Run in a disposable Linux container with its own HOME, AGENC_HOME and /tmp.
// Usage: node check-background-server.mjs <runtime dir> <evidence dir>
// No provider credentials: a local scripted model drives two real CLI sessions.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "linux") throw new Error("This proof requires the Linux sandbox");
const [runtimeDir, outDir] = process.argv.slice(2).map(value => path.resolve(value));
if (!runtimeDir || !outDir) throw new Error("usage: check-background-server.mjs <runtime dir> <evidence dir>");
mkdirSync(outDir, { recursive: true });
const gate = await import(pathToFileURL(path.join(runtimeDir, "scripts/tui-gate-state.mjs")));
const mock = await import(pathToFileURL(path.join(runtimeDir, "scripts/local-openai-compatible-mock.mjs")));
const bin = path.join(runtimeDir, "dist/bin/agenc.js");
const requests = [], observations = [], checks = [];
const children = new Set();
let state, project, observerPromise;
let sequence = 0;
const results = body => (body.messages ?? []).filter(message => message.role === "tool")
  .map(message => typeof message.content === "string" ? message.content : (message.content ?? []).map(p => p.text ?? "").join(""));
const check = (name, passed) => { checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? "PASS" : "FAIL"} ${name}`); };
function reply(response, body, name, args) {
  const delta = name ? { tool_calls: [{ index: 0, id: `bg_server_${++sequence}`, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] } : { content: "Background server proof complete." };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [data, finish] of [[{ role: "assistant" }, null], [delta, null], [{}, name ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: `chatcmpl-${sequence}`, object: "chat.completion.chunk", model: body.model,
      choices: [{ index: 0, delta: data, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}) })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}
const together = `node server.cjs >same-command.log 2>&1 & pid=$!; trap 'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null' EXIT; for i in {1..50}; do curl --noproxy '*' -fs --max-time 1 http://127.0.0.1:18761/ && exit 0; sleep 0.1; done; cat same-command.log; exit 1`;
function cli(label) {
  const child = spawn(process.execPath, [bin, "--light", "--permission-mode", "acceptEdits", "-p", `bg-server-proof ${label}`],
    { cwd: project, env: gate.environmentForTuiGateState(state), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${label} CLI timed out`)); }, 90_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer); children.delete(child);
      writeFileSync(path.join(outDir, `${label}-stdout.txt`), stdout);
      writeFileSync(path.join(outDir, `${label}-stderr.txt`), stderr);
      resolve(code);
    });
  });
}
const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: mock.MOCK_MODEL, object: "model" }] }));
    return;
  }
  try {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const observer = (body.messages ?? []).some(m => m.role === "user" && JSON.stringify(m.content).includes("bg-server-proof observer"));
    (observer ? observations : requests).push(body);
    appendFileSync(path.join(outDir, "requests.jsonl"), JSON.stringify({ observer, body }) + "\n");
    const seen = results(body);
    if (observer) {
      if (!seen.length) return reply(response, body, "exec_command", { cmd: "node client.cjs" });
      return reply(response, body);
    }
    switch (seen.length) {
      case 0: return reply(response, body, "exec_command", { cmd: "nohup node server.cjs >server.log 2>&1 &" });
      case 1: return reply(response, body, "exec_command", { cmd: "node server.cjs", background: true });
      case 2:
        // The first conversation stays alive while a distinct conversation
        // in the same daemon and workspace attempts the same loopback port.
        observerPromise = cli("observer");
        check("observer CLI exits cleanly", await observerPromise === 0);
        return reply(response, body, "exec_command", { cmd: "node client.cjs" });
      case 3: return reply(response, body, "exec_command", { cmd: together });
      case 4: return reply(response, body, "write_stdin", {
        session_id: Number(/session_id=(\d+)/u.exec(seen[1] ?? "")?.[1]), chars: "", yield_time_ms: 1,
      });
      default: return reply(response, body);
    }
  } catch (error) {
    console.error(error); response.writeHead(500).end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  state = await gate.createTuiGateState({ injectedEnv: mock.buildMockProviderEnv(`http://127.0.0.1:${server.address().port}`, {}) });
  project = gate.createTuiGateProject(state);
  writeFileSync(path.join(state.agencHome, "config.toml"), "config_version = 2\n[sandbox.network]\nallowLocalBinding = true\n");
  writeFileSync(path.join(project, "server.cjs"), `const http=require('node:http');
const server=http.createServer((req,res)=>res.end('bg2-local-only'));
server.listen(18761,'127.0.0.1',()=>http.get('http://127.0.0.1:18761/',r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{if(s!=='bg2-local-only')process.exit(2);console.log('READY self-check '+s);});}));
setTimeout(()=>server.close(),120000).unref();\n`);
  writeFileSync(path.join(project, "client.cjs"), `const net=require('node:net');
const socket=net.connect({host:'127.0.0.1',port:18761});
socket.setTimeout(2000,()=>{console.error('TIMEOUT');socket.destroy();process.exitCode=2;});
socket.on('connect',()=>{console.log('UNEXPECTED_CONNECT');socket.destroy();process.exitCode=1;});
socket.on('error',e=>{console.log(e.code);process.exitCode=e.code==='ECONNREFUSED'?0:2;});\n`);
  await gate.startTuiGateDaemon(state, bin);
  check("parent CLI exits cleanly", await cli("parent") === 0);
  const seen = results(requests.at(-1));
  check("description gives the Linux server exception", requests[0].tools.some(t => t.function.name === "exec_command" && t.function.description.includes("servers and clients in one command")));
  check("refusal gives the Linux server exception", seen[0]?.includes("servers and clients in one command"));
  check("background server really listens inside its sandbox", seen[1]?.includes("READY self-check bg2-local-only") && /session_id=\d+/.test(seen[1]));
  check("later command has isolated loopback", seen[2]?.includes("ECONNREFUSED") && !seen[2]?.includes("UNEXPECTED_CONNECT"));
  const other = results(observations.at(-1));
  check("different conversation cannot reach the background server", other[0]?.includes("ECONNREFUSED") && !other[0]?.includes("UNEXPECTED_CONNECT"));
  check("documented one-command server and client succeeds", seen[3]?.includes("bg2-local-only") && /\[exit 0\]|exit_code=0/.test(seen[3] ?? ""));
  check("background server remains live after both checks", /session_id=\d+/.test(seen[4] ?? "") && !/exit_code=|\[exit \d+\]/.test(seen[4] ?? ""));
  writeFileSync(path.join(outDir, "tool-results.json"), JSON.stringify({ parent: seen, observer: other }, null, 2));
} finally {
  for (const child of children) child.kill("SIGKILL");
  if (observerPromise) await observerPromise.catch(() => {});
  if (state) {
    await gate.stopTuiGateDaemon(state);
    await gate.teardownTuiGateState(state, bin);
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  writeFileSync(path.join(outDir, "checks.json"), JSON.stringify(checks, null, 2) + "\n");
}
process.exitCode = checks.length === 9 && checks.every(c => c.passed) ? 0 : 1;
