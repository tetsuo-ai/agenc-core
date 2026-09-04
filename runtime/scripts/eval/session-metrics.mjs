// Harness metrics for one multi-turn eval session. Two sources feed the same
// accumulator: the SDK prompt events the runner receives live, and the
// session's rollout JSONL, which carries the token counts, tool errors and
// compaction records the live stream does not. Pure functions, no I/O except
// the two explicit readers at the bottom, so the shapes are unit-testable.
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

const READ_TOOLS = new Set(["FileRead", "Read", "file_read", "read_file"]);
const WRITE_TOOLS = new Set([
  "FileEdit",
  "Edit",
  "MultiEdit",
  "FileWrite",
  "Write",
  "file_edit",
  "file_write",
]);

export function createStepMetrics() {
  return {
    toolCalls: 0,
    toolCallsByName: new Map(),
    toolErrors: 0,
    fileReads: 0,
    fileReReads: 0,
    compactions: 0,
    compactionAttempts: 0,
    compactionFailures: 0,
    compactionRollbacks: 0,
    permissionRequests: 0,
    warnings: 0,
    assistantMessages: 0,
    assistantChars: 0,
    promptTokensFirst: undefined,
    promptTokensLast: undefined,
    cachedTokensLast: undefined,
    cachedTokensMax: undefined,
    reasoningOutputTokens: 0,
    // Paths read since the last mutation of that path. A second read without
    // an intervening Edit or Write is a re-read the model did not need.
    readSinceWrite: new Set(),
  };
}

function inputPath(input) {
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Feed one SDK prompt event. Unknown event types are ignored. */
export function observePromptEvent(metrics, event) {
  if (!event || typeof event !== "object") return;
  switch (event.type) {
    case "tool_call": {
      metrics.toolCalls += 1;
      const name = typeof event.toolName === "string" ? event.toolName : "?";
      metrics.toolCallsByName.set(name, (metrics.toolCallsByName.get(name) ?? 0) + 1);
      const path = inputPath(event.input);
      if (READ_TOOLS.has(name)) {
        metrics.fileReads += 1;
        if (path !== undefined) {
          if (metrics.readSinceWrite.has(path)) metrics.fileReReads += 1;
          metrics.readSinceWrite.add(path);
        }
      } else if (WRITE_TOOLS.has(name) && path !== undefined) {
        metrics.readSinceWrite.delete(path);
      }
      return;
    }
    case "history_reset":
      if (event.reason === "partial_compact") metrics.compactions += 1;
      if (event.reason === "compaction_rollback") metrics.compactionRollbacks += 1;
      return;
    case "permission_request":
      metrics.permissionRequests += 1;
      return;
    case "text":
      if (typeof event.delta === "string") metrics.assistantChars += event.delta.length;
      return;
    case "message_committed":
      metrics.assistantMessages += 1;
      return;
    default:
      return;
  }
}

function numberField(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Feed one parsed rollout JSONL record. */
export function observeRolloutRecord(metrics, record) {
  if (!record || typeof record !== "object") return;
  const type = record.type;
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  if (type === "event_msg") {
    const msg = payload.msg && typeof payload.msg === "object" ? payload.msg : {};
    const inner = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
    switch (msg.type) {
      case "token_count": {
        const prompt = numberField(inner, ["promptTokens", "prompt_tokens", "inputTokens"]);
        const cached = numberField(inner, [
          "cachedInputTokens",
          "cached_input_tokens",
          "cacheReadInputTokens",
        ]);
        const reasoning = numberField(inner, ["reasoningOutputTokens", "reasoning_output_tokens"]);
        if (prompt !== undefined) {
          if (metrics.promptTokensFirst === undefined) metrics.promptTokensFirst = prompt;
          metrics.promptTokensLast = prompt;
        }
        if (cached !== undefined) {
          metrics.cachedTokensLast = cached;
          metrics.cachedTokensMax = Math.max(metrics.cachedTokensMax ?? 0, cached);
        }
        if (reasoning !== undefined) metrics.reasoningOutputTokens += reasoning;
        return;
      }
      case "warning":
        metrics.warnings += 1;
        return;
      default:
        return;
    }
  }
  if (type === "response_item" && (payload.role === "tool" || payload.type === "tool")) {
    const content = payload.content ?? payload.output ?? "";
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const flagged = payload.is_error === true || payload.isError === true;
    if (flagged || /^(tool )?error\b/iu.test(text.trimStart().slice(0, 40))) {
      metrics.toolErrors += 1;
    }
    return;
  }
  if (type === "compaction_intent") metrics.compactionAttempts += 1;
  if (type === "compaction_failed") metrics.compactionFailures += 1;
}

/** The schema-shaped, JSON-serialisable view of one step or one task. */
export function finalizeMetrics(metrics) {
  const byName = Object.fromEntries(
    [...metrics.toolCallsByName.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const out = {
    toolCalls: metrics.toolCalls,
    toolCallsByName: byName,
    toolErrors: metrics.toolErrors,
    fileReads: metrics.fileReads,
    fileReReads: metrics.fileReReads,
    compactions: metrics.compactions,
    compactionAttempts: metrics.compactionAttempts,
    compactionFailures: metrics.compactionFailures,
    compactionRollbacks: metrics.compactionRollbacks,
    permissionRequests: metrics.permissionRequests,
    warnings: metrics.warnings,
    assistantMessages: metrics.assistantMessages,
    assistantChars: metrics.assistantChars,
    reasoningOutputTokens: metrics.reasoningOutputTokens,
  };
  for (const key of ["promptTokensFirst", "promptTokensLast", "cachedTokensLast", "cachedTokensMax"]) {
    if (metrics[key] !== undefined) out[key] = metrics[key];
  }
  return out;
}

/** Sum step views into a task view. Token watermarks take first/last/max. */
export function aggregateMetrics(steps) {
  const sum = (key) => steps.reduce((total, step) => total + (step[key] ?? 0), 0);
  const byName = {};
  for (const step of steps) {
    for (const [name, count] of Object.entries(step.toolCallsByName ?? {})) {
      byName[name] = (byName[name] ?? 0) + count;
    }
  }
  const out = {
    toolCalls: sum("toolCalls"),
    toolCallsByName: Object.fromEntries(Object.entries(byName).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    toolErrors: sum("toolErrors"),
    fileReads: sum("fileReads"),
    fileReReads: sum("fileReReads"),
    compactions: sum("compactions"),
    compactionAttempts: sum("compactionAttempts"),
    compactionFailures: sum("compactionFailures"),
    compactionRollbacks: sum("compactionRollbacks"),
    permissionRequests: sum("permissionRequests"),
    warnings: sum("warnings"),
    assistantMessages: sum("assistantMessages"),
    assistantChars: sum("assistantChars"),
    reasoningOutputTokens: sum("reasoningOutputTokens"),
    steps: steps.length,
  };
  const first = steps.find((step) => step.promptTokensFirst !== undefined);
  const last = [...steps].reverse().find((step) => step.promptTokensLast !== undefined);
  const cachedLast = [...steps].reverse().find((step) => step.cachedTokensLast !== undefined);
  if (first) out.promptTokensFirst = first.promptTokensFirst;
  if (last) out.promptTokensLast = last.promptTokensLast;
  if (cachedLast) out.cachedTokensLast = cachedLast.cachedTokensLast;
  const cachedMax = steps.map((step) => step.cachedTokensMax).filter((value) => value !== undefined);
  if (cachedMax.length > 0) out.cachedTokensMax = Math.max(...cachedMax);
  return out;
}

/** Ratios the regression gate compares. Undefined when the denominator is 0. */
export function deriveRatios(metrics) {
  if (!metrics) return {};
  const ratio = (numerator, denominator) =>
    denominator > 0 ? Number((numerator / denominator).toFixed(4)) : undefined;
  return {
    toolErrorRate: ratio(metrics.toolErrors ?? 0, metrics.toolCalls ?? 0),
    rereadRatio: ratio(metrics.fileReReads ?? 0, metrics.fileReads ?? 0),
    compactionsPerStep: ratio(metrics.compactions ?? 0, metrics.steps ?? 0),
    cacheHitRatio:
      metrics.promptTokensLast !== undefined && metrics.cachedTokensLast !== undefined
        ? ratio(metrics.cachedTokensLast, metrics.promptTokensLast)
        : undefined,
  };
}

/**
 * Find the rollout file of one session under an AgenC home. Sessions live at
 * projects/<slug>/sessions/<id>/rollout-*.jsonl and move to archived_sessions
 * when terminated; both are searched.
 */
export function findSessionRollout(agencHome, sessionId) {
  const projects = join(agencHome, "projects");
  let slugs;
  try {
    slugs = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const slug of slugs) {
    for (const bucket of ["sessions", "archived_sessions"]) {
      const dir = join(projects, slug, bucket, sessionId);
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      const rollout = entries.filter((name) => /^rollout-.*\.jsonl$/u.test(name)).sort().at(-1);
      if (rollout) return join(dir, rollout);
    }
  }
  return undefined;
}

/**
 * Find the rollout of the session that runs in `cwd`. The daemon names rollout
 * directories by conversation id, which the SDK does not expose (it reports the
 * daemon session id), but every rollout starts with a session_meta record that
 * carries the workspace cwd, and each eval task runs in its own temp workspace.
 * Only rollouts modified at or after `sinceMs` are considered.
 */
export function findSessionRolloutForWorkspace(agencHome, cwd, sinceMs = 0) {
  const projects = join(agencHome, "projects");
  const wanted = canonical(cwd);
  let slugs;
  try {
    slugs = readdirSync(projects);
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const slug of slugs) {
    for (const bucket of ["sessions", "archived_sessions"]) {
      const bucketDir = join(projects, slug, bucket);
      let sessions;
      try {
        sessions = readdirSync(bucketDir);
      } catch {
        continue;
      }
      for (const sessionId of sessions) {
        const dir = join(bucketDir, sessionId);
        let entries;
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (!/^rollout-.*\.jsonl$/u.test(name)) continue;
          const path = join(dir, name);
          let stat;
          try {
            stat = statSync(path);
          } catch {
            continue;
          }
          if (stat.mtimeMs < sinceMs) continue;
          candidates.push({ path, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const meta = firstRecord(candidate.path);
    const recorded = meta?.payload?.cwd;
    if (typeof recorded === "string" && canonical(recorded) === wanted) return candidate.path;
  }
  return undefined;
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function firstRecord(path) {
  try {
    const text = readFileSync(path, "utf8");
    const end = text.indexOf("\n");
    return JSON.parse(end === -1 ? text : text.slice(0, end));
  } catch {
    return undefined;
  }
}

/** Read the records appended since `offset` bytes; returns the new offset. */
export function readRolloutDelta(path, offset) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { records: [], offset };
  }
  if (size <= offset) return { records: [], offset };
  const text = readFileSync(path, "utf8");
  const chunk = text.slice(offset);
  const lastNewline = chunk.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : chunk.slice(0, lastNewline + 1);
  const records = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn or non-JSON line is not a metric; skip it.
    }
  }
  return { records, offset: offset + Buffer.byteLength(complete, "utf8") };
}
