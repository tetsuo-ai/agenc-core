/** DRAFT: execute only after coordinator review. Synthetic callback tests, not
 * canonical bootstrap/preflight, live producer, observer or client execution.
 * All financial writes use fresh retained temporary roots. No native network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparedSemanticDigest as digest } from "agenc-selected/session/prepared-sampling-evidence.js";
import type { IndependentMaterial, SelectedBinding } from "./companion-validator.js";
import { canonicalBytes, createFixtureCallbacks, PUBLISHER_FILES, type FixtureCallbacksInput } from "./fixture-callbacks.js";
import { compatibility } from "./compatibility-selection.mjs";
import { readPublisherBinding } from "./publisher-record-parent.mjs";
import { PINS } from "./dispatcher-v6.mjs";
import { createFinancialOwner } from "../luna-finance-mode-v2/owner.mjs";
import { financialPolicyId } from "../luna-finance-mode-v2/journal.mjs";
import { createResponsesTerminal } from "../luna-terminal-v1/terminal.mjs";

const FAIR = "/private/tmp/light-takeover/fair-confirmation";
const TASK = "Say Done. Do not invoke any tool.";
const PRODUCERS = ["plan_mode", "verify_plan_reminder", "auto_mode", "swarm_mode",
  "deferred_tools_delta", "requested_tools", "agent_listing_delta", "mcp_instructions_delta",
  "date_change", "instruction_update", "critical_reminder", "output_style", "relevant_memories",
  "changed_files", "lsp_diagnostics", "agent_mentions", "mcp_resources", "file_mentions", "skill_listing"] as const;
const ENV = ["LUNA_LEDGER_ROOT", "LUNA_RUN_DIR", "LUNA_RUN_ID", "LUNA_TASK_CALL_CAP",
  "LUNA_CAPTURE_METADATA", "LUNA_CAPTURE_METADATA_SHA256"] as const;
const saved = new Map<string, string | undefined>();
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const identity = (name: string) => {
  const st = fs.statSync(name, { bigint: true }); return { dev: String(st.dev), ino: String(st.ino) };
};
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture_object_required");
  return value as Record<string, unknown>;
}
const readObject = (name: string) => object(JSON.parse(fs.readFileSync(name, "utf8")));
function material(): IndependentMaterial {
  const instructions = "Synthetic independent static instructions.\n\nSynthetic independent dynamic suffix.";
  return { version: 1, task: TASK, instructions, tools: [],
    assembly: { schemaVersion: 1, collection: "ordinary", inventory: "complete", unknownReason: null,
      outcomes: PRODUCERS.map(producer => ({ producer, status: "fulfilled", outputCount: 0, outputKinds: [] })) },
    semantic: { instructionsDigest: digest(instructions),
      messages: [{ role: "user", contentForm: "text", digest: digest({ role: "user", content: TASK }) }],
      tools: [], fields: [{ field: "lightReasoningEffort", present: true, digest: digest(undefined) },
        { field: "openaiReasoningReplay", present: true, digest: digest(true) }] },
    wireTemplate: { model: "gpt-6-luna", stream: true, store: false,
      instructions: "Synthetic independent static instructions.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: TASK }] },
        { type: "message", role: "system", content: [{ type: "input_text", text: "Synthetic independent dynamic suffix." }] }],
      tools: [], max_output_tokens: 8192, reasoning: { effort: "low", summary: "auto" },
      include: ["reasoning.encrypted_content"], parallel_tool_calls: true },
    generatedSlots: ["conversationId/prompt_cache_key", "rootTurnId", "managedRequestId", "user-initial-threadId"],
    equivalence: "fresh-empty-resource-only", selectedOrWireObserved: false };
}
function setup(spendPolicy: FixtureCallbacksInput["spendPolicy"] = { mode: "positive_cap", capUsd: "0.1" }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-callback-unit-")));
  fs.chmodSync(root, 0o700);
  const runDirectory = path.join(root, "run"), financialRoot = path.join(root, "finance");
  fs.mkdirSync(runDirectory, { mode: 0o700 }); fs.mkdirSync(financialRoot, { mode: 0o700 });
  const ledger = path.join(financialRoot, "luna-api-ledger.jsonl");
  fs.writeFileSync(ledger, "", { flag: "wx", mode: 0o600 });
  const r = identity(financialRoot), j = identity(ledger);
  const selected = readObject(path.join(FAIR, "current-base-binding-v2/source-pins.json"));
  const deployed: Record<string, string> = {};
  for (const [name, hash] of Object.entries(selected)) {
    if (typeof hash !== "string") throw new Error("fixture_source_hash_required");
    deployed["runtime/" + name] = hash;
  }
  const independent = material();
  const input: FixtureCallbacksInput = { material: independent, independentMaterialDigest: digest(independent),
    protocolId: "synthetic-cli-callback-v1", financialRunId: "financial-unit-run", publicationChannelId: "unit-channel",
    runDirectory, runDirectoryIdentity: identity(runDirectory), financialRoot,
    financialInventory: { rootDev: r.dev, rootIno: r.ino, journalDev: j.dev, journalIno: j.ino,
      prefixBytes: 0, prefixSha256: sha("") }, spendPolicy, financialPolicyId: financialPolicyId(spendPolicy),
    deployedSourcePins: deployed, clientArtifactSha256: sha("synthetic-unexecuted-artifact"),
    configurationSha256: sha("synthetic-declaration-not-deployment"),
    pythonPath: "/synthetic/unexecuted/python", pythonSha256: sha("synthetic-unexecuted-interpreter"), fairRoot: FAIR };
  const binding: SelectedBinding = { conversationId: "source-conversation", rootTurnId: "source-root",
    managedRequestId: "11111111-1111-4111-8111-111111111111", admissionRunId: "core-admission-run",
    independentMaterialDigest: input.independentMaterialDigest,
    wire: { ...independent.wireTemplate, prompt_cache_key: "source-conversation" } };
  process.env.LUNA_LEDGER_ROOT = financialRoot; process.env.LUNA_RUN_DIR = runDirectory;
  process.env.LUNA_RUN_ID = input.financialRunId; process.env.LUNA_TASK_CALL_CAP = "1";
  delete process.env.LUNA_CAPTURE_METADATA; delete process.env.LUNA_CAPTURE_METADATA_SHA256;
  const parentExpected = { binding_profile_id: compatibility.bindingProfile, protocol_id: input.protocolId,
    run_id: input.financialRunId, publication_channel_id: input.publicationChannelId,
    independent_material_digest: input.independentMaterialDigest, task_prompt_sha256: sha(TASK),
    client_artifact_sha256: input.clientArtifactSha256, configuration_sha256: input.configurationSha256,
    source_inventory_sha256: sha(canonicalBytes(deployed)), ...PINS };
  const admit = (raw: Buffer) => createFinancialOwner({ root: financialRoot, runId: input.financialRunId,
    taskCallCap: 1, inventory: input.financialInventory, spendPolicy, policyId: input.financialPolicyId }).admit(raw, 8192);
  return { root, input, binding, ledger, runDirectory, parentExpected, admit,
    raw: () => Buffer.from(JSON.stringify(binding.wire)),
    callbacks: () => createFixtureCallbacks(input),
    parent: () => readPublisherBinding({ runDirectory, runDirectoryIdentity: input.runDirectoryIdentity, expected: parentExpected }) };
}
const request = (raw: Buffer) => new Request("https://api.openai.com/v1/responses", {
  method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" }, body: raw.toString("utf8") });
function noHandoff() {
  expect(process.env.LUNA_CAPTURE_METADATA).toBeUndefined();
  expect(process.env.LUNA_CAPTURE_METADATA_SHA256).toBeUndefined();
}
describe.sequential("one-call fixture publisher and native callback (synthetic only)", () => {
  beforeEach(() => { for (const key of ENV) saved.set(key, process.env[key]); });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV) {
      const old = saved.get(key); if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
    saved.clear(); // Retain fresh roots and every partial publication for inspection.
  });

  it.each([{ mode: "positive_cap", capUsd: "0.1" }, { mode: "credit_exhaustion" }] as const)(
    "publishes exact independent artifact joins accepted by the parent: $mode", spendPolicy => {
      const t = setup(spendPolicy), callbacks = t.callbacks();
      expect(callbacks.publishInitialBinding(t.binding)).toBeUndefined();
      const joined = t.parent(); // Expected fields were sealed in setup, before publication; no ACK input.
      expect(joined.finalization_authorized).toBe(false);
      expect(joined.record_sha256).toBe(callbacks.snapshot().recordHash);
      expect(joined.record.managed_request_id).toBe(t.binding.managedRequestId);
      expect(joined.record.admission_run_id).toBe(t.binding.admissionRunId);
      expect(joined.record.run_id).not.toBe(t.binding.admissionRunId);
      expect(joined.dispatcher.snapshot().acknowledgments).toEqual([]);
      expect(joined.dispatcher.snapshot().expected.max_publications).toBe(1);
      for (const [key, name] of Object.entries(PUBLISHER_FILES)) {
        const filename = path.join(t.runDirectory, name), bytes = fs.readFileSync(filename);
        expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
        expect(bytes).toEqual(canonicalBytes(readObject(filename)));
        if (["contract", "policy", "metadata"].includes(key)) expect(sha(bytes)).toBe(joined.record[key + "_sha256"]);
      }
      expect(identity(path.join(t.runDirectory, PUBLISHER_FILES.pending))).toEqual(identity(path.join(t.runDirectory, PUBLISHER_FILES.record)));
      const metadata = readObject(path.join(t.runDirectory, PUBLISHER_FILES.metadata));
      expect(object(metadata.financial).spend_policy).toEqual(spendPolicy);
      expect(object(object(metadata.binding).expected).contract_sha256).toBe(joined.record.contract_sha256);
      expect(process.env.LUNA_CAPTURE_METADATA).toBe(path.join(t.runDirectory, PUBLISHER_FILES.metadata));
      expect(process.env.LUNA_CAPTURE_METADATA_SHA256).toBe(joined.record.metadata_sha256);
      expect(fs.readFileSync(t.ledger).byteLength).toBe(0); // Publication is not an admission.
    });

  it("compares independently declared bytes after a real synthetic admit; finite SSE alone never settles", async () => {
    const t = setup(), callbacks = t.callbacks(); callbacks.publishInitialBinding(t.binding);
    const raw = t.raw(), admitted = t.admit(raw), before = fs.readFileSync(t.ledger);
    expect(admitted.ordinal).toBe(1);
    const response = await callbacks.fakeNativeFetch(request(raw));
    const reader = response.body!.getReader(), pieces: Buffer[] = [];
    const terminal = createResponsesTerminal({ httpStatus: response.status,
      contentType: response.headers.get("Content-Type"), expectedModel: "gpt-6-luna" });
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      pieces.push(Buffer.from(next.value)); terminal.push(next.value);
    }
    reader.releaseLock();
    expect(terminal.finish("eof")).toMatchObject({ state: "known", input: 100, output: 20, cached: 0, chargeNanos: "20000" });
    const frames = Buffer.concat(pieces).toString("utf8").trim().split("\n\n")
      .map(frame => object(JSON.parse(frame.slice("data: ".length))));
    expect(frames.map(frame => frame.type)).toEqual(["response.created", "response.output_item.added",
      "response.content_part.added", "response.output_text.delta", "response.output_text.done",
      "response.content_part.done", "response.output_item.done", "response.completed"]);
    expect(frames.map(frame => frame.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(fs.readFileSync(t.ledger)).toEqual(before); // The unchanged observer, not this fixture, must settle.
    await expect(callbacks.fakeNativeFetch(request(raw))).rejects.toThrow("cli_fixture_callback_refused");
    expect(fs.readFileSync(t.ledger)).toEqual(before);
    expect(callbacks.snapshot()).toMatchObject({ published: true, fetched: true, failed: true });
  });

  it("snapshots declarations once and rejects duplicate publication without overwriting", () => {
    const t = setup(), callbacks = t.callbacks();
    Object.defineProperty(t.input, "financialRunId", { value: "mutated-after-factory" });
    callbacks.publishInitialBinding(t.binding);
    const before = fs.readFileSync(path.join(t.runDirectory, PUBLISHER_FILES.record));
    expect(t.parent().record.run_id).toBe("financial-unit-run");
    expect(() => callbacks.publishInitialBinding(t.binding)).toThrow("cli_fixture_callback_refused");
    expect(fs.readFileSync(path.join(t.runDirectory, PUBLISHER_FILES.record))).toEqual(before);
    expect(callbacks.snapshot().failed).toBe(true);
  });

  it.each(["wire", "slot", "material"] as const)("refuses %s drift before publication and remains failed", part => {
    const t = setup(), callbacks = t.callbacks();
    const changed: SelectedBinding = part === "wire" ? { ...t.binding, wire: { ...t.binding.wire, max_output_tokens: 8191 } }
      : part === "slot" ? { ...t.binding, conversationId: "wrong-slot" }
      : { ...t.binding, independentMaterialDigest: sha("different independent material") };
    expect(() => callbacks.publishInitialBinding(changed)).toThrow("cli_fixture_callback_refused");
    expect(() => callbacks.publishInitialBinding(t.binding)).toThrow("cli_fixture_callback_refused");
    expect(fs.readdirSync(t.runDirectory)).toEqual([]); noHandoff();
  });

  it("refuses bad independent source/material identities and unexpected pre-import environment", () => {
    const t = setup();
    expect(() => createFixtureCallbacks({ ...t.input, independentMaterialDigest: sha("wrong") })).toThrow();
    expect(() => createFixtureCallbacks({ ...t.input, deployedSourcePins: {} })).toThrow();
    process.env.LUNA_TASK_CALL_CAP = "2";
    expect(t.callbacks).toThrow(); process.env.LUNA_TASK_CALL_CAP = "1";
    process.env.LUNA_CAPTURE_METADATA = "/unexpected/earlier.json";
    expect(t.callbacks).toThrow();
    expect(process.env.LUNA_CAPTURE_METADATA).toBe("/unexpected/earlier.json");
    expect(fs.readdirSync(t.runDirectory)).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])("fsync failure %i refuses handoff, with no retry or deletion", failure => {
    const t = setup(), callbacks = t.callbacks(), original = fs.fsyncSync.bind(fs);
    let count = 0;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (++count === failure) throw new Error("synthetic sync failure"); original(fd);
    });
    expect(() => callbacks.publishInitialBinding(t.binding)).toThrow("cli_fixture_callback_refused");
    spy.mockRestore();
    expect(count).toBe(failure); noHandoff();
    expect(callbacks.snapshot()).toMatchObject({ consumed: true, published: false, failed: true });
    const files = fs.readdirSync(t.runDirectory);
    expect(files.length).toBeGreaterThan(0);
    expect(files.includes(PUBLISHER_FILES.record)).toBe(failure === 9);
    expect(() => callbacks.publishInitialBinding(t.binding)).toThrow();
    expect(fs.readdirSync(t.runDirectory)).toEqual(files);
    expect(fs.readFileSync(t.ledger).byteLength).toBe(0);
  });

  it.each(["write", "link"] as const)("%s failure preserves partial evidence but no publication handoff", operation => {
    const t = setup(), callbacks = t.callbacks();
    const spy = operation === "write"
      ? vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("synthetic write failure"); })
      : vi.spyOn(fs, "linkSync").mockImplementation(() => { throw new Error("synthetic link failure"); });
    expect(() => callbacks.publishInitialBinding(t.binding)).toThrow("cli_fixture_callback_refused");
    spy.mockRestore(); noHandoff();
    expect(fs.existsSync(path.join(t.runDirectory, PUBLISHER_FILES.record))).toBe(false);
    expect(fs.readdirSync(t.runDirectory).length).toBeGreaterThan(0);
    expect(callbacks.snapshot()).toMatchObject({ consumed: true, published: false, failed: true });
  });

  it("refuses fetch before publication and requires an exact financial admission", async () => {
    const before = setup(), early = before.callbacks();
    await expect(early.fakeNativeFetch(request(before.raw()))).rejects.toThrow();
    expect(() => early.publishInitialBinding(before.binding)).toThrow();
    const noAdmission = setup(), callbacks = noAdmission.callbacks(); callbacks.publishInitialBinding(noAdmission.binding);
    await expect(callbacks.fakeNativeFetch(request(noAdmission.raw()))).rejects.toThrow();
    expect(fs.readFileSync(noAdmission.ledger).byteLength).toBe(0);
  });

  it.each(["drift", "duplicate-key", "numeric-lexeme", "wrong-admit-hash"] as const)(
    "refuses %s and never changes the existing financial reservation", async kind => {
      const t = setup(), callbacks = t.callbacks(); callbacks.publishInitialBinding(t.binding);
      let raw = t.raw();
      if (kind === "drift") raw = Buffer.from(JSON.stringify({ ...t.binding.wire, instructions: "changed" }));
      if (kind === "duplicate-key") raw = Buffer.from('{"model":"gpt-6-luna",' + raw.toString("utf8").slice(1));
      if (kind === "numeric-lexeme") raw = Buffer.from(raw.toString("utf8").replace('"max_output_tokens":8192', '"max_output_tokens":8192.0'));
      t.admit(kind === "wrong-admit-hash" ? Buffer.from(JSON.stringify(t.binding.wire, null, 2)) : raw);
      const before = fs.readFileSync(t.ledger);
      await expect(callbacks.fakeNativeFetch(request(raw))).rejects.toThrow("cli_fixture_callback_refused");
      expect(fs.readFileSync(t.ledger)).toEqual(before);
      expect(callbacks.snapshot().failed).toBe(true);
    });

  it("does not invoke descriptor getters and encodes Python-compatible integer key order", () => {
    let hits = 0;
    const bad = Object.defineProperty({}, "secret", { enumerable: true, get() { hits++; return "never-read"; } });
    expect(() => canonicalBytes(bad)).toThrow(); expect(hits).toBe(0);
    expect(canonicalBytes({ "2": "two", "10": "ten", "\ue000": "bmp", "\u{10000}": "astral" }).toString())
      .toBe('{"10":"ten","2":"two","\\ue000":"bmp","\\ud800\\udc00":"astral"}');
    expect(() => canonicalBytes({ value: undefined })).toThrow();
  });
});
