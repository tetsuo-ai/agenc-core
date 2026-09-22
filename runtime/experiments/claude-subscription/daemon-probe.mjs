// Real AgenC daemon, real model, isolated workspace, authoritative rollout assertions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { createTuiGateState, createTuiGateProject, writeTuiGateTrust, startTuiGateDaemon, stopTuiGateDaemon, teardownTuiGateState } from "../../scripts/tui-gate-state.mjs";

const workflowMode = process.argv.includes("--workflow");
const browserMode = process.argv.includes("--browser");
const resumeMode = process.argv.includes("--resume-test");
const stressMode = process.argv.includes("--agent-stress");
const mcpMode = process.argv.includes("--mcp");
const fileToolsMode = process.argv.includes("--file-tools");
const pdfMode = process.argv.includes("--pdf-test");
const imageMode = process.argv.includes("--image-test");
const extended = process.argv.includes("--agents");
const mode = workflowMode ? "workflow" : browserMode ? "browser" : resumeMode ? "resume" : stressMode ? "agent-stress" : mcpMode ? "mcp" : extended ? "agents" : imageMode ? "image" : pdfMode ? "pdf" : fileToolsMode ? "file-tools" : "daemon";
const here = dirname(fileURLToPath(import.meta.url));
const binary = resolve(here, "../../dist/bin/agenc.js");
const state = await createTuiGateState({ injectedEnv: {
  AGENC_PROVIDER: "anthropic", AGENC_MODEL: "claude-sonnet-5",
  AGENC_EXPERIMENTAL_CLAUDE_SUBSCRIPTION: "1",
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: process.env.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND || join(homedir(), ".local/bin/claude"),
  AGENC_MAX_TURNS: browserMode ? "56" : (extended || stressMode || workflowMode) ? "32" : "14", AGENC_MAX_OUTPUT_TOKENS: "2048", AGENC_EFFORT_LEVEL: "none",
}, prefix: "agenc-claude-live-tools" });
let child;
let fixtureServer;
let browserUrl;
try {
  const project = createTuiGateProject(state);
  const nonce = randomUUID();
  const imageCode = "VISION-" + randomUUID().slice(0, 8).toUpperCase();
  const imagePath = pdfMode ? join(project, "attachment.pdf") : join(state.agencHome, "test-image.png");
  if (imageMode || pdfMode) {
    const made = spawnSync("python3", ["-c", "from PIL import Image,ImageDraw,ImageFont; import sys; im=Image.new('RGB',(900,200),'white'); ImageDraw.Draw(im).text((30,65),sys.argv[2],fill='black',font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',48)); im.save(sys.argv[1])", imagePath, imageCode]);
    assert.equal(made.status, 0, made.stderr.toString());
  }
  await writeFile(join(project, "input.txt"), nonce + "\n");
  if (workflowMode) await writeFile(join(project, "fixture.ipynb"), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: "fixture-cell", cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: ["print('BEFORE')"] }] }));
  await writeFile(join(state.agencHome, "config.toml"), 'config_version = 2\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[permissions]\nallow = ["FileRead", "Write", "exec_command(printf CLAUDE_EXEC_OK)"]\n[tools_config.exec_command]\ndefault_permission_mode = "never"\n');
  if (extended || stressMode || fileToolsMode || workflowMode) {
    const configPath = join(state.agencHome, "config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace('"Write",', '"Write", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "NotebookRead", "NotebookEdit", "CronCreate", "CronList", "CronDelete", "Edit", "Glob", "Grep", "spawn_agent", "list_agents", "wait_agent", "send_message", "assign_task", "close_agent",'));
  }
  if (mcpMode) {
    const configPath = join(state.agencHome, "config.toml");
    const config = (await readFile(configPath, "utf8")).replace('"Write",', '"Write", "mcp.fixture.ping",');
    const fixture = resolve(here, "readonly-mcp.cjs");
    await writeFile(configPath, config + `\n[mcp_servers.fixture]\nvirtual_no_fs_write_tools = ["ping"]\ntransport = "stdio"\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}, ${JSON.stringify(join(project, "mcp.pid"))}]\ntimeout = 10000\n`);
  }
  if (browserMode) {
    fixtureServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><body><h1>Browser fixture ${nonce}</h1><label>Message<input id="message"></label><button onclick="document.getElementById('result').textContent=document.getElementById('message').value">Apply</button><p id="result">waiting</p><div style="height:1500px">scroll area</div></body></html>`);
    });
    await new Promise(resolveListen => fixtureServer.listen(0, "127.0.0.1", resolveListen));
    browserUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;
    const configPath = join(state.agencHome, "config.toml");
    await writeFile(configPath, (await readFile(configPath, "utf8")).replace('"Write",', '"Write", "Browser",') + '\n[browser]\nheadless = true\nexecutable_path = "/opt/google/chrome/chrome"\nno_sandbox = true\nallow_private_network = true\n');
  }
  await writeTuiGateTrust(state.env, [project]);
  await startTuiGateDaemon(state, binary);
  if (mcpMode) {
    const listing = spawnSync(process.execPath, [binary, "mcp", "list"], { cwd: project, env: state.env, encoding: "utf8", timeout: 20_000 });
    console.log("MCP_CONFIG", listing.stdout, listing.stderr);
  }
  const basePrompt = stressMode ? "Exercise real concurrent AgenC agents. Spawn reader_a and reader_b, fork_turns none and isolation none, each to FileRead input.txt and return its exact nonce. Start both before waiting; call list_agents and wait for both results. Close both. Then spawn cancel_me to repeatedly FileRead input.txt 20 times before answering; while it is running, use close_agent on cancel_me and verify it is absent from list_agents. Do not wait for cancel_me to finish its 20 reads. Then yourself FileRead input.txt, exec_command `printf CLAUDE_EXEC_OK`, Write output.txt with the exact input nonce plus newline, FileRead output.txt. Final checklist only: output.txt matches input.txt; command stdout is CLAUDE_EXEC_OK. Re-run both checks if verifier requests." : extended ? "Test the AgenC agent lifecycle in this isolated workspace. Spawn one reusable agent named reader, fork_turns none, isolation none. Its task: FileRead input.txt and return the exact nonce, no edits. Call list_agents; send_message to reader with reminder to report the literal nonce. Use wait_agent and list_agents until reader is idle. Then assign_task to reader: FileRead input.txt again and return SECOND plus nonce. Wait for that second result. Close reader with close_agent and call list_agents to confirm closure. Then yourself use FileRead input.txt, exec_command `printf CLAUDE_EXEC_OK`, Write output.txt containing nonce plus newline, FileRead output.txt. Final checklist only two acceptance items: output.txt contains nonce; exec_command produces CLAUDE_EXEC_OK. Include evidence. Re-run both checks if completion verifier asks. Complete every requested lifecycle operation before finishing." : "Work in this workspace. Use FileRead to read input.txt, exec_command to run `printf CLAUDE_EXEC_OK`, and Write to copy the input nonce plus one newline to output.txt. Verify output.txt with FileRead. Final answer: a checklist with two acceptance items only: output.txt contains the input nonce, and exec_command produced CLAUDE_EXEC_OK. Include the observed evidence and literal nonce. Re-run both checks if the completion verifier asks. Do not add checklist items about response formatting or tool identities.";
  const prompt = basePrompt + (workflowMode ? " Also exercise these real tools: TaskCreate a fixture task, TaskGet it, TaskUpdate it to completed, TaskList to verify. NotebookRead fixture.ipynb; NotebookEdit replace the cell source with print(\"AFTER\"); NotebookRead to verify. CronCreate a non-durable task scheduled 0 0 1 1 * with prompt FIXTURE_ONLY, CronList, CronDelete that job immediately, CronList to verify removal. Do not send any external messages or schedule delivery. Discover each deferred tool with system.searchTools as needed. Do all these operations before finishing." : "") + (browserMode ? ` Also discover Browser and test every action on the local fixture ${browserUrl}: navigate, snapshot, type text BROWSER_OK into Message, press_key Tab, click Apply, get_text and verify BROWSER_OK, screenshot, scroll down, new_tab to the same URL, tabs, select_tab to the original tab, close_tab on the extra tab. Use observed refs and tab ids. Include BROWSER_OK as evidence. Do all 12 actions before finishing.` : "") + (mcpMode ? " Also discover and call mcp.fixture.ping from the configured MCP server. It must return pong. Include that observed result. Do not invent the tool output." : "") + (fileToolsMode ? " Also use Glob to find *.txt, Grep to locate the nonce in input.txt, Write to create edit-test.txt containing BEFORE, Edit to replace BEFORE with AFTER, and FileRead to verify edit-test.txt. Finish only after all those real tool calls succeeded." : "") + (pdfMode ? " Also inspect @attachment.pdf as an attached PDF. Read its visible code and use Write to save only that code plus newline in image-code.txt. Do not use tools to extract or read the PDF; use its attached document content. Include the code in final evidence." : "") + (imageMode ? " Also read the code visible in the attached image and use Write to save only that code plus newline to image-code.txt. Obtain it visually from the attachment, without reading the image file with tools. Include the observed code in your final evidence." : "");
  const output = await new Promise((resolveRun, reject) => {
    child = spawn(process.execPath, [binary, ...(imageMode ? ["--image", imagePath] : []), "-p", prompt], { cwd: project, env: state.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, 480_000);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  });
  let resumedOutput;
  if (resumeMode) {
    assert.equal(output.code, 0);
    await stopTuiGateDaemon(state);
    await startTuiGateDaemon(state, binary);
    resumedOutput = await new Promise((resolveRun, reject) => {
      child = spawn(process.execPath, [binary, "-c", "-p", "Resume the previous task. Recall the nonce from our prior conversation, then FileRead output.txt to verify it and run exec_command `printf CLAUDE_EXEC_OK`. Include literal RESUMED plus the nonce and observed stdout. Checklist only file content and command output. Re-run checks if verification asks."], { cwd: project, env: state.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
      child.on("error", reject);
      child.on("close", code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
    });
    assert.equal(resumedOutput.code, 0, JSON.stringify(resumedOutput));
    assert(resumedOutput.stdout.includes("RESUMED") && resumedOutput.stdout.includes(nonce), JSON.stringify(resumedOutput));
  }
  async function walk(dir) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await walk(path));
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) files.push(path);
    }
    return files;
  }
  const rollouts = await walk(join(state.agencHome, "projects"));
  const rows = (await Promise.all(rollouts.map(path => readFile(path, "utf8")))).flatMap(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  const events = rows.filter(row => row.type === "event_msg").map(row => row.payload.msg);
  await writeFile(`/tmp/agenc-claude-${mode}-rollout.json`, JSON.stringify(rows, null, 2));
  const starts = events.filter(event => event.type === "tool_call_started").map(event => event.payload);
  const completions = events.filter(event => event.type === "tool_call_completed").map(event => event.payload);
  // Failure diagnostics contain only the synthetic fixture, never account credentials.
  console.log(JSON.stringify({ code: output.code, stdout: output.stdout, stderr: output.stderr, starts, completions }, null, 2));
  assert.equal(output.code, 0, "AgenC print session failed");
  if (imageMode || pdfMode) assert.equal((await readFile(join(project, "image-code.txt"), "utf8")).trim(), imageCode);
  assert.equal(await readFile(join(project, "output.txt"), "utf8"), nonce + "\n");
  if (fileToolsMode) assert.equal((await readFile(join(project, "edit-test.txt"), "utf8")).trim(), "AFTER");
  for (const name of ["FileRead", "exec_command", "Write", ...(workflowMode ? ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "NotebookRead", "NotebookEdit", "CronCreate", "CronList", "CronDelete"] : []), ...(browserMode ? ["Browser"] : []), ...(mcpMode ? ["mcp.fixture.ping"] : []), ...(fileToolsMode ? ["Glob", "Grep", "Edit"] : []), ...(extended ? ["spawn_agent", "list_agents", "wait_agent", "send_message", "assign_task", "close_agent"] : [])]) assert(starts.some(call => call.toolName === name && completions.some(done => done.callId === call.callId && !done.isError)), `Missing successful real ${name} call`);
  for (const call of starts) assert(completions.some(done => done.callId === call.callId), `Missing durable result for ${call.callId}`);
  assert(completions.every(done => !done.isError), "A tool failed during qualification");
  if (imageMode || pdfMode) {
    assert(!starts.some(call => call.toolName === "FileRead" && /\.(png|pdf)/i.test(call.args)), "Attachment was read with a tool instead of supplied multimodally");
  }
  if (workflowMode) assert((await readFile(join(project, "fixture.ipynb"), "utf8")).includes("AFTER"));
  if (browserMode) {
    const actions = starts.filter(call => call.toolName === "Browser").map(call => JSON.parse(call.args).action);
    for (const action of ["navigate", "snapshot", "type", "press_key", "click", "get_text", "screenshot", "scroll", "new_tab", "tabs", "select_tab", "close_tab"]) assert(actions.includes(action), `Missing Browser ${action}`);
  }
  if (extended) {
    assert(completions.some(done => done.toolName === "wait_agent" && done.result.includes("SECOND " + nonce)), "Missing second-task nonce receipt");
    const inventories = completions.filter(done => done.toolName === "list_agents");
    const lastAgents = JSON.parse(inventories.at(-1).result).agents;
    assert(lastAgents.length === 1 && lastAgents[0].agent_name === "/root", "Child remained in final inventory");
  }
  assert(completions.some(done => done.toolName === "exec_command" && done.metadata?.stdout === "CLAUDE_EXEC_OK" && done.metadata?.exitCode === 0));
  assert(output.stdout.includes(nonce) && output.stdout.includes("CLAUDE_EXEC_OK"));
  assert(!output.stderr.includes("completion gate exhausted"), "AgenC completion verification was exhausted");
  assert(events.some(event => event.type === "completion_gate" && event.payload?.outcome === "verified"), "Missing verified completion event");
  const evidence = { date: new Date().toISOString(), passed: true, route: "anthropic/claude-sonnet-5 via experimental official CLI transport", exitCode: output.code,
    toolCalls: starts.map(call => ({ callId: call.callId, toolName: call.toolName, args: call.args })),
    ...(resumedOutput ? { resumedOutput } : {}), toolResults: completions, finalOutput: output.stdout, fileContentVerified: true, ...((imageMode || pdfMode) ? { attachmentCodeVerified: imageCode, attachmentRoute: pdfMode ? "PDF file mention through real daemon" : "CLI --image through real daemon" } : {}),
    completionGate: events.filter(event => event.type === "completion_gate").map(event => event.payload),
    note: "Real daemon and Session/runTurn; isolated workspace-write sandbox, approval policy never. Subscription billing meter was not inspected." };
  await writeFile(join(here, `${mode}-validation.json`), JSON.stringify(evidence, null, 2) + "\n");
  console.log("DAEMON_TOOL_TEST_PASSED");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (mcpMode) for (const record of state.daemonProcesses.values()) console.log("MCP_DAEMON", record.stdout, record.stderr);
  await teardownTuiGateState(state, binary);
  if (fixtureServer) await new Promise(resolveClose => fixtureServer.close(resolveClose));
}
