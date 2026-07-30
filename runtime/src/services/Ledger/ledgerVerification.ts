/**
 * UI state for Ledger's physical-device genuine check.
 *
 * The store is intentionally process-local: `/ledger genuine-check` runs in
 * the interactive TUI process, while model-driven checks are projected from
 * the daemon transcript by App.tsx. Keeping the view state here lets both
 * entry points drive the same popup without coupling wallet-cli to React.
 */

export const LEDGER_VERIFIED_AUTO_DISMISS_MS = 8_000;
export const LEDGER_VERIFICATION_TIMEOUT_MS = 75_000;

export type LedgerVerificationPhase =
  | "idle"
  | "waiting"
  | "verifying"
  | "verified"
  | "failed";

export type LedgerVerificationSource = "prompt" | "slash";

export type LedgerVerificationSnapshot = {
  readonly phase: LedgerVerificationPhase;
  readonly requestId: number;
  readonly source: LedgerVerificationSource | null;
  readonly transcriptStartIndex: number | null;
  readonly model: string | null;
  readonly detail: string | null;
  readonly startedAt: number | null;
};

export type LedgerVerificationObservation =
  | {
      readonly callId: string;
      readonly status: "running";
    }
  | {
      readonly callId: string;
      readonly status: "succeeded";
      readonly detail: string | null;
    }
  | {
      readonly callId: string;
      readonly status: "failed";
      readonly detail: string;
    };

const IDLE_SNAPSHOT: LedgerVerificationSnapshot = {
  phase: "idle",
  requestId: 0,
  source: null,
  transcriptStartIndex: null,
  model: null,
  detail: null,
  startedAt: null,
};

let snapshot = IDLE_SNAPSHOT;
let nextRequestId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function update(next: LedgerVerificationSnapshot): void {
  if (
    next.phase === snapshot.phase &&
    next.requestId === snapshot.requestId &&
    next.source === snapshot.source &&
    next.transcriptStartIndex === snapshot.transcriptStartIndex &&
    next.model === snapshot.model &&
    next.detail === snapshot.detail &&
    next.startedAt === snapshot.startedAt
  ) {
    return;
  }
  snapshot = next;
  emit();
}

export function subscribeLedgerVerification(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLedgerVerificationSnapshot(): LedgerVerificationSnapshot {
  return snapshot;
}

/**
 * Start a check. A slash command may arrive immediately after App has already
 * opened the popup for the same submitted `/ledger genuine-check`; preserve
 * that request so transcript baselines and auto-dismiss timers stay coherent.
 */
export function beginLedgerVerification(options: {
  readonly source: LedgerVerificationSource;
  readonly transcriptStartIndex?: number | null;
  readonly model?: string | null;
}): number {
  if (
    (snapshot.phase === "waiting" || snapshot.phase === "verifying") &&
    snapshot.source === options.source
  ) {
    const nextModel = options.model ?? snapshot.model;
    const nextStart =
      options.transcriptStartIndex ?? snapshot.transcriptStartIndex;
    update({
      ...snapshot,
      model: nextModel,
      transcriptStartIndex: nextStart,
    });
    return snapshot.requestId;
  }

  const requestId = nextRequestId++;
  update({
    phase: "waiting",
    requestId,
    source: options.source,
    transcriptStartIndex: options.transcriptStartIndex ?? null,
    model: options.model ?? null,
    detail: null,
    startedAt: Date.now(),
  });
  return requestId;
}

export function markLedgerVerifying(
  requestId: number,
  model?: string | null,
): void {
  if (snapshot.requestId !== requestId || snapshot.phase === "idle") return;
  update({
    ...snapshot,
    phase: "verifying",
    model: model ?? snapshot.model,
    detail: null,
  });
}

export function markLedgerVerified(
  requestId: number,
  options: {
    readonly model?: string | null;
    readonly detail?: string | null;
  } = {},
): void {
  if (snapshot.requestId !== requestId || snapshot.phase === "idle") return;
  update({
    ...snapshot,
    phase: "verified",
    model: options.model ?? snapshot.model,
    detail: options.detail ?? null,
  });
}

export function markLedgerVerificationFailed(
  requestId: number,
  detail: string,
): void {
  if (snapshot.requestId !== requestId || snapshot.phase === "idle") return;
  update({
    ...snapshot,
    phase: "failed",
    detail: conciseFailure(detail),
  });
}

export function dismissLedgerVerification(requestId?: number): void {
  if (requestId !== undefined && snapshot.requestId !== requestId) return;
  update({
    ...IDLE_SNAPSHOT,
    requestId: snapshot.requestId,
  });
}

/**
 * Natural-language trigger used by the composer. English and Spanish forms
 * cover the product's current UI languages without opening the modal for an
 * ordinary balance/account question.
 */
export function isLedgerAuthenticityRequest(text: string): boolean {
  if (!/\bledger\b/i.test(text)) return false;
  return (
    /\bgenuine(?:-check)?\b/i.test(text) ||
    /\bauthentic(?:ity|ate|ation)?\b/i.test(text) ||
    /\bverif(?:y|ies|ied|ication)\b/i.test(text) ||
    /\baut[eé]ntic[ao]?\b/i.test(text) ||
    /\bgenuin[ao]?\b/i.test(text) ||
    /\bverific(?:ar|a|aci[oó]n|ada|ado)\b/i.test(text)
  );
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isGenuineCheckToolUse(name: unknown, input: unknown): boolean {
  const toolName = typeof name === "string" ? name.toLowerCase() : "";
  if (
    toolName === "ledger_genuine_check" ||
    toolName === "ledger_wallet_genuine_check"
  ) {
    return true;
  }
  const serialized = stringValue(input).toLowerCase();
  return (
    /genuine[-_\s]?check/.test(serialized) &&
    (serialized.includes("wallet-cli") ||
      serialized.includes("/ledger") ||
      toolName.includes("ledger"))
  );
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return stringValue(value);
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      if (block === null || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function conciseFailure(detail: string): string {
  const line = detail
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  const fallback = "The Ledger genuine check did not complete.";
  if (!line) return fallback;
  return line.length <= 110 ? line : `${line.slice(0, 109)}…`;
}

function resultFailed(isError: boolean, text: string): boolean {
  if (isError) return true;
  return (
    /"ok"\s*:\s*false/i.test(text) ||
    /"(?:genuine|isGenuine|authentic|isAuthentic)"\s*:\s*false/i.test(
      text,
    ) ||
    /\b(?:not genuine|not authentic|verification failed|genuine check failed)\b/i.test(
      text,
    ) ||
    /\b(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|code)\s*[:=]?\s*[1-9]\d*\b/i.test(
      text,
    )
  );
}

function structuredResultConfirmsGenuine(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) =>
      structuredResultConfirmsGenuine(item, depth + 1),
    );
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const normalizedKey = key.replace(/[-_\s]/g, "").toLowerCase();
    if (
      (normalizedKey === "genuine" ||
        normalizedKey === "isgenuine" ||
        normalizedKey === "authentic" ||
        normalizedKey === "isauthentic") &&
      nested === true
    ) {
      return true;
    }
    if (structuredResultConfirmsGenuine(nested, depth + 1)) return true;
  }
  return false;
}

/**
 * A zero exit code is necessary but not sufficient for an authenticity claim.
 * Require the official CLI's explicit JSON boolean or an equivalent human
 * success sentence before the UI may show the green verified state.
 */
export function isLedgerGenuineResult(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  try {
    if (structuredResultConfirmsGenuine(JSON.parse(trimmed))) return true;
  } catch {
    // Human output and tool wrappers are intentionally handled below.
  }
  return (
    /\b(?:device|ledger(?:\s+(?:device|wallet))?)\s+is\s+genuine\b/i.test(
      trimmed,
    ) ||
    /\b(?:genuine|authenticity)\s+(?:check|verification)\s+(?:passed|succeeded|successful|completed)\b/i.test(
      trimmed,
    ) ||
    /\bverified\s+as\s+(?:genuine|authentic)\b/i.test(trimmed) ||
    /\b(?:genuine|is[_\s-]?genuine|authentic|is[_\s-]?authentic)\s*[:=]\s*true\b/i.test(
      trimmed,
    )
  );
}

/**
 * Find the newest wallet-cli genuine-check call and its matching result.
 * Historical checks before `startIndex` are ignored so a new request can
 * never inherit an old "verified" result.
 */
export function observeLedgerGenuineCheck(options: {
  readonly messages: readonly unknown[];
  readonly inProgressToolUseIDs: ReadonlySet<string>;
  readonly streamingToolUses?: readonly {
    readonly contentBlock?: {
      readonly id?: unknown;
      readonly name?: unknown;
      readonly input?: unknown;
    };
    readonly unparsedToolInput?: unknown;
  }[];
  readonly startIndex?: number | null;
}): LedgerVerificationObservation | null {
  const startIndex = Math.max(0, options.startIndex ?? 0);
  let newestCall:
    | {
        readonly id: string;
        readonly order: number;
      }
    | null = null;
  const results = new Map<
    string,
    { readonly isError: boolean; readonly text: string }
  >();

  for (let index = startIndex; index < options.messages.length; index++) {
    const outer = options.messages[index];
    if (outer === null || typeof outer !== "object") continue;
    const message = (outer as { readonly message?: unknown }).message;
    if (message === null || typeof message !== "object") continue;
    const content = (message as { readonly content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      if (
        record.type === "tool_use" &&
        typeof record.id === "string" &&
        isGenuineCheckToolUse(record.name, record.input)
      ) {
        newestCall = { id: record.id, order: index };
      }
      if (
        record.type === "tool_result" &&
        typeof record.tool_use_id === "string"
      ) {
        results.set(record.tool_use_id, {
          isError: record.is_error === true,
          text: contentText(record.content),
        });
      }
    }
  }

  for (const streamed of options.streamingToolUses ?? []) {
    const block = streamed.contentBlock;
    const id = typeof block?.id === "string" ? block.id : null;
    if (id === null) continue;
    const input =
      stringValue(block?.input) + stringValue(streamed.unparsedToolInput);
    if (isGenuineCheckToolUse(block?.name, input)) {
      newestCall = {
        id,
        order: options.messages.length,
      };
    }
  }

  if (newestCall === null) return null;
  const result = results.get(newestCall.id);
  if (result === undefined || options.inProgressToolUseIDs.has(newestCall.id)) {
    return { callId: newestCall.id, status: "running" };
  }
  if (resultFailed(result.isError, result.text)) {
    return {
      callId: newestCall.id,
      status: "failed",
      detail: conciseFailure(result.text),
    };
  }
  if (!isLedgerGenuineResult(result.text)) {
    return {
      callId: newestCall.id,
      status: "failed",
      detail:
        "Wallet CLI completed without an explicit genuine-device confirmation.",
    };
  }
  return {
    callId: newestCall.id,
    status: "succeeded",
    detail: result.text.trim().length > 0 ? result.text.trim() : null,
  };
}

/** Test-only reset; harmless if a focused test imports the process singleton. */
export function resetLedgerVerificationForTests(): void {
  snapshot = IDLE_SNAPSHOT;
  nextRequestId = 1;
  listeners.clear();
}
