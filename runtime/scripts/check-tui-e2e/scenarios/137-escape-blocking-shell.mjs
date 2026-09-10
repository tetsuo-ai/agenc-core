import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const meta = {
  description: "Escape stops a foreground command and its descendant before yielding, then the same session accepts another turn.",
  timeoutMs: 75_000,
  slimCwd: true,
  sandboxMode: "danger-full-access",
  args: ["--provider", "grok", "--model", "grok-4.6", "--dangerously-bypass-approvals-and-sandbox"],
  skip: process.platform === "linux" ? undefined : "Linux process identity verification requires /proc.",
};

function shellQuote(value) {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

async function ownedProcessAlive(processId, marker) {
  if (!Number.isInteger(processId) || processId < 2) return false;
  try {
    const [command, stat] = await Promise.all([
      readFile(`/proc/${processId}/cmdline`, "utf8"),
      readFile(`/proc/${processId}/stat`, "utf8"),
    ]);
    return command.includes(marker) && stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForCheck(session, check, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    session.throwIfAborted();
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export default async function (session) {
  const probePath = path.join(session.cwd, "agenc-blocking-shell-probe.cjs");
  const readyPath = path.join(session.cwd, "agenc-blocking-shell-ready.json");
  const childSource = `process.send('ready'); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000); void ${JSON.stringify(probePath)};`;
  await writeFile(probePath, [
    `const { spawn } = require('node:child_process');`,
    `const { writeFileSync } = require('node:fs');`,
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
    `child.once('message', () => writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ parent: process.pid, descendant: child.pid })));`,
    `setInterval(() => {}, 1000);`,
    `setTimeout(() => { child.kill(); process.exit(0); }, 60000);`,
  ].join("\n"), "utf8");
  let dispatched = false;
  let processIds;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const firstToolCall = body.stream === true && !dispatched;
      const output = firstToolCall
        ? [{
            type: "function_call", id: "fc_blocking_shell", call_id: "call_blocking_shell",
            name: "exec_command", status: "completed",
            arguments: JSON.stringify({ cmd: `${shellQuote(process.execPath)} ${shellQuote(probePath)}`, yield_time_ms: 30000, timeoutMs: 60000, max_output_tokens: 1000 }),
          }]
        : [{
            type: "message", id: "msg_shell_recovery", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: body.stream === true ? "SCRIPTED_SHELL_ESCAPE_RECOVERY_OK" : "OK", annotations: [] }],
          }];
      const result = {
        id: firstToolCall ? "resp_blocking_shell" : "resp_shell_recovery", object: "response",
        created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model, output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      if (body.stream !== true) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      const events = [];
      if (firstToolCall) {
        dispatched = true;
        events.push({ type: "response.output_item.added", output_index: 0, item: output[0] });
        events.push({ type: "response.output_item.done", output_index: 0, item: output[0] });
      }
      events.push({ type: "response.completed", response: result });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    Object.assign(session.envOverrides, {
      AGENC_PROVIDER: "grok", AGENC_MODEL: "grok-4.6", AGENC_MAX_OUTPUT_TOKENS: "4096",
      GROK_AUTH_MODE: "api-key", XAI_API_KEY: "local-inert-shell-key",
      XAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, AGENC_AUTH_MANAGED_KEYS_ENABLED: "0",
    });
    await session.start();
    await session.waitForPrompt({ timeout: 15_000 });
    await session.submit("Run the blocking shell fixture and wait for completion.");
    await waitForCheck(session, async () => {
      try {
        processIds = JSON.parse(await readFile(readyPath, "utf8"));
        return await ownedProcessAlive(processIds.parent, probePath) && await ownedProcessAlive(processIds.descendant, probePath);
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }, 15_000, "foreground command and descendant readiness");
    const before = (await session.readRolloutItems()).filter(item => item.type === "event_msg").map(item => item.payload.msg);
    assert.equal(before.filter(event => event.type === "turn_complete").length, 0, "The shell already yielded or completed before Escape");
    const cancelledAt = Date.now();
    session.sendEscape();
    await waitForCheck(session, async () => !(await ownedProcessAlive(processIds.parent, probePath)) && !(await ownedProcessAlive(processIds.descendant, probePath)), 7_000, "cancelled command process tree");
    assert.ok(Date.now() - cancelledAt < 7_000);
    await waitForCheck(session, async () => (await session.readRolloutItems()).some(item => item.type === "event_msg" && item.payload.msg.type === "turn_aborted"), 5_000, "durable turn cancellation");
    await session.waitForIdle({ idleWindow: 1_000, timeout: 5_000 });
    await session.submit("Reply after the cancelled shell command.");
    await session.waitFor(/SCRIPTED_SHELL_ESCAPE_RECOVERY_OK/u, { timeout: 15_000 });
    await session.waitForIdle({ idleWindow: 1_000, timeout: 5_000 });
    const events = (await session.readRolloutItems()).filter(item => item.type === "event_msg").map(item => item.payload.msg);
    assert.equal(events.filter(event => event.type === "turn_started").length, 2);
    assert.equal(events.filter(event => event.type === "turn_aborted").length, 1);
    assert.equal(events.find(event => event.type === "turn_aborted").payload.reason, "interrupted");
    assert.equal(events.filter(event => event.type === "turn_complete").length, 1);
  } finally {
    for (const processId of [processIds?.descendant, processIds?.parent]) {
      if (await ownedProcessAlive(processId, probePath)) process.kill(processId, "SIGKILL");
    }
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
