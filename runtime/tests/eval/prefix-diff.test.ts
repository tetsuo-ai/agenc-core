import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderTraceSink } from "../../src/llm/provider-trace-sink.js";
import {
  compareTraceRequests,
  describeDivergence,
  firstDivergence,
  isPrefixStable,
  loadTraceRequests,
  reportPrefixStability,
} from "../../scripts/eval/prefix-diff.mjs";

const base = {
  instructions: "You are the agent.",
  input: [
    { role: "system", content: "static head" },
    { role: "user", content: "first prompt" },
  ],
  tools: [{ name: "FileRead", parameters: { a: 1 } }, { name: "Write", parameters: { b: 2 } }],
};

describe("firstDivergence", () => {
  it("treats appended input items as an unchanged prefix", () => {
    const next = { ...base, input: [...base.input, { role: "assistant", content: "ok" }, { role: "tool", content: "done" }] };
    expect(firstDivergence(base, next)).toBeNull();
    expect(describeDivergence(null)).toContain("unchanged");
  });

  it("locates a change inside the instructions with its offset", () => {
    const next = { ...base, instructions: "You are the agent. Time: 12:01" };
    const divergence = firstDivergence(base, next);
    expect(divergence).toMatchObject({ field: "instructions", index: -1, offsetChars: 18, approxTokens: 5 });
    expect(divergence?.after).toContain("Time: 12:01");
  });

  it("locates a rewritten input item and counts the bytes before it", () => {
    const next = { ...base, input: [base.input[0], { role: "user", content: "first prompt, edited" }] };
    const divergence = firstDivergence(base, next);
    expect(divergence?.field).toBe("input");
    expect(divergence?.index).toBe(1);
    expect(divergence?.role).toBe("user");
    // instructions plus the whole first item precede the differing byte.
    expect(divergence?.offsetChars).toBeGreaterThan(base.instructions.length + JSON.stringify(base.input[0]).length);
    expect(describeDivergence(divergence)).toContain("input[1] (user)");
  });

  it("reports tool list churn by name and schema", () => {
    const next = { ...base, tools: [{ name: "Write", parameters: { b: 2 } }, { name: "FileRead", parameters: { a: 1, c: 3 } }, { name: "Grep", parameters: {} }] };
    const divergence = firstDivergence(base, next);
    expect(divergence).toMatchObject({ field: "tools", added: ["Grep"], removed: [], reordered: true, changedSchemas: ["FileRead"] });
    expect(describeDivergence(divergence)).toContain("added Grep");
  });

  it("treats the trailing system suffix moving to the end as an unchanged prefix", () => {
    const suffix = { role: "system", content: "# Session-specific guidance" };
    const prev = { ...base, input: [...base.input, suffix] };
    const next = { ...base, input: [...base.input, { role: "assistant", content: "ok" }, { role: "tool", content: "r" }, suffix] };
    const divergence = firstDivergence(prev, next);
    expect(divergence).toMatchObject({ field: "input", index: 2, suffixMoved: true, appended: 2 });
    expect(isPrefixStable(divergence)).toBe(true);
    expect(describeDivergence(divergence)).toContain("trailing system suffix");
    expect(reportPrefixStability([{ seq: 1, body: prev }, { seq: 2, body: next }]).at(-1)).toBe("2 requests, 1 pairs, 1 with an unchanged prefix");
  });

  it("reports removed input items as a divergence at the removal point", () => {
    const next = { ...base, input: [base.input[0]] };
    expect(firstDivergence(base, next)).toMatchObject({ field: "input", index: 1, removed: 1 });
  });

  it("summarizes a run of requests", () => {
    const requests = [
      { seq: 1, body: base },
      { seq: 2, body: { ...base, input: [...base.input, { role: "assistant", content: "ok" }] } },
      { seq: 3, body: { ...base, instructions: "You are the agent!", input: [...base.input, { role: "assistant", content: "ok" }] } },
    ];
    const lines = reportPrefixStability(requests);
    expect(lines[0]).toContain("#1 -> #2: prefix unchanged");
    expect(lines[1]).toContain("#2 -> #3: instructions (system) at offset 17 chars");
    expect(lines.at(-1)).toBe("3 requests, 2 pairs, 1 with an unchanged prefix");
  });
});

// A Grok continuation chain: the first request sends the whole prompt, which
// ends with the permission tail; each later one names the previous response
// in previous_response_id and sends only the items added since.
const tail = { role: "system", content: "# Permission Mode: default" };
const root = { ...base, input: [...base.input, tail] };
const toolOutput = (callId: string) => ({ type: "function_call_output", call_id: callId, output: "done" });
const chained = (previousResponseId: string, ...input: object[]) => ({ ...base, previous_response_id: previousResponseId, input });
/** The chars/4 estimate for `copies` copies of an item. */
const tokens = (item: object, copies = 1) => Math.round((JSON.stringify(item).length * copies) / 4);

describe("continuation chains", () => {
  it("reports one duplicate for a two-request chain whose deltas both end with the same system item", () => {
    const requests = [
      { seq: 1, body: root, responseId: "resp_1" },
      { seq: 2, body: chained("resp_1", toolOutput("call_1"), tail), responseId: "resp_2" },
    ];
    expect(compareTraceRequests(requests)).toEqual([{
      from: 1,
      to: 2,
      divergence: null,
      chain: {
        previousResponseId: "resp_1",
        root: 1,
        requests: 2,
        duplicates: 1,
        approxTokens: tokens(tail),
        repeatedItems: [{
          role: "system",
          digest: expect.stringMatching(/^[0-9a-f]{16}$/u),
          copies: 2,
          seqs: [1, 2],
          itemChars: JSON.stringify(tail).length,
          approxTokens: tokens(tail),
          preview: JSON.stringify(tail),
        }],
      },
    }]);
    expect(reportPrefixStability(requests)).toEqual([
      `#1 -> #2: continues #1 (chain from #1, 2 requests); 1 duplicate system/user item(s), ~${tokens(tail)} tokens`,
      `    system x2 (#1, #2), ~${tokens(tail)} tokens: ${JSON.stringify(JSON.stringify(tail))}`,
      "2 requests, 0 pairs, 0 with an unchanged prefix",
      `1 chained requests, 1 with duplicate system/user items, ~${tokens(tail)} duplicate tokens in total`,
    ]);
  });

  it("compares unchained requests pairwise, as the --json report always did", () => {
    const requests = [
      { seq: 1, body: base, responseId: "resp_1" },
      { seq: 2, body: { ...base, input: [...base.input, { role: "assistant", content: "ok" }] }, responseId: "resp_2" },
      { seq: 3, body: { ...base, instructions: "You are the agent!" }, responseId: "resp_3" },
    ];
    const before = requests.slice(1).map((request, index) => ({
      from: requests[index].seq,
      to: request.seq,
      divergence: firstDivergence(requests[index].body, request.body),
    }));
    expect(compareTraceRequests(requests)).toEqual(before);
    expect(reportPrefixStability(requests).at(-1)).toBe("3 requests, 2 pairs, 1 with an unchanged prefix");
  });

  it("counts every extra copy a chain accumulates, of system and user items only", () => {
    const reminder = { role: "user", content: "<system-reminder>Auto mode still active.</system-reminder>" };
    const requests = [
      { seq: 1, body: root, responseId: "resp_1" },
      { seq: 2, body: chained("resp_1", toolOutput("call_1"), reminder, tail), responseId: "resp_2" },
      { seq: 3, body: chained("resp_2", toolOutput("call_1"), reminder, tail), responseId: "resp_3" },
    ];
    // #3 repeats #2's tool output as well; only system and user items count.
    const third = compareTraceRequests(requests)[1];
    expect(third).toMatchObject({
      from: 2,
      to: 3,
      chain: { root: 1, requests: 3, duplicates: 3, approxTokens: tokens(tail, 2) + tokens(reminder) },
    });
    expect(third.chain.repeatedItems.map(({ role, seqs }) => [role, seqs])).toEqual([["system", [1, 2, 3]], ["user", [2, 3]]]);
  });

  it("compares a full request that follows a chain with the previous full request", () => {
    const history = [...base.input, { role: "assistant", content: "ok" }, toolOutput("call_1")];
    const requests = [
      { seq: 1, body: root, responseId: "resp_1" },
      { seq: 2, body: chained("resp_1", toolOutput("call_1")), responseId: "resp_2" },
      { seq: 3, body: { ...base, input: [...history, tail] }, responseId: "resp_3" },
    ];
    const lines = reportPrefixStability(requests);
    expect(lines[0]).toBe("#1 -> #2: continues #1 (chain from #1, 2 requests); no duplicate system/user items");
    expect(lines[1]).toContain("#1 -> #3: prefix unchanged up to the trailing system suffix");
    expect(lines.slice(2)).toEqual([
      "3 requests, 1 pairs, 1 with an unchanged prefix",
      "1 chained requests, 0 with duplicate system/user items, ~0 duplicate tokens in total",
    ]);
  });

  it("starts a chain at a request whose previous response is not in the trace", () => {
    const requests = [
      { seq: 4, body: chained("resp_gone", toolOutput("call_1"), tail), responseId: "resp_4" },
      { seq: 5, body: chained("resp_4", toolOutput("call_2"), tail) },
    ];
    expect(compareTraceRequests(requests)).toMatchObject([
      { from: null, to: 4, chain: { previousResponseId: "resp_gone", root: 4, requests: 1, duplicates: 0 } },
      { from: 4, to: 5, chain: { root: 4, requests: 2, duplicates: 1 } },
    ]);
    expect(reportPrefixStability(requests)[0]).toBe("#4: continues resp_gone, which is not in this trace; no duplicate system/user items");
  });
});

describe("loadTraceRequests", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const tempDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-prefix-diff-"));
    directories.push(directory);
    return directory;
  };

  it("pairs each request body with the response id the trace sink recorded for it", () => {
    const sink = createProviderTraceSink({ agencHome: tempDirectory(), conversationId: "conv-chain", bodies: true });
    const send = (payload: Record<string, unknown>, responseId?: string) => {
      sink.onProviderTraceEvent({ kind: "request", transport: "chat_stream", provider: "grok", payload });
      if (responseId === undefined) return;
      sink.onProviderTraceEvent({ kind: "response", transport: "chat_stream", provider: "grok", payload: { id: responseId, status: "completed", output: [] } });
    };
    send(root, "resp_1");
    send(chained("resp_1", toolOutput("call_1"), tail), "resp_2");
    send(chained("resp_2", toolOutput("call_2"), tail));
    // The process died while it appended the response line of #3.
    appendFileSync(join(sink.directory, "llm-00003.jsonl"), "{\"kind\":\"response\",\"seq\":3,\"resp");

    const requests = loadTraceRequests(sink.directory);
    expect(requests.map(({ seq, responseId }) => [seq, responseId])).toEqual([[1, "resp_1"], [2, "resp_2"], [3, undefined]]);
    expect(requests[1].body).toEqual(chained("resp_1", toolOutput("call_1"), tail));
    expect(compareTraceRequests(requests).map(({ from, to, chain }) => [from, to, chain.duplicates])).toEqual([[1, 2, 1], [2, 3, 2]]);
  });

  it("reads request bodies whose trace summaries are missing", () => {
    const directory = tempDirectory();
    writeFileSync(join(directory, "llm-00001.request.json"), JSON.stringify(root));
    writeFileSync(join(directory, "llm-00002.request.json"), JSON.stringify(chained("resp_1", tail)));
    const requests = loadTraceRequests(directory);
    expect(requests.map(({ responseId }) => responseId)).toEqual([undefined, undefined]);
    expect(reportPrefixStability(requests)[0]).toBe("#2: continues resp_1, which is not in this trace; no duplicate system/user items");
  });
});
