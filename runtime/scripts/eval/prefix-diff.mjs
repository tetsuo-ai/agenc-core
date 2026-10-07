#!/usr/bin/env node
/**
 * Where do two consecutive provider requests first diverge, and what does a
 * continuation chain hold more than once?
 *
 * Reads the `llm-<seq>.request.json` bodies written by the provider trace
 * with `AGENC_PROVIDER_TRACE=1 AGENC_PROVIDER_TRACE_BODIES=1`, and the id of
 * the response each request produced from its `llm-<seq>.jsonl` summary.
 *
 * A request without `previous_response_id` sends the whole prompt. It is
 * compared with the previous such request: the first byte that differs in the
 * order the provider sees the prompt, `instructions`, then each `input` item,
 * then the tool list. A pair whose only change is items appended to `input`
 * keeps its cached prefix; any other divergence re-bills everything after the
 * offset.
 *
 * A request with `previous_response_id` sends only a delta, which the
 * provider appends to the conversation it stored for that response. Its
 * effective input is the inputs of the requests those ids link back to the
 * chain's first, full request, then its own delta; response outputs are left
 * out, since the check needs only inputs. An extra copy of a system or user
 * item in it, such as a tail that every delta resends, stays in the prompt of
 * every later request of the chain. The report lists the repeated items and
 * estimates their extra copies at chars/4 tokens.
 *
 * `--json` prints the comparisons: `{ from, to, divergence }` for a full
 * request, and for a chained one `divergence: null` plus `chain`, with
 * `from: null` when the response it continues is not in the trace.
 *
 * Usage: node scripts/eval/prefix-diff.mjs <agent-logs/<conversationId>> [--json]
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUEST_FILE_RE = /^llm-(\d+)\.request\.json$/u;
const CHARS_PER_TOKEN = 4;
/** Roles of the input items whose repeats within a chain are reported. */
const CHAIN_CHECKED_ROLES = new Set(["system", "user"]);

export function loadTraceRequests(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const match = REQUEST_FILE_RE.exec(name);
    if (match === null) continue;
    out.push({
      seq: Number.parseInt(match[1], 10),
      body: JSON.parse(readFileSync(join(directory, name), "utf8")),
      responseId: recordedResponseId(join(directory, `llm-${match[1]}.jsonl`)),
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    // A blank line, or one cut short when the process died mid-append.
    return undefined;
  }
}

/**
 * The id of the response a request produced, from the response line of its
 * `llm-<seq>.jsonl` summary: undefined when the request failed or its summary
 * is missing.
 */
function recordedResponseId(summaryPath) {
  if (!existsSync(summaryPath)) return undefined;
  for (const line of readFileSync(summaryPath, "utf8").split("\n")) {
    const record = parseLine(line);
    if (record?.kind === "response" && typeof record.response?.id === "string") {
      return record.response.id;
    }
  }
  return undefined;
}

function text(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

function snippet(source, at, span = 90) {
  const start = Math.max(0, at - 24);
  return source.slice(start, at + span);
}

function itemLabel(item) {
  if (!item || typeof item !== "object") return "?";
  return String(item.role ?? item.type ?? "?");
}

function toolName(tool) {
  return String(tool?.name ?? tool?.function?.name ?? "?");
}

function toolsDivergence(prevTools, nextTools) {
  const prevNames = prevTools.map(toolName);
  const nextNames = nextTools.map(toolName);
  const prevSet = new Set(prevNames);
  const nextSet = new Set(nextNames);
  const added = nextNames.filter((name) => !prevSet.has(name));
  const removed = prevNames.filter((name) => !nextSet.has(name));
  const sharedBefore = prevNames.filter((name) => nextSet.has(name));
  const sharedAfter = nextNames.filter((name) => prevSet.has(name));
  const reordered = JSON.stringify(sharedBefore) !== JSON.stringify(sharedAfter);
  const prevByName = new Map(prevTools.map((tool) => [toolName(tool), text(tool)]));
  const changedSchemas = nextTools
    .filter((tool) => prevByName.has(toolName(tool)) && prevByName.get(toolName(tool)) !== text(tool))
    .map(toolName);
  return { field: "tools", added, removed, reordered, changedSchemas };
}

/**
 * The trailing system item (the dynamic suffix) is the same in both requests
 * and only moved to the end because `next` appended history before it. Every
 * byte before it is unchanged, so the cached prefix survives.
 */
function suffixMoved(prevInput, nextInput, index) {
  if (index !== prevInput.length - 1) return false;
  const tail = prevInput[index];
  if (itemLabel(tail) !== "system") return false;
  if (nextInput.length <= prevInput.length) return false;
  return text(nextInput[nextInput.length - 1]) === text(tail);
}

function divergenceAt(field, index, role, offsetChars, a, b, at) {
  return {
    field,
    index,
    role,
    offsetChars,
    approxTokens: Math.round(offsetChars / CHARS_PER_TOKEN),
    before: snippet(a, at),
    after: snippet(b, at),
  };
}

/**
 * The first difference between two request bodies, or null when `next` only
 * appends `input` items to `prev` and nothing else moved.
 */
export function firstDivergence(prev, next) {
  let charsBefore = 0;
  const prevInstructions = text(prev.instructions);
  const nextInstructions = text(next.instructions);
  if (prevInstructions !== nextInstructions) {
    const at = commonPrefixLength(prevInstructions, nextInstructions);
    return divergenceAt("instructions", -1, "system", charsBefore + at, prevInstructions, nextInstructions, at);
  }
  charsBefore += prevInstructions.length;
  const prevInput = Array.isArray(prev.input) ? prev.input : [];
  const nextInput = Array.isArray(next.input) ? next.input : [];
  const shared = Math.min(prevInput.length, nextInput.length);
  for (let index = 0; index < shared; index += 1) {
    const a = text(prevInput[index]);
    const b = text(nextInput[index]);
    if (a !== b) {
      if (suffixMoved(prevInput, nextInput, index)) {
        return {
          field: "input",
          index,
          role: itemLabel(prevInput[index]),
          suffixMoved: true,
          appended: nextInput.length - prevInput.length,
          offsetChars: charsBefore,
          approxTokens: Math.round(charsBefore / CHARS_PER_TOKEN),
        };
      }
      const at = commonPrefixLength(a, b);
      return {
        ...divergenceAt("input", index, itemLabel(prevInput[index]), charsBefore + at, a, b, at),
        prevItemChars: a.length,
        nextItemChars: b.length,
      };
    }
    charsBefore += a.length;
  }
  const prevTools = Array.isArray(prev.tools) ? prev.tools : [];
  const nextTools = Array.isArray(next.tools) ? next.tools : [];
  if (text(prevTools) !== text(nextTools)) {
    return {
      ...toolsDivergence(prevTools, nextTools),
      offsetChars: charsBefore,
      approxTokens: Math.round(charsBefore / CHARS_PER_TOKEN),
    };
  }
  if (prevInput.length > nextInput.length) {
    return {
      field: "input",
      index: shared,
      role: itemLabel(prevInput[shared]),
      removed: prevInput.length - nextInput.length,
      offsetChars: charsBefore,
      approxTokens: Math.round(charsBefore / CHARS_PER_TOKEN),
    };
  }
  return null;
}

export function isPrefixStable(divergence) {
  return divergence === null || divergence.suffixMoved === true;
}

export function describeDivergence(divergence) {
  if (divergence === null) return "prefix unchanged; input only appended";
  if (divergence.suffixMoved === true) {
    return `prefix unchanged up to the trailing system suffix at offset ${divergence.offsetChars} chars (~${divergence.approxTokens} tokens); ${divergence.appended} item(s) appended before it`;
  }
  const indexed = divergence.index !== undefined && divergence.index >= 0;
  const where = `${divergence.field}${indexed ? `[${divergence.index}]` : ""}`;
  const position = `offset ${divergence.offsetChars} chars (~${divergence.approxTokens} tokens)`;
  if (divergence.field === "tools") {
    const parts = [];
    if (divergence.added.length > 0) parts.push(`added ${divergence.added.join(",")}`);
    if (divergence.removed.length > 0) parts.push(`removed ${divergence.removed.join(",")}`);
    if (divergence.reordered) parts.push("reordered");
    if (divergence.changedSchemas.length > 0) parts.push(`schema changed ${divergence.changedSchemas.join(",")}`);
    return `${where} after ${position}: ${parts.join("; ")}`;
  }
  if (divergence.removed !== undefined) {
    return `${where} (${divergence.role}) at ${position}: ${divergence.removed} item(s) removed`;
  }
  return `${where} (${divergence.role}) at ${position}\n    before: ${JSON.stringify(divergence.before)}\n    after:  ${JSON.stringify(divergence.after)}`;
}

/** The response a request continues, or undefined when it sends the whole prompt. */
function continuedResponseId(body) {
  const id = body.previous_response_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** The system and user items of a request's input, with their digests. */
function checkedItems(seq, body) {
  const input = Array.isArray(body.input) ? body.input : [];
  return input
    .filter((item) => CHAIN_CHECKED_ROLES.has(itemLabel(item)))
    .map((item) => {
      const source = text(item);
      const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
      return { seq, role: itemLabel(item), source, digest };
    });
}

/** The items that occur more than once, in the order they first occur. */
function repeatedItems(items) {
  const byDigest = new Map();
  for (const item of items) {
    const first = byDigest.get(item.digest);
    if (first === undefined) byDigest.set(item.digest, { ...item, seqs: [item.seq] });
    else first.seqs.push(item.seq);
  }
  return [...byDigest.values()]
    .filter(({ seqs }) => seqs.length > 1)
    .map(({ role, digest, seqs, source }) => ({
      role,
      digest,
      copies: seqs.length,
      seqs,
      itemChars: source.length,
      approxTokens: Math.round(((seqs.length - 1) * source.length) / CHARS_PER_TOKEN),
      preview: snippet(source, 0),
    }));
}

function chainReport(previousResponseId, chain) {
  const repeated = repeatedItems(chain.items);
  return {
    previousResponseId,
    root: chain.root,
    requests: chain.requests,
    duplicates: repeated.reduce((sum, item) => sum + item.copies - 1, 0),
    approxTokens: repeated.reduce((sum, item) => sum + item.approxTokens, 0),
    repeatedItems: repeated,
  };
}

/**
 * One comparison per request after the first full one: a full request with
 * the previous full request, a chained request with the chain it continues.
 */
export function compareTraceRequests(requests) {
  const comparisons = [];
  // Response id -> the chain up to and including the request that produced it.
  const chains = new Map();
  let previousFull;
  for (const request of requests) {
    const previousResponseId = continuedResponseId(request.body);
    const parent = previousResponseId === undefined ? undefined : chains.get(previousResponseId);
    const chain = {
      seq: request.seq,
      root: parent?.root ?? request.seq,
      requests: (parent?.requests ?? 0) + 1,
      items: [...(parent?.items ?? []), ...checkedItems(request.seq, request.body)],
    };
    if (request.responseId !== undefined) chains.set(request.responseId, chain);
    if (previousResponseId !== undefined) {
      comparisons.push({
        from: parent?.seq ?? null,
        to: request.seq,
        divergence: null,
        chain: chainReport(previousResponseId, chain),
      });
      continue;
    }
    if (previousFull !== undefined) {
      comparisons.push({
        from: previousFull.seq,
        to: request.seq,
        divergence: firstDivergence(previousFull.body, request.body),
      });
    }
    previousFull = request;
  }
  return comparisons;
}

function describeChain({ from, to, chain }) {
  const head = from === null
    ? `#${to}: continues ${chain.previousResponseId}, which is not in this trace`
    : `#${from} -> #${to}: continues #${from} (chain from #${chain.root}, ${chain.requests} requests)`;
  if (chain.duplicates === 0) return [`${head}; no duplicate system/user items`];
  return [
    `${head}; ${chain.duplicates} duplicate system/user item(s), ~${chain.approxTokens} tokens`,
    ...chain.repeatedItems.map((item) => {
      const where = item.seqs.map((seq) => `#${seq}`).join(", ");
      return `    ${item.role} x${item.copies} (${where}), ~${item.approxTokens} tokens: ${JSON.stringify(item.preview)}`;
    }),
  ];
}

export function reportPrefixStability(requests) {
  const lines = [];
  let pairs = 0;
  let stable = 0;
  let chained = 0;
  let withDuplicates = 0;
  let duplicateTokens = 0;
  for (const comparison of compareTraceRequests(requests)) {
    if (comparison.chain !== undefined) {
      chained += 1;
      if (comparison.chain.duplicates > 0) withDuplicates += 1;
      duplicateTokens += comparison.chain.approxTokens;
      lines.push(...describeChain(comparison));
      continue;
    }
    pairs += 1;
    if (isPrefixStable(comparison.divergence)) stable += 1;
    lines.push(`#${comparison.from} -> #${comparison.to}: ${describeDivergence(comparison.divergence)}`);
  }
  lines.push(`${requests.length} requests, ${pairs} pairs, ${stable} with an unchanged prefix`);
  if (chained > 0) {
    lines.push(`${chained} chained requests, ${withDuplicates} with duplicate system/user items, ~${duplicateTokens} duplicate tokens in total`);
  }
  return lines;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const directory = args.find((arg) => !arg.startsWith("--"));
  if (!directory) {
    console.error("usage: node scripts/eval/prefix-diff.mjs <agent-logs/<conversationId>> [--json]");
    process.exit(2);
  }
  const requests = loadTraceRequests(directory);
  if (args.includes("--json")) {
    console.log(JSON.stringify(compareTraceRequests(requests), null, 2));
  } else {
    console.log(reportPrefixStability(requests).join("\n"));
  }
}
