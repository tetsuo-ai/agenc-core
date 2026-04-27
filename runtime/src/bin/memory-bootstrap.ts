import { join } from "node:path";

import type { Session } from "../session/session.js";
import type { Event } from "../session/event-log.js";
import type { LLMMessage } from "../llm/types.js";
import type {
  ExtractMemoriesFn,
  MemoryCandidate,
  TurnState as MemoryTurnState,
} from "../prompts/memory/index.js";
import { memoryLayout, scanMemoryDir } from "../prompts/memory/index.js";

export const EXTRACT_MEMORIES_TIMEOUT_MS = 30_000;

function countModelVisibleMessages(messages: readonly LLMMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") count += 1;
  }
  return count;
}

function snapshotHistoryMessages(session: Session): readonly LLMMessage[] {
  const maybeSession = session as Partial<
    Pick<Session, "snapshotHistoryMessages">
  >;
  if (typeof maybeSession.snapshotHistoryMessages !== "function") return [];
  try {
    return maybeSession.snapshotHistoryMessages();
  } catch {
    return [];
  }
}

async function formatExistingMemoryManifest(memoryDir: string): Promise<string> {
  const scan = await scanMemoryDir(memoryDir, {
    maxFiles: 200,
    maxBytes: 25_000,
  });
  if (scan.entries.length === 0) return "";
  const lines = scan.entries.map((entry) => {
    const name = entry.frontmatter.name ?? entry.filePath;
    const type = entry.frontmatter.type ?? "unknown";
    const description = entry.frontmatter.description ?? "";
    return description.length > 0
      ? `- ${name} (${type}) — ${description}`
      : `- ${name} (${type})`;
  });
  if (scan.truncated) {
    lines.push(
      `- Existing memory scan truncated (${scan.filesDropped} files, ${scan.bytesDropped} byte-capped entries dropped).`,
    );
  }
  return lines.join("\n");
}

function buildExtractPrompt(params: {
  readonly transcript: string;
  readonly newMessageCount: number;
  readonly existingMemories: string;
}): string {
  const manifest =
    params.existingMemories.length > 0
      ? [
          "",
          "",
          "## Existing memory files",
          "",
          params.existingMemories,
          "",
          "Check this list before emitting a duplicate candidate — update an existing topic semantically rather than creating a duplicate.",
        ].join("\n")
      : "";

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${params.newMessageCount} messages above and use them to update your persistent memory systems.`,
    "",
    "Available tools: none. AgenC owns memory writes in the parent runtime for this extraction path, so you must return JSON candidates only.",
    "",
    `You MUST only use content from the last ~${params.newMessageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.` +
      manifest,
    "",
    "Output: JSON array of candidates with shape:",
    "[ { \"name\": \"<slug>\", \"description\": \"<one-line>\", \"type\": \"user\"|\"feedback\"|\"project\"|\"reference\", \"body\": \"<the memory content>\" } ]",
    "Only extract non-ephemeral, user-specific, durable facts. Skip code patterns, ephemeral state, PR/commit references, tool outputs, task status, and the extraction instructions themselves.",
    "Output ONLY a single JSON array. No prose before or after. No markdown code fences (no ```json, no ```). The very first character must be `[` and the very last must be `]`.",
    ...(params.transcript.trim().length > 0
      ? ["", "--- TRANSCRIPT FALLBACK ---", params.transcript]
      : []),
  ].join("\n");
}

/**
 * Locate the first balanced top-level JSON array in `text` and return its
 * substring, or null if none is found. Walks string literals (with backslash
 * escapes) so brackets inside quoted strings don't unbalance the scan.
 *
 * Mirrors AgenC runtime's tolerant input parsing in memory_trace.rs:128-145, which
 * skips non-JSON-starting lines and parses the first JSON-looking value it
 * finds. We extract a single top-level array because the extractor prompt
 * specifies an array and we only ever consume one.
 */
function extractFirstJsonArray(text: string): string | null {
  let i = 0;
  while (i < text.length && text[i] !== "[") i += 1;
  if (i >= text.length) return null;
  const start = i;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

const EXTRACT_MEMORY_TYPES: ReadonlySet<string> = new Set([
  "user",
  "feedback",
  "project",
  "reference",
]);

export function parseExtractedMemoryCandidates(
  raw: string,
  memoryDir: string,
): readonly MemoryCandidate[] {
  // Two-stage parse, matching AgenC runtime's tolerant input pattern: try the whole
  // string first; on failure, scan for the first balanced JSON array and
  // parse that. Handles the common model failure modes:
  //   1. JSON followed by trailing prose ("[...]\nThese are the memories...")
  //   2. Markdown-fenced JSON ("```json\n[...]\n```")
  //   3. JSON preceded by a short preface ("Here is the JSON:\n[...]")
  // If both passes fail, throw the original parse error so the caller can
  // surface it to telemetry and we don't silently swallow a real malformed
  // response.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (firstErr) {
    const candidate = extractFirstJsonArray(raw);
    if (candidate === null) throw firstErr;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw firstErr;
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error("extractor response was not a JSON array");
  }
  const out: MemoryCandidate[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const description =
      typeof rec.description === "string" ? rec.description.trim() : "";
    const type =
      typeof rec.type === "string" && EXTRACT_MEMORY_TYPES.has(rec.type)
        ? (rec.type as "user" | "feedback" | "project" | "reference")
        : undefined;
    const body = typeof rec.body === "string" ? rec.body : "";
    if (name === "" || type === undefined || body.length === 0) continue;
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug.length === 0) continue;
    out.push({
      filePath: join(memoryLayout(memoryDir).entriesDir, `${slug}.md`),
      frontmatter: {
        name,
        description,
        type,
        extra: {},
      },
      body,
    });
  }
  return out;
}

export function buildExtractMemoriesViaSubagent(params: {
  readonly session: () => Session | null;
  readonly memoryDir: string;
  readonly delegateFn?: typeof import("../agents/delegate.js").delegate;
  readonly timeoutMs?: number;
}): ExtractMemoriesFn {
  return async (transcript: string): Promise<readonly MemoryCandidate[]> => {
    const session = params.session();
    if (session === null) return [];
    const timeoutMs = params.timeoutMs ?? EXTRACT_MEMORIES_TIMEOUT_MS;

    const emitWarning = (cause: string, message: string): void => {
      try {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: { cause, message },
          },
        });
      } catch {
        /* best effort */
      }
    };

    let rawFinal: string;
    try {
      const delegateFn =
        params.delegateFn ??
        (await import("../agents/delegate.js")).delegate;
      const { control, registry } = (
        await import("./delegate-tool.js")
      ).ensureAgentControl(session);
      const parentMessages = snapshotHistoryMessages(session);
      const historyMessageCount = countModelVisibleMessages(parentMessages);
      const newMessageCount =
        historyMessageCount > 0
          ? historyMessageCount
          : transcript.trim().length > 0
            ? 1
            : 0;
      if (newMessageCount === 0) return [];
      const existingMemories = await formatExistingMemoryManifest(
        params.memoryDir,
      );

      const deadline = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `memory_extract_timeout: extraction did not finish within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        ).unref?.();
      });

      const dispatch = delegateFn({
        parent: session,
        parentPath: "/root",
        control,
        registry,
        taskPrompt: buildExtractPrompt({
          transcript,
          newMessageCount,
          existingMemories,
        }),
        role: "explorer",
        forkMode: { kind: "full_history" },
        toolAllowlist: [],
      });

      const outcome = await Promise.race([dispatch, deadline]);
      if (outcome.kind !== "sync_completed") {
        emitWarning(
          "memory_extract_failed",
          outcome.kind === "rejected"
            ? `delegate rejected: ${outcome.reason}`
            : `unexpected delegate outcome: ${outcome.kind}`,
        );
        return [];
      }
      rawFinal = outcome.result.finalMessage ?? "";
      if (rawFinal.trim().length === 0) {
        emitWarning(
          "memory_extract_parse_failed",
          "extractor returned an empty final message",
        );
        return [];
      }
    } catch (err) {
      emitWarning(
        "memory_extract_failed",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    try {
      return parseExtractedMemoryCandidates(rawFinal, params.memoryDir);
    } catch (err) {
      emitWarning(
        "memory_extract_parse_failed",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  };
}

export class TurnStateAccumulator {
  private tokensConsumed = 0;
  private toolCallsIssued = 0;
  private currentTurnHadTools = false;
  private lastTurnHadNoTools = false;
  private unsubscribe: (() => void) | null = null;

  subscribe(log: { subscribe: (fn: (e: Event) => void) => () => void }): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = log.subscribe((event) => this.onEvent(event));
  }

  detach(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  onEvent(event: Event): void {
    switch (event.msg.type) {
      case "turn_started": {
        this.currentTurnHadTools = false;
        return;
      }
      case "tool_call_started": {
        this.currentTurnHadTools = true;
        return;
      }
      case "tool_call_completed": {
        this.toolCallsIssued += 1;
        this.currentTurnHadTools = true;
        return;
      }
      case "token_count": {
        const delta = event.msg.payload.totalTokens ?? 0;
        if (delta > 0) this.tokensConsumed += delta;
        return;
      }
      case "turn_complete": {
        this.lastTurnHadNoTools = !this.currentTurnHadTools;
        return;
      }
      default:
        return;
    }
  }

  snapshot(): MemoryTurnState {
    return {
      tokensConsumed: this.tokensConsumed,
      toolCallsIssued: this.toolCallsIssued,
      lastTurnHadNoTools: this.lastTurnHadNoTools,
    };
  }

  reset(): void {
    this.tokensConsumed = 0;
    this.toolCallsIssued = 0;
    this.currentTurnHadTools = false;
    this.lastTurnHadNoTools = false;
  }
}
