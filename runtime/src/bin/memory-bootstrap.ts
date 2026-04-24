import { join } from "node:path";

import type { Session } from "../session/session.js";
import type { Event } from "../session/event-log.js";
import type {
  ExtractMemoriesFn,
  MemoryCandidate,
  TurnState as MemoryTurnState,
} from "../prompts/memory/index.js";

export const EXTRACT_MEMORIES_TIMEOUT_MS = 30_000;

function buildExtractPrompt(transcript: string): string {
  return [
    "You are extracting durable memories from the current session. Input: the last N assistant+user messages. Output: JSON array of candidates with shape:",
    "[ { \"name\": \"<slug>\", \"description\": \"<one-line>\", \"type\": \"user\"|\"feedback\"|\"project\"|\"reference\", \"body\": \"<the memory content>\" } ]",
    "Only extract non-ephemeral, user-specific, durable facts. Skip code patterns, ephemeral state, PR/commit references. Output ONLY valid JSON, no prose.",
    "",
    "--- TRANSCRIPT ---",
    transcript,
  ].join("\n");
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
  const parsed = JSON.parse(raw);
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
      filePath: join(memoryDir, `${slug}.md`),
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
        taskPrompt: buildExtractPrompt(transcript),
        role: "explorer",
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
