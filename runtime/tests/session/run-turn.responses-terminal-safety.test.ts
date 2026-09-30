import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { Session } from "../../src/session/session.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

// mkSession's canonical initial binding uses this synthetic model; the actual
// OpenAI adapter is explicitly configured to use its Responses transport.
const MODEL = "test-model";
const TOOL = "terminal_safety_counter";
const CALL = "call-terminal-safety";
const ITEM = { type: "function_call", id: "item-terminal-safety", call_id: CALL,
  name: TOOL, arguments: '{"marker":"synthetic"}', status: "completed" };
const USAGE = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "terminal safety fixture cleanup failed");
});

function frames(terminal: Record<string, unknown> | null) {
  const events = [
    { type: "response.created", response: { id: "response-one", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...ITEM, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: ITEM.id, output_index: 0, delta: ITEM.arguments },
    { type: "response.function_call_arguments.done", item_id: ITEM.id, output_index: 0, arguments: ITEM.arguments },
    // Complete item/arguments are deliberately observable BEFORE terminal failure.
    { type: "response.output_item.done", output_index: 0, item: ITEM },
    ...(terminal ? [terminal] : []),
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function response(chunks: string[]) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function terminal(type: string, status: string, extra: Record<string, unknown> = {}) {
  return { type, response: { id: "response-one", model: MODEL, status, output: [ITEM], usage: USAGE, ...extra } };
}

async function exercise(firstTerminal: Record<string, unknown> | null) {
  const cwd = mkdtempSync(join(tmpdir(), "responses-terminal-safety-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const execute = vi.fn(async () => ({ content: "counted once", isError: false }));
  const counter: Tool = { name: TOOL, description: "Synthetic in-memory execution counter; no I/O.",
    inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false },
    metadata: { mutating: false, virtualNoFsWrites: true, deferred: false },
    recoveryCategory: "idempotent", execute };
  let session: Session;
  // This is a parser→provider→runTurn dispatch regression, not financial
  // admission evidence. The existing Session fixture is explicitly non-admitted.
  // Registry/router/permissions/runTurn and the OpenAI provider are real.
  const registry = buildToolRegistry({ workspaceRoot: cwd, extraTools: [counter],
    requireAdmission: false, getSession: () => session });
  let fetchCount = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; tools?: Array<{ name?: string }> };
    expect(body.stream).toBe(true);
    expect(body.tools?.some(tool => tool.name === TOOL)).toBe(true);
    const count = ++fetchCount;
    if (count === 1) return response(frames(firstTerminal));
    if (count === 2) return response([
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
        id: "response-two", model: MODEL, status: "completed", usage: USAGE,
        output: [{ type: "message", id: "answer", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Finished." }] }],
      } })}\n\n`,
    ]);
    throw new Error("unexpected synthetic fetch retry");
  });
  const provider = new OpenAIProvider({ apiKey: "synthetic-unused-key", model: MODEL,
    useResponsesApi: true, maxRetries: 0, fetchImpl });
  const permissions = new PermissionModeRegistry(createEmptyToolPermissionContext({
    alwaysAllowRules: { session: [TOOL] },
  }));
  const built = mkSession({ cwd, provider, registry, modelInfo: { slug: MODEL },
    services: { admissionRequired: false, permissionModeRegistry: permissions } });
  session = built.session;
  cleanup.push(() => session.shutdown());
  await drain(runTurn(session, mkCtx({ cwd, modelInfo: { ...mkCtx().modelInfo, slug: MODEL },
    collaborationMode: { model: MODEL }, modelProviderId: "openai",
  }), "Call the synthetic counter exactly once, then finish."));
  return { execute, fetchImpl, events: built.events, session };
}

describe("Responses terminal safety across the real provider and runTurn", () => {
  test.each([
    ["incomplete length", terminal("response.incomplete", "incomplete", { incomplete_details: { reason: "max_output_tokens" } })],
    ["incomplete filter", terminal("response.incomplete", "incomplete", { incomplete_details: { reason: "content_filter" } })],
    ["incomplete error", terminal("response.incomplete", "incomplete", { incomplete_details: { reason: "error" } })],
    ["failed response", terminal("response.failed", "failed", { error: { code: "invalid_request_error", message: "Synthetic failure" } })],
    ["error event", { type: "error", code: "invalid_request_error", message: "Synthetic failure", status: 400 }],
  ])("%s cannot dispatch a completed function item", async (_label, end) => {
    const state = await exercise(end as Record<string, unknown>);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.events.some(event => event.msg.type === "tool_call_completed" && event.msg.payload.callId === CALL)).toBe(false);
    expect(state.session.snapshotHistoryMessages().some(message => message.role === "tool" && message.toolCallId === CALL)).toBe(false);
    // Length/generic errors may request a tool-free recovery answer. Neither
    // that retry policy nor the absence of a retry is the safety assertion.
    expect(state.fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(state.fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test("successful response completion dispatches the same item once", async () => {
    const state = await exercise(terminal("response.completed", "completed"));
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({ marker: "synthetic" }));
    expect(state.fetchImpl).toHaveBeenCalledTimes(2);
    expect(state.events.filter(event => event.msg.type === "tool_call_completed" && event.msg.payload.callId === CALL))
      .toHaveLength(1);
  });
});
