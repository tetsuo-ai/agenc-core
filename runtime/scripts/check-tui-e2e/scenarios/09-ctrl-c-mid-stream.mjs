import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export const meta = {
  description: "Escape aborts a held Grok stream and records turn cancellation.",
  timeoutMs: 60_000,
  args: ["--provider", "grok", "--model", "grok-4.6"],
};

export default async function (session) {
  const activeResponses = new Set();
  let streamStarted = false;
  let streamClosed = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.stream !== true) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          id: "resp_escape_prewarm",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: body.model,
          output: [{
            type: "message",
            id: "msg_escape_prewarm",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "OK", annotations: [] }],
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      if (streamStarted) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_escape_followup",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            model: body.model,
            output: [{
              type: "message",
              id: "msg_escape_followup",
              role: "assistant",
              status: "completed",
              content: [{
                type: "output_text",
                text: "GROK_INTERRUPT_FOLLOWUP_OK",
                annotations: [],
              }],
            }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        })}\n\ndata: [DONE]\n\n`);
        return;
      }
      streamStarted = true;
      activeResponses.add(response);
      response.on("close", () => {
        streamClosed = true;
        activeResponses.delete(response);
      });
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      response.write(`data: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: "item_escape",
        output_index: 0,
        content_index: 0,
        delta: "GROK_INTERRUPT_STREAM_ACTIVE",
      })}\n\n`);
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
      AGENC_PROVIDER: "grok",
      AGENC_MODEL: "grok-4.6",
      AGENC_MAX_OUTPUT_TOKENS: "4096",
      GROK_AUTH_MODE: "api-key",
      XAI_API_KEY: "local-inert-escape-key",
      XAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AGENC_AUTH_MANAGED_KEYS_ENABLED: "0",
    });
    await session.start();
    await session.waitForPrompt({ timeout: 15_000 });
    await session.submit("Produce a response for the interruption test.");
    await session.waitFor(/GROK_INTERRUPT_STREAM_ACTIVE/u, { timeout: 15_000 });
    assert.equal(streamStarted, true);
    assert.equal(streamClosed, false);
    session.send("\x1b");
    const deadline = Date.now() + 4_000;
    while (!streamClosed && Date.now() < deadline) {
      session.throwIfAborted();
      await delay(50);
    }
    assert.equal(streamClosed, true, "Escape did not close Grok's active HTTP stream");
    const terminalDeadline = Date.now() + 4_000;
    let aborted = [];
    while (Date.now() < terminalDeadline) {
      session.throwIfAborted();
      const items = await session.readRolloutItems();
      const events = items
        .filter((item) => item.type === "event_msg")
        .map((item) => item.payload.msg);
      aborted = events.filter((event) => event.type === "turn_aborted");
      if (aborted.length > 0) break;
      await delay(50);
    }
    assert.equal(aborted.length, 1, "Escape must durably abort exactly one turn");
    assert.equal(aborted[0].payload.reason, "interrupted");
    await session.waitForIdle({ idleWindow: 1_500, timeout: 5_000 });
    await session.submit("Reply to this follow-up after the interrupted turn.");
    await session.waitFor(/GROK_INTERRUPT_FOLLOWUP_OK/u, { timeout: 15_000 });
    await session.waitForIdle({ idleWindow: 1_500, timeout: 5_000 });
    const finalEvents = (await session.readRolloutItems())
      .filter((item) => item.type === "event_msg")
      .map((item) => item.payload.msg);
    assert.equal(finalEvents.filter((event) => event.type === "turn_started").length, 2);
    assert.equal(finalEvents.filter((event) => event.type === "turn_aborted").length, 1);
    assert.equal(finalEvents.filter((event) => event.type === "turn_complete").length, 1);
  } finally {
    for (const response of activeResponses) response.destroy();
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
