#!/usr/bin/env node
/**
 * One-shot prompt through the AgenC embedding SDK, on either transport.
 *
 * Build the package first, then run from the repo root:
 *
 *   npm run build --workspace=@tetsuo-ai/agenc-sdk
 *   node packages/agenc-sdk/examples/one-shot.mjs "say hello in one word"
 *   node packages/agenc-sdk/examples/one-shot.mjs --transport subprocess "say hello"
 *
 * The daemon transport talks JSON-RPC to `~/.agenc/daemon.sock` (starting
 * the daemon via `agenc daemon start` when needed). The subprocess
 * transport spawns `agenc -p --output-format stream-json` instead — no
 * daemon socket access required by this process.
 */

import { connect, promptViaSubprocess } from "../dist/index.js";

const args = process.argv.slice(2);
const transportIndex = args.indexOf("--transport");
const transport = transportIndex >= 0 ? args[transportIndex + 1] : "daemon";
const prompt =
  args.filter((a, i) => i !== transportIndex && i !== transportIndex + 1).join(" ") ||
  "In one short sentence, what is AgenC?";

async function consume(run) {
  for await (const event of run) {
    if (event.type === "text") process.stdout.write(event.delta);
    else if (event.type === "tool_call") {
      process.stderr.write(`\n[tool] ${event.toolName} (${event.requestId})\n`);
    } else if (event.type === "permission_request") {
      process.stderr.write(`\n[permission] ${event.toolName ?? "?"} requested\n`);
    }
  }
  const result = await run.result();
  process.stdout.write("\n---\n");
  process.stdout.write(
    `stop=${result.stopReason} exit=${result.exitCode}` +
      (result.usage ? ` tokens=${result.usage.totalTokens} cost=$${result.usage.costUsd}` : "") +
      "\n",
  );
  return result.exitCode;
}

let exitCode = 1;
if (transport === "subprocess") {
  exitCode = await consume(promptViaSubprocess(prompt, {}));
} else {
  const client = await connect({
    clientName: "agenc-sdk-example",
    // Allow-nothing by default: deny every tool permission but log it.
    onPermissionRequest: (request) => {
      process.stderr.write(`\n[deny] ${request.toolName ?? "tool"}\n`);
      return { behavior: "deny", reason: "example runs read-only" };
    },
  });
  try {
    const session = await client.createSession();
    exitCode = await consume(session.prompt(prompt));
    await session.terminate("example done");
  } finally {
    await client.close();
  }
}
process.exit(exitCode);
