import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { ExecutionAdmissionKernel } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/budget/execution-admission-kernel.js";
import { OpenAIProvider } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/llm/providers/openai/adapter.js";
import { runTurn } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/runtime-options.js";
import { bindExecutionAdmissionJournal } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/execution-admission-journal.js";
import { Session } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/session.js";
import { RolloutStore } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/rollout-store.js";
import { AsyncQueue } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/utils/async-queue.js";
import { mkCtx, mkSession } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/tests/fixtures.js";
import { withFixtureCleanup } from "./cleanup.js";

// Real current source/Light loop and model admission; fake fetch only. This is
// not a built CLI, monetary transport guard, initial binding or capture proof.
const MODEL = "gpt-6-luna";
const policyPath = "/private/tmp/light-takeover/fair-confirmation/all-call-policy-v1/policy.py";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const policyBytes = JSON.stringify({ schema_version: 1, profile: "fixed-luna-v1",
  route: "openai-direct", client: "light", controls: {
    model: MODEL, stream: true, store: false, max_output_tokens: 8192,
    reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"],
    parallel_tool_calls: true, prompt_cache_key: "conv-test",
  } });
// Expected policy is sealed before any session/request exists. It is never
// generated from the request being checked; only the request digest is observed.
const policySha = sha(policyBytes);
function check(raw: string, ordinal: number) {
  expect(sha(readFileSync(policyPath))).toBe("c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf");
  const code = `import sys,json,base64,importlib.util
s=importlib.util.spec_from_file_location("p",${JSON.stringify(policyPath)})
p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
x=json.load(sys.stdin)
print(json.dumps(p.check_request(request_bytes=base64.b64decode(x["request"]),policy_bytes=base64.b64decode(x["policy"]),expected_policy_sha256=x["sha"],route="openai-direct",client="light",call_ordinal=x["ordinal"])))`;
  const child = spawnSync("/usr/bin/python3", ["-c", code], {
    input: JSON.stringify({ request: Buffer.from(raw).toString("base64"), policy: Buffer.from(policyBytes).toString("base64"), sha: policySha, ordinal }),
    encoding: "utf8", timeout: 10000, maxBuffer: 16384,
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as { policy_verified: boolean; reason: string | null; request_sha256: string; policy_sha256: string };
}

function answer(length: boolean, ordinal: number) {
  const event = { type: length ? "response.incomplete" : "response.completed", response: {
    id: `synthetic-${ordinal}`, model: MODEL, status: length ? "incomplete" : "completed",
    ...(length ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: length ? "Partial" : "Done" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  } };
  return new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

async function probe(summary: "auto" | "none", cap: number) {
  return withFixtureCleanup(async register => {
  const root = mkdtempSync(join(tmpdir(), "light-policy-probe-"));
  const cwd = join(root, "workspace"), home = join(root, "home");
  mkdirSync(cwd); mkdirSync(home, { mode: 0o700 });
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "policy-probe", ownerPid: process.pid });
  register(50, () => kernel.close());
  const admission = kernel.bindClient({ cwd, scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false } });
  const verdicts: ReturnType<typeof check>[] = [];
  const bodies: string[] = [];
  const provider = new OpenAIProvider({ apiKey: "synthetic-not-a-key", model: MODEL,
    useResponsesApi: true, maxRetries: 0, maxTokens: cap,
    fetchImpl: async (_url, init) => {
      if (bodies.length >= 2) throw new Error("unexpected additional synthetic request");
      const raw = String(init?.body);
      bodies.push(raw); verdicts.push(check(raw, bodies.length));
      // Observation only: returning scripted data even on policy mismatch
      // deliberately does not pretend this test installs a pre-admission guard.
      return answer(bodies.length === 1, bodies.length);
    },
  });
  // mkSession deliberately fixes test-model in its configuration. Use its
  // synthetic service template, but construct the real provider Session with
  // the correct explicit model before binding (never hide a binding conflict).
  const seed = mkSession({ cwd });
  register(40, () => seed.session.shutdown());
  const { providerService: _seedProviderService, ...templateServices } = seed.session.services;
  const session = new Session({ conversationId: "conv-test",
    services: { ...templateServices, provider, executionAdmission: admission, admissionRequired: true,
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }), providerEnvironment: {},
    }, initialState: { history: [], sessionConfiguration: { ...seed.state.sessionConfiguration,
      collaborationMode: { model: MODEL }, provider } },
    config: { ...seed.session.config, model: MODEL }, features: seed.session.features, jsRepl: { id: "policy-probe" },
    modelInfo: { ...mkCtx().modelInfo, slug: MODEL, maxOutputTokens: cap }, eventQueue: new AsyncQueue(),
  });
  register(10, () => session.shutdown());
  register(20, () => session.mountRolloutStore(null));
  const store = new RolloutStore({ cwd, agencHome: home, sessionId: "conv-test", agencVersion: "0.18.0",
    sessionTempRoot: root, autoStartScheduler: false });
  register(30, () => store.close());
  store.open({ sessionId: "conv-test", cwd, timestamp: new Date().toISOString(), originator: "policy-probe",
    agencVersion: "0.18.0", model: MODEL, modelProvider: "openai" });
  session.mountRolloutStore(store);
  const unbind = bindExecutionAdmissionJournal(session, admission);
  register(0, unbind);
  expect(session.services.provider).toBe(provider);
  const failures: string[] = [];
  const unsubscribe = session.eventLog.subscribe(event => {
    if (event.msg.type === "error") failures.push(JSON.stringify(event.msg));
  });
  register(1, unsubscribe);
    const ctx = mkCtx({ cwd, reasoningEffort: "low", reasoningSummary: summary,
      modelProviderId: "openai", collaborationMode: { model: MODEL },
      modelInfo: { ...mkCtx().modelInfo, slug: MODEL, maxOutputTokens: cap, maxOutputTokensExplicit: true,
        supportedReasoningLevels: [] },
    });
    for await (const event of runTurn(session, ctx, "Say Done. Do not invoke a tool.")) {
      failures.push(JSON.stringify(event, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value).slice(0, 2000));
    }
    expect(bodies, JSON.stringify(failures)).toHaveLength(2);
    expect(bodies[0]).not.toBe(bodies[1]);
    for (const raw of bodies) {
      const emitted = JSON.parse(raw);
      expect(emitted.max_output_tokens).toBe(cap);
      expect(emitted.reasoning).toEqual(summary === "auto" ? { effort: "low", summary: "auto" } : { effort: "low" });
    }
    expect(kernel.listJournal({ cwd, runId: "conv-test" }).filter(row => row.kind === "model_turn" && row.event === "dispatched")).toHaveLength(2);
    return verdicts;
  });
  // Private generated journal roots are retained. No real accounting root is read.
}

describe("current79b admitted Light requests versus independently frozen fixed policy", () => {
  test("initial and recovery calls preserve fixed low/auto/8192/encrypted replay declaration", async () => {
    const verdicts = await probe("auto", 8192);
    for (const verdict of verdicts) expect(verdict).toMatchObject({ policy_verified: true, reason: null, policy_sha256: policySha });
    expect(verdicts[0].request_sha256).not.toBe(verdicts[1].request_sha256);
  });
  test("real emitted missing summary remains a mismatch on both calls", async () => {
    for (const verdict of await probe("none", 8192)) expect(verdict).toMatchObject({ policy_verified: false, reason: "request_policy_mismatch" });
  });
  test("real emitted smaller explicit cap is not matched-budget evidence", async () => {
    for (const verdict of await probe("auto", 8191)) expect(verdict).toMatchObject({ policy_verified: false, reason: "request_policy_mismatch" });
  });
});

describe("fixture cleanup preserves primary failures and attempts every acquired resource", () => {
  test("setup failure cleans already acquired resources in dependency order", async () => {
    const seen: number[] = [], primary = new Error("synthetic setup failure");
    await expect(withFixtureCleanup(async register => {
      register(50, () => { seen.push(50); });
      register(10, () => { seen.push(10); });
      throw primary;
    })).rejects.toBe(primary);
    expect(seen).toEqual([10, 50]);
  });
  test("throwing shutdown does not skip later cleanup or lose original failure", async () => {
    const seen: number[] = [], primary = new Error("primary"), closeError = new Error("close");
    let caught: unknown;
    try { await withFixtureCleanup(async register => {
      register(50, async () => { seen.push(50); });
      register(10, async () => { seen.push(10); throw closeError; });
      register(30, () => { seen.push(30); });
      throw primary;
    }); } catch (error) { caught = error; }
    expect(seen).toEqual([10, 30, 50]);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([primary, closeError]);
  });
  test("successful body does not hide cleanup failure, including non-Error values", async () => {
    let caught: unknown;
    try { await withFixtureCleanup(async register => { register(1, () => { throw null; }); return 7; }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([null]);
  });
});
