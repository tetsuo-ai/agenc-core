import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { buildAttachmentAssemblyEvidence } from "../../src/prompts/attachments/assembly-evidence.js";
import { attachmentsToMessages } from "../../src/prompts/attachments/messages.js";
import type { Attachment } from "../../src/prompts/attachments/types.js";
import { buildPreparedSamplingEvidence, preparedSemanticDigest, validatePreparedSamplingEvidence,
  type PreparedSamplingFacts, type PreparedSamplingValidator } from "../../src/session/prepared-sampling-evidence.js";
import type { StreamModelRequestContract } from "../../src/phases/stream-model.js";

const request = (): StreamModelRequestContract => ({ managedRequestId: "00000000-0000-4000-8000-000000000001",
  input: [{ role: "user", content: "PRIVATE_TASK" }], tools: [{ type: "function", function: { name: "PRIVATE_TOOL", description: "PRIVATE_DESCRIPTION", parameters: { type: "object" } } }],
  baseInstructions: "PRIVATE_INSTRUCTIONS", parallelToolCalls: false });
const facts = (): PreparedSamplingFacts => ({ turnId: "PRIVATE_TURN", rootHumanTurn: { turnId: "PRIVATE_TURN", text: "PRIVATE_TASK" },
  sourceMessageCount: 1, preAttachmentMessageCount: 1, retainedAttachmentBlocks: 0, retainedAttachmentMessages: 0, rawAttachmentOutputs: 0,
  assembly: buildAttachmentAssemblyEvidence("ordinary", ["date_change"], [{ status: "fulfilled", value: [] }]) });

describe("bounded prepared semantic evidence", () => {
  test("ordered detached frozen payload hashes content and arbitrary IDs/names", () => {
    const source = request(), inputFacts = facts();
    const report = buildPreparedSamplingEvidence(source, inputFacts);
    expect(report.inventory).toBe("complete");
    expect(report.details?.root.matchesActiveTurn).toBe(true);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
    expect(report.details?.assembly).not.toBe(inputFacts.assembly);
    expect(Object.isFrozen(report.details?.assembly.outcomes[0]?.outputKinds)).toBe(true);
    expect(() => { (report.details!.messages as unknown[]).push({}); }).toThrow();
    source.input[0]!.content = "changed";
    expect(report.details?.messages[0]?.digest).not.toBe(preparedSemanticDigest(source.input[0]));
  });
  test("codec v1 is stable across property order; missing/null/undefined/-0 are distinct", () => {
    expect(preparedSemanticDigest({ b: 2, a: 1 })).toBe(preparedSemanticDigest({ a: 1, b: 2 }));
    expect(new Set([{}, { a: null }, { a: undefined }, { a: 0 }, { a: -0 }].map(preparedSemanticDigest)).size).toBe(5);
    expect(preparedSemanticDigest({ a: null, b: undefined, c: "😀", d: -0, e: 1e21 }))
      .toBe("e0262f8e4007adbd034153525f9667966467e4d1aacec14057361893307fcdc5");
    const absent = buildPreparedSamplingEvidence(request(), facts());
    const explicit = buildPreparedSamplingEvidence({ ...request(), toolChoice: undefined }, facts());
    expect(absent.details?.fields.find(field => field.field === "toolChoice")).toMatchObject({ present: false, digest: null });
    expect(explicit.details?.fields.find(field => field.field === "toolChoice")).toMatchObject({ present: true, digest: expect.any(String) });
  });
  test.each([NaN, Infinity, -Infinity, "\ud800", "\udfff", { ["\ud800"]: 1 }, 1n, Symbol(), new Date(), new Map(), new Uint8Array(1), new Array(2), () => {}])("unsupported data becomes unknown, never truncated", value => {
    const source = request();
    (source.tools[0]!.function.parameters as Record<string, unknown>).extra = value;
    expect(buildPreparedSamplingEvidence(source, facts())).toMatchObject({ inventory: "unknown", details: null });
  });
  test("no getter, proxy trap or toJSON is invoked; cycles, depth and byte overflow refuse", () => {
    let touched = 0;
    const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { touched++; return "secret"; } });
    const proxy = new Proxy({}, { ownKeys() { touched++; throw null; } });
    const json = { toJSON() { touched++; return {}; } };
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: unknown = {}; for (let i = 0; i < 40; i++) deep = { deep };
    for (const value of [getter, proxy, json, cycle, deep, "a".repeat(16 * 1024 * 1024 + 1)]) expect(() => preparedSemanticDigest(value)).toThrow();
    expect(touched).toBe(0);
  });
  test("root absence/staleness, retained records and raw rendered-empty outputs remain distinct", () => {
    expect(buildPreparedSamplingEvidence(request(), { ...facts(), rootHumanTurn: null }).details?.root).toMatchObject({ present: false, matchesActiveTurn: false });
    expect(buildPreparedSamplingEvidence(request(), { ...facts(), rootHumanTurn: { turnId: "stale", text: "PRIVATE_TASK" } }).details?.root).toMatchObject({ present: true, matchesActiveTurn: false });
    const altered = buildPreparedSamplingEvidence(request(), { ...facts(), retainedAttachmentBlocks: 1, retainedAttachmentMessages: 0, rawAttachmentOutputs: 1 });
    expect(altered.details?.counts).toMatchObject({ retainedBlocks: 1, retainedMessages: 0, rawAttachmentOutputs: 1 });
    expect(buildPreparedSamplingEvidence(request(), { ...facts(), assembly: undefined }).inventory).toBe("unknown");
    const rejected = buildAttachmentAssemblyEvidence("ordinary", ["date_change"], [{ status: "rejected", reason: "SECRET" }]);
    expect(buildPreparedSamplingEvidence(request(), { ...facts(), assembly: rejected }).details?.assembly.outcomes[0]?.status).toBe("rejected");
  });
  test("unknown request keys and invalid generated IDs are never exported", () => {
    expect(buildPreparedSamplingEvidence({ ...request(), surprise: 1 } as StreamModelRequestContract, facts()).inventory).toBe("unknown");
    expect(buildPreparedSamplingEvidence({ ...request(), managedRequestId: "PRIVATE_ID" }, facts())).toMatchObject({ inventory: "unknown", managedRequestId: null });
  });
  test("nonempty actual attachment inventory remains nonzero when renderer emits no messages", () => {
    const outputs: Attachment[] = [{ kind: "mcp_instructions_delta", addedNames: [], addedBlocks: [], removedNames: [] }];
    expect(attachmentsToMessages(outputs)).toEqual([]);
    const assembly = buildAttachmentAssemblyEvidence("ordinary", ["mcp_instructions_delta"], [{ status: "fulfilled", value: outputs }]);
    const report = buildPreparedSamplingEvidence(request(), { ...facts(), assembly, rawAttachmentOutputs: outputs.length });
    expect(report.details?.counts.rawAttachmentOutputs).toBe(1);
    expect(report.details?.assembly.outcomes[0]?.outputCount).toBe(1);
  });
  test("local-read-only and unknown producer inventory retain their weaker status", () => {
    const local = buildAttachmentAssemblyEvidence("local_read_only", [], []);
    expect(buildPreparedSamplingEvidence(request(), { ...facts(), assembly: local }).details?.assembly.collection).toBe("local_read_only");
    const overflow = buildAttachmentAssemblyEvidence("ordinary", ["date_change"], [{ status: "fulfilled", value: new Array(257) }]);
    expect(buildPreparedSamplingEvidence(request(), { ...facts(), assembly: overflow }).details?.assembly.inventory).toBe("unknown");
  });
  test("callback exact undefined; sanitized throw and hostile thenables never assimilated", () => {
    let touched = 0;
    const report = buildPreparedSamplingEvidence(request(), facts());
    const signal = new AbortController().signal;
    for (const result of [null, false, 0, {}, { get then() { touched++; throw null; } }]) {
      expect(() => validatePreparedSamplingEvidence(report, (() => result) as unknown as PreparedSamplingValidator, signal)).toThrow("Prepared sampling validation failed");
    }
    expect(() => validatePreparedSamplingEvidence(report, () => { throw "PRIVATE_ERROR"; }, signal)).toThrow("Prepared sampling validation failed");
    expect(touched).toBe(0);
    expect(() => validatePreparedSamplingEvidence(report, () => undefined, signal)).not.toThrow();
  });
  test("original cancellation identity wins before, during and after callback", () => {
    const report = buildPreparedSamplingEvidence(request(), facts());
    const reason = { private: true };
    for (const during of [false, true]) {
      const controller = new AbortController(); if (!during) controller.abort(reason);
      let received: unknown;
      try { validatePreparedSamplingEvidence(report, () => { controller.abort(reason); throw null; }, controller.signal); } catch (error) { received = error; }
      expect(received).toBe(reason);
    }
  });
  test("native Promise rejection containment in a strict isolated process", () => {
    const moduleUrl = pathToFileURL(resolve("src/session/prepared-sampling-evidence.ts")).href;
    const code = `import {validatePreparedSamplingEvidence} from ${JSON.stringify(moduleUrl)};
let touched=0;
for(const callback of [()=>Promise.resolve(),()=>Promise.reject(null),()=>{const p=Promise.reject('private');p.then=()=>{touched++;throw null};return p;}]) {
let refused=false;try{validatePreparedSamplingEvidence({},callback,new AbortController().signal)}catch(error){refused=error.code==='prepared_sampling_validation_failed'}if(!refused)process.exit(2);
} await new Promise(resolve=>setImmediate(resolve));if(touched)process.exit(3);console.log('contained');`;
    const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", code], { env: {}, encoding: "utf8", timeout: 3000, maxBuffer: 4096 });
    expect(result.status).toBe(0); expect(result.stdout.trim()).toBe("contained"); expect(result.stderr).toBe("");
  });
});
