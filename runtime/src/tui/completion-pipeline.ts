import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const COMPLETION_PIPELINE_EVENT_LOG_ENV =
  "AGENC_TUI_COMPLETION_PIPELINE_LOG";
export const COMPLETION_PIPELINE_EVENT_LOG_PATH =
  ".tmp/agenc-tui-completion-pipeline/events.jsonl";

export const COMPLETION_PIPELINE_GATE_IDS = [
  "prep",
  "branch_shape",
  "branding",
  "shape_evidence",
  "item_specific",
  "typecheck",
  "tui_validate",
  "review",
  "local_merge",
] as const;

export type CompletionPipelineGateId =
  (typeof COMPLETION_PIPELINE_GATE_IDS)[number];

export type CompletionPipelineStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "completed";

export type CompletionPipelineEvent = {
  readonly pipelineId: string;
  readonly sequence: number;
  readonly gateId: string;
  readonly gateIndex: number;
  readonly status: CompletionPipelineStatus;
  readonly message?: string;
  readonly detail?: string;
  readonly timestamp: string;
};

export type CompletionPipelineGateState = {
  readonly gateId: string;
  readonly gateIndex: number;
  readonly label: string;
  readonly status: CompletionPipelineStatus;
  readonly message?: string;
  readonly detail?: string;
  readonly started: boolean;
  readonly sequence: number;
  readonly timestamp: string;
};

export type CompletionPipelineState = {
  readonly pipelineId: string | null;
  readonly gates: readonly CompletionPipelineGateState[];
  readonly activeGate: CompletionPipelineGateState | null;
  readonly terminal:
    | {
        readonly status: "failed" | "cancelled" | "completed";
        readonly gateId?: string;
        readonly label?: string;
        readonly detail?: string;
        readonly timestamp: string;
      }
    | null;
  readonly ownsPrompt: boolean;
};

type ReadOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly readFile?: (path: string) => string;
};

const EMPTY_STATE: CompletionPipelineState = {
  pipelineId: null,
  gates: [],
  activeGate: null,
  terminal: null,
  ownsPrompt: false,
};

const GATE_LABELS: Record<string, string> = {
  prep: "Prepare goal",
  branch_shape: "Branch shape",
  branding: "Branding scan",
  shape_evidence: "Shape evidence",
  item_specific: "Item checks",
  typecheck: "Typecheck",
  tui_validate: "TUI validation",
  review: "Reviewer approval",
  local_merge: "Local merge",
};

const ALLOWED_STATUSES = new Set<CompletionPipelineStatus>([
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "completed",
]);

const TERMINAL_STATUSES = new Set<CompletionPipelineStatus>([
  "failed",
  "cancelled",
  "completed",
]);

function boundText(value: any, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function isObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object";
}

export function safeGateLabel(gateId: string): string {
  return GATE_LABELS[gateId] ?? gateId.replace(/[_-]+/g, " ");
}

export function gateIndexFor(gateId: string, gateIndex?: number): number {
  const lockedIndex = COMPLETION_PIPELINE_GATE_IDS.indexOf(
    gateId as CompletionPipelineGateId,
  );
  if (lockedIndex >= 0) return lockedIndex;
  return Number.isInteger(gateIndex) && gateIndex !== undefined
    ? gateIndex
    : COMPLETION_PIPELINE_GATE_IDS.length;
}

export function normalizeCompletionPipelineEvent(
  raw: any,
): CompletionPipelineEvent | null {
  if (!isObject(raw)) return null;
  if (typeof raw.pipelineId !== "string" || raw.pipelineId.trim() === "") {
    return null;
  }
  if (typeof raw.gateId !== "string" || raw.gateId.trim() === "") return null;
  if (!Number.isInteger(raw.sequence)) return null;
  if (typeof raw.status !== "string" || !ALLOWED_STATUSES.has(raw.status as CompletionPipelineStatus)) {
    return null;
  }
  const timestamp =
    typeof raw.timestamp === "string" && !Number.isNaN(Date.parse(raw.timestamp))
      ? raw.timestamp
      : new Date(0).toISOString();
  const gateId = raw.gateId;
  const gateIndex = gateIndexFor(
    gateId,
    Number.isInteger(raw.gateIndex) ? raw.gateIndex : undefined,
  );
  return {
    pipelineId: raw.pipelineId,
    sequence: raw.sequence,
    gateId,
    gateIndex,
    status: raw.status as CompletionPipelineStatus,
    ...(boundText(raw.message) !== undefined
      ? { message: boundText(raw.message) }
      : {}),
    ...(boundText(raw.detail, 240) !== undefined
      ? { detail: boundText(raw.detail, 240) }
      : {}),
    timestamp,
  };
}

export function resolveCompletionPipelineEventLogPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured = env[COMPLETION_PIPELINE_EVENT_LOG_ENV];
  return resolve(
    cwd,
    configured && configured.trim() !== ""
      ? configured
      : COMPLETION_PIPELINE_EVENT_LOG_PATH,
  );
}

export function readCompletionPipelineEvents(
  options: ReadOptions = {},
): readonly CompletionPipelineEvent[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const eventLogPath = resolveCompletionPipelineEventLogPath(env, cwd);
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  if (options.readFile === undefined && !existsSync(eventLogPath)) return [];
  let raw: string;
  try {
    raw = readFile(eventLogPath);
  } catch {
    return [];
  }
  const events: CompletionPipelineEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const event = normalizeCompletionPipelineEvent(JSON.parse(line));
      if (event !== null) events.push(event);
    } catch {
      continue;
    }
  }
  return events;
}

export function reduceCompletionPipelineEvents(
  rawEvents: readonly CompletionPipelineEvent[],
): CompletionPipelineState {
  const events = rawEvents
    .slice()
    .sort((left, right) =>
      left.sequence === right.sequence
        ? left.gateIndex - right.gateIndex
        : left.sequence - right.sequence,
    );
  if (events.length === 0) return EMPTY_STATE;

  const latestPipelineId = events[events.length - 1]!.pipelineId;
  const dedupedBySequence = new Map<string, CompletionPipelineEvent>();
  for (const event of events) {
    if (event.pipelineId !== latestPipelineId) continue;
    dedupedBySequence.set(`${event.pipelineId}:${event.sequence}`, event);
  }

  const startedGateKeys = new Set<string>();
  const heldTerminals: CompletionPipelineEvent[] = [];
  const states = new Map<string, CompletionPipelineGateState>();
  let activeGate: CompletionPipelineGateState | null = null;
  let terminal: CompletionPipelineState["terminal"] = null;

  const accept = (event: CompletionPipelineEvent) => {
    const key = event.gateId;
    const previous = states.get(key);
    if (
      previous !== undefined &&
      TERMINAL_STATUSES.has(previous.status) &&
      event.status === "started"
    ) {
      return;
    }
    const next: CompletionPipelineGateState = {
      gateId: event.gateId,
      gateIndex: event.gateIndex,
      label: safeGateLabel(event.gateId),
      status: event.status,
      ...(event.message !== undefined ? { message: event.message } : {}),
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      started: previous?.started === true || event.status === "started",
      sequence: event.sequence,
      timestamp: event.timestamp,
    };
    states.set(key, next);
    if (event.status === "started") {
      activeGate = next;
      startedGateKeys.add(key);
    } else if (event.status === "succeeded") {
      if (activeGate?.gateId === event.gateId) activeGate = null;
    } else if (event.status === "failed" || event.status === "cancelled") {
      activeGate = null;
      terminal = {
        status: event.status,
        gateId: event.gateId,
        label: safeGateLabel(event.gateId),
        detail:
          event.detail ??
          event.message ??
          (event.status === "cancelled" ? "Pipeline cancelled" : undefined),
        timestamp: event.timestamp,
      };
    } else if (event.status === "completed") {
      activeGate = null;
      terminal = {
        status: "completed",
        detail: event.detail ?? event.message ?? "Completion pipeline finished",
        timestamp: event.timestamp,
      };
    }
  };

  const flushHeldFor = (gateId: string) => {
    let flushed = true;
    while (flushed) {
      flushed = false;
      for (let i = 0; i < heldTerminals.length; i++) {
        const held = heldTerminals[i]!;
        if (held.gateId !== gateId || !startedGateKeys.has(held.gateId)) {
          continue;
        }
        heldTerminals.splice(i, 1);
        accept(held);
        flushed = true;
        break;
      }
    }
  };

  for (const event of dedupedBySequence.values()) {
    if (event.status !== "started" && event.status !== "completed" && !startedGateKeys.has(event.gateId)) {
      heldTerminals.push(event);
      continue;
    }
    accept(event);
    if (event.status === "started") flushHeldFor(event.gateId);
  }

  const gates = [...states.values()].sort(
    (left, right) =>
      left.gateIndex === right.gateIndex
        ? left.sequence - right.sequence
        : left.gateIndex - right.gateIndex,
  );
  return {
    pipelineId: latestPipelineId,
    gates,
    activeGate,
    terminal,
    ownsPrompt: activeGate !== null,
  };
}

export function readCompletionPipelineState(
  options: ReadOptions = {},
): CompletionPipelineState {
  return reduceCompletionPipelineEvents(readCompletionPipelineEvents(options));
}

export function completionPipelineOwnsPrompt(
  state: CompletionPipelineState,
): boolean {
  return state.ownsPrompt;
}

export function formatCompletionPipelineRows(
  state: CompletionPipelineState,
): readonly string[] {
  if (state.pipelineId === null) return [];
  const rows: string[] = [];
  for (const gate of state.gates) {
    const ordinal =
      gate.gateIndex >= 0 && gate.gateIndex < COMPLETION_PIPELINE_GATE_IDS.length
        ? `${gate.gateIndex + 1}/${COMPLETION_PIPELINE_GATE_IDS.length}`
        : "?/9";
    const suffix =
      gate.status === "started"
        ? "running"
        : gate.status === "succeeded"
          ? "ok"
          : gate.status === "failed"
            ? `failed${gate.detail ? `: ${gate.detail}` : ""}`
            : gate.status === "cancelled"
              ? `cancelled${gate.detail ? `: ${gate.detail}` : ""}`
              : gate.status;
    rows.push(`Completion ${ordinal}: ${gate.label} ${suffix}`);
  }
  if (state.terminal !== null) {
    if (state.terminal.status === "completed") {
      rows.push(`Completion pipeline complete: ${state.terminal.detail ?? "finished"}`);
    } else if (state.terminal.status === "cancelled") {
      rows.push(
        `Completion pipeline cancelled: ${state.terminal.detail ?? "cancelled"}`,
      );
    } else {
      rows.push(
        `Completion pipeline failed at ${state.terminal.label ?? "gate"}: ${
          state.terminal.detail ?? "failed"
        }`,
      );
    }
  }
  return rows;
}
