import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { resumeTurnFromCheckpoint } from "../../src/conversation/thread-manager.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { RETRY_TRUNCATED_TOOL_CONTENT } from "../../src/recovery/max-output-tokens.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

// Real provider/parser, canonical registry, permissions, SQLite admission and
// rollout checkpoint/reconstruction. Only fetch and the harmless tool are fake.
// This proves orderly same-process resume, not crash or power-loss recovery.
const MODEL = "test-model", TOOL = "recovery_counter";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "recovery fixture cleanup failed");
});

type Answer = "length" | "tool" | "stop";
function sse(answer: Answer, call: number, responses: boolean) {
  const id = `call-${call}`, args = answer === "length" ? '{"marker":"NEVER_REPLAY_PARTIAL' : '{"marker":"complete"}';
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  let chunks: string[];
  if (responses) {
    const item = { type: "function_call", id: `item-${call}`, call_id: id, name: TOOL, arguments: args };
    const terminal = answer === "length" ? "response.incomplete" : "response.completed";
    const output = answer === "stop" ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished." }] }] : [item];
    const events = [
      { type: "response.created", response: { id: `response-${call}`, status: "in_progress", output: [] } },
      ...(answer === "stop" ? [] : [
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args },
      ]),
      { type: terminal, response: { id: `response-${call}`, model: MODEL, status: answer === "length" ? "incomplete" : "completed",
        ...(answer === "length" ? { incomplete_details: { reason: "max_output_tokens" } } : {}), output, usage } },
    ];
    chunks = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } else {
    chunks = [JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: answer === "stop" ? { content: "Finished." } : {
      tool_calls: [{ index: 0, id, type: "function", function: { name: TOOL, arguments: args } }],
    }, finish_reason: null }] }), JSON.stringify({ choices: [{ index: 0, delta: {},
      finish_reason: answer === "length" ? "length" : answer === "tool" ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), "[DONE]"]
      .map(data => `data: ${data}\n\n`);
  }
  return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
}

function fixture(options: { responses: boolean; answers: Answer[]; stopAtCorrection?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "admitted-truncation-"));
  cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const cwd = join(root, "workspace"), home = join(root, "home");
  mkdirSync(join(cwd, ".git"), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  let clock = new Date("2026-01-01T00:00:00Z");
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "truncation-test", ownerPid: process.pid, now: () => clock });
  cleanup.push(() => kernel.close());
  const requests: Record<string, unknown>[] = [];
  const execute = vi.fn(async () => ({ content: "counted", isError: false }));
  const provider = new OpenAIProvider({ apiKey: "synthetic-unused-key", model: MODEL, useResponsesApi: options.responses,
    maxRetries: 0, maxTokens: 512, fetchImpl: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const answer = options.answers[requests.length - 1];
      if (!answer) throw new Error("unexpected synthetic fetch");
      return sse(answer, requests.length, options.responses);
    } });
  const storeOptions = { cwd, agencHome: home, sessionId: "conv-test", agencVersion: "0.18.0",
    sessionTempRoot: root, autoStartScheduler: false };
  const metadata = { sessionId: "conv-test", cwd, timestamp: new Date().toISOString(), originator: "truncation-test",
    agencVersion: "0.18.0", model: MODEL, modelProvider: "openai" };
  const ctx = () => mkCtx({ cwd, modelInfo: { ...mkCtx().modelInfo, slug: MODEL, maxOutputTokens: 512, maxOutputTokensExplicit: true },
    collaborationMode: { model: MODEL }, modelProviderId: "openai" });
  function attach(resume = false) {
    let session: Session;
    const admission = kernel.bindClient({ cwd, scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false,
      deadlineAt: "2026-01-01T00:01:00Z" } });
    const registry = buildToolRegistry({ workspaceRoot: cwd, requireAdmission: true, getSession: () => session,
      extraTools: [{ name: TOOL, description: "Synthetic counter", recoveryCategory: "idempotent",
        inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false },
        metadata: { mutating: false, virtualNoFsWrites: true, deferred: false }, execute }] });
    const built = mkSession({ cwd, provider, registry, modelInfo: { slug: MODEL, maxOutputTokens: 512 }, services: {
      executionAdmission: admission, admissionRequired: true,
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
      permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext({ alwaysAllowRules: { session: [TOOL] } })),
    } });
    session = built.session;
    cleanup.push(() => session.shutdown());
    Object.assign(session.config, { durableTurns: { resume: { requireLease: false } } });
    const store = new RolloutStore({ ...storeOptions, resume });
    cleanup.push(() => { session.mountRolloutStore(null); store.close(); });
    store.open(metadata); session.mountRolloutStore(store);
    if (resume) session.eventLog.seedCanonicalHistory(store.readAll().flatMap(item => item.type === "event_msg" ? [item.payload] : []));
    const unbind = bindExecutionAdmissionJournal(session, admission); cleanup.push(unbind);
    if (!resume && options.stopAtCorrection) session.eventLog.subscribe(event => {
      if (event.msg.type === "turn_checkpoint" && event.msg.payload.resumableState.maxOutputTokensRecoveryCount === 1) {
        // Canonical checkpoint is committed, but the next model has not been
        // admitted. Use the real shutdown signal, not an admission bypass.
        session.abortController.abort("daemon_shutdown");
      }
    });
    return { session, store, events: built.events, close: async () => { unbind(); await session.shutdown(); session.mountRolloutStore(null); store.close(); } };
  }
  const first = attach();
  return { ...first, execute, requests, ctx, attach,
    expire: () => { clock = new Date("2026-01-01T00:02:00Z"); },
    journal: () => kernel.listJournal({ cwd, runId: "conv-test" }),
    run: () => drain(runTurn(first.session, ctx(), "Call the counter once, then finish.")),
  };
}

function correctionCount(value: unknown) {
  return JSON.stringify(value).split(RETRY_TRUNCATED_TOOL_CONTENT).length - 1;
}

describe("admitted generic complete-JSON recovery", () => {
  test.each([true, false])("route Responses=%s retries a fresh complete call and dispatches once", async responses => {
    const f = fixture({ responses, answers: ["length", "tool", "stop"] });
    await f.run();
    expect(f.requests).toHaveLength(3);
    for (const request of f.requests) expect(request[responses ? "max_output_tokens" : "max_completion_tokens"]).toBe(512);
    expect(correctionCount(f.requests[1])).toBe(1);
    expect(JSON.stringify(f.requests[1])).not.toContain("NEVER_REPLAY_PARTIAL");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ marker: "complete" }));
    expect(f.journal().filter(row => row.kind === "tool_exec" && row.event === "dispatched")).toHaveLength(1);
    expect(f.journal().filter(row => row.kind === "model_turn" && row.event === "dispatched")).toHaveLength(3);
  });

  test.each(["tool", "exhaust", "deny"] as const)("canonical resume retains correction once and spent counter: %s", async outcome => {
    const f = fixture({ responses: true, answers: outcome === "tool" ? ["length", "tool", "stop"] : ["length", "length", "length", "length"],
      stopAtCorrection: true });
    await f.run();
    expect(f.requests).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
    await f.close();
    const second = f.attach(true);
    const reconstruction = reconstructFromRollout(second.store.readAll(), {
      checkpointProjection: second.store.checkpointProjectionContext("truncation-resume"),
    });
    expect(reconstruction.resumableTurns).toHaveLength(1);
    const recovered = reconstruction.resumableTurns[0]!;
    expect(recovered.checkpointIntegrityStatus).toBe("valid");
    expect(recovered.lastCheckpoint.resumableState.maxOutputTokensRecoveryCount).toBe(1);
    expect(recovered.lastCheckpoint.resumableState.modelSampleResumePrompt).toBeUndefined();
    const spentOrdinal = recovered.lastCheckpoint.resumableState.modelSampleOrdinal!;
    expect(spentOrdinal).toBeGreaterThan(0);
    expect(correctionCount(second.store.readAll().filter(item => item.type === "response_item"))).toBe(1);
    if (outcome === "deny") f.expire();
    await expect(resumeTurnFromCheckpoint(second.session, reconstruction, undefined, { ctx: f.ctx() })).resolves.toMatchObject({ resumed: true });
    for (const request of f.requests) expect(request.max_output_tokens).toBe(512);
    const modelSteps = f.journal().filter(row => row.kind === "model_turn" && row.event === "dispatched").map(row => row.stepId);
    expect(new Set(modelSteps).size).toBe(modelSteps.length);
    if (outcome === "deny") {
      expect(f.requests).toHaveLength(1);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.journal().some(row => row.kind === "model_turn" && row.event === "cancelled")).toBe(true);
    } else {
      expect(correctionCount(f.requests[1])).toBe(1);
      expect(JSON.stringify(f.requests[1])).not.toContain("NEVER_REPLAY_PARTIAL");
      expect(f.requests).toHaveLength(outcome === "tool" ? 3 : 4);
      expect(modelSteps[1]).toContain(`sample-${spentOrdinal + 1}:`);
      expect(f.execute).toHaveBeenCalledTimes(outcome === "tool" ? 1 : 0);
      if (outcome === "exhaust") {
        const checkpoints = second.store.readAll().flatMap(item => item.type === "event_msg" && item.payload.msg.type === "turn_checkpoint"
          ? [item.payload.msg.payload.resumableState.maxOutputTokensRecoveryCount] : []);
        expect(Math.max(...checkpoints)).toBe(3);
      }
    }
  });
});
