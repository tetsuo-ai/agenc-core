#!/usr/bin/env node
/**
 * Where do two consecutive provider requests first diverge?
 *
 * Reads the `llm-<seq>.request.json` bodies written by the provider trace
 * with `AGENC_PROVIDER_TRACE=1 AGENC_PROVIDER_TRACE_BODIES=1` and, for every
 * consecutive pair, finds the first byte that differs in the order the
 * provider sees the prompt: `instructions`, then each `input` item, then the
 * tool list. A pair whose only change is items appended to `input` keeps its
 * cached prefix; any other divergence re-bills everything after the offset.
 *
 * Usage: node scripts/eval/prefix-diff.mjs <agent-logs/<conversationId>> [--json]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUEST_FILE_RE = /^llm-(\d+)\.request\.json$/u;
const CHARS_PER_TOKEN = 4;

export function loadTraceRequests(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const match = REQUEST_FILE_RE.exec(name);
    if (match === null) continue;
    out.push({
      seq: Number.parseInt(match[1], 10),
      body: JSON.parse(readFileSync(join(directory, name), "utf8")),
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
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

export function reportPrefixStability(requests) {
  const lines = [];
  let stable = 0;
  for (let index = 1; index < requests.length; index += 1) {
    const divergence = firstDivergence(requests[index - 1].body, requests[index].body);
    if (isPrefixStable(divergence)) stable += 1;
    lines.push(`#${requests[index - 1].seq} -> #${requests[index].seq}: ${describeDivergence(divergence)}`);
  }
  lines.push(`${requests.length} requests, ${Math.max(0, requests.length - 1)} pairs, ${stable} with an unchanged prefix`);
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
    const pairs = requests.slice(1).map((request, index) => ({
      from: requests[index].seq,
      to: request.seq,
      divergence: firstDivergence(requests[index].body, request.body),
    }));
    console.log(JSON.stringify(pairs, null, 2));
  } else {
    console.log(reportPrefixStability(requests).join("\n"));
  }
}
