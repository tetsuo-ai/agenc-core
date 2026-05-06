import type { JsonValue } from "../../app-server/protocol/index.js";

export type RealtimeTuiPhase = "inactive" | "starting" | "active" | "stopping";
export type RealtimeTuiTransport = "websocket" | "webrtc";
export type RealtimeTuiTranscriptRole = "assistant" | "user" | string;

export interface RealtimeTuiTranscriptPreview {
  readonly role: RealtimeTuiTranscriptRole;
  readonly text: string;
}

export interface RealtimeTuiState {
  readonly phase: RealtimeTuiPhase;
  readonly requestedClose: boolean;
  readonly transport: RealtimeTuiTransport | null;
  readonly realtimeSessionId: string | null;
  readonly muted: boolean;
  readonly pushToTalk: boolean;
  readonly pushToTalkHeld: boolean;
  readonly localAudioLevel: number;
  readonly lastTranscript: RealtimeTuiTranscriptPreview | null;
  readonly lastItemSummary: string | null;
  readonly errorBanner: string | null;
  readonly closedBanner: string | null;
}

export type RealtimeTuiEvent =
  | {
      readonly type: "start_requested";
      readonly transport: RealtimeTuiTransport;
    }
  | {
      readonly type: "start_failed";
      readonly message: string;
    }
  | {
      readonly type: "started";
      readonly realtimeSessionId?: string | null;
      readonly transport?: RealtimeTuiTransport | null;
    }
  | { readonly type: "stop_requested" }
  | {
      readonly type: "closed";
      readonly reason?: string | null;
    }
  | {
      readonly type: "error";
      readonly message: string;
    }
  | {
      readonly type: "local_audio_level";
      readonly peak: number;
    }
  | {
      readonly type: "transcript_delta";
      readonly role: RealtimeTuiTranscriptRole;
      readonly delta: string;
    }
  | {
      readonly type: "transcript_done";
      readonly role: RealtimeTuiTranscriptRole;
      readonly text: string;
    }
  | {
      readonly type: "item_added";
      readonly item: JsonValue;
    }
  | {
      readonly type: "muted_changed";
      readonly muted: boolean;
    }
  | {
      readonly type: "push_to_talk_changed";
      readonly enabled: boolean;
    }
  | {
      readonly type: "push_to_talk_held_changed";
      readonly held: boolean;
    };

export function initialRealtimeTuiState(): RealtimeTuiState {
  return {
    phase: "inactive",
    requestedClose: false,
    transport: null,
    realtimeSessionId: null,
    muted: false,
    pushToTalk: false,
    pushToTalkHeld: false,
    localAudioLevel: 0,
    lastTranscript: null,
    lastItemSummary: null,
    errorBanner: null,
    closedBanner: null,
  };
}

export function reduceRealtimeTuiState(
  state: RealtimeTuiState,
  event: RealtimeTuiEvent,
): RealtimeTuiState {
  switch (event.type) {
    case "start_requested":
      return {
        ...state,
        phase: "starting",
        requestedClose: false,
        transport: event.transport,
        realtimeSessionId: null,
        localAudioLevel: 0,
        errorBanner: null,
        closedBanner: null,
      };
    case "start_failed":
      return {
        ...state,
        phase: "inactive",
        requestedClose: false,
        transport: null,
        realtimeSessionId: null,
        errorBanner: event.message,
      };
    case "started":
      return {
        ...state,
        phase: "active",
        requestedClose: false,
        realtimeSessionId: event.realtimeSessionId ?? null,
        transport: event.transport ?? state.transport,
        errorBanner: null,
        closedBanner: null,
      };
    case "stop_requested":
      if (state.phase === "inactive") return state;
      return {
        ...state,
        phase: "stopping",
        requestedClose: true,
        closedBanner: null,
      };
    case "closed": {
      const reason = event.reason?.trim();
      return {
        ...state,
        phase: "inactive",
        requestedClose: false,
        transport: null,
        realtimeSessionId: null,
        localAudioLevel: 0,
        closedBanner:
          reason !== undefined && reason.length > 0
            ? `Realtime closed: ${reason}`
            : "Realtime closed",
      };
    }
    case "error":
      return {
        ...state,
        phase: "inactive",
        requestedClose: false,
        transport: null,
        realtimeSessionId: null,
        localAudioLevel: 0,
        errorBanner: event.message,
      };
    case "local_audio_level":
      return {
        ...state,
        localAudioLevel: normalizeRealtimePeak(event.peak),
      };
    case "transcript_delta": {
      const previous =
        state.lastTranscript?.role === event.role
          ? state.lastTranscript.text
          : "";
      return {
        ...state,
        lastTranscript: {
          role: event.role,
          text: `${previous}${event.delta}`,
        },
      };
    }
    case "transcript_done":
      return {
        ...state,
        lastTranscript: {
          role: event.role,
          text: event.text,
        },
      };
    case "item_added":
      return {
        ...state,
        lastItemSummary: formatRealtimeItemSummary(event.item),
      };
    case "muted_changed":
      return {
        ...state,
        muted: event.muted,
      };
    case "push_to_talk_changed":
      return {
        ...state,
        pushToTalk: event.enabled,
        pushToTalkHeld: event.enabled ? state.pushToTalkHeld : false,
      };
    case "push_to_talk_held_changed":
      return {
        ...state,
        pushToTalkHeld: state.pushToTalk ? event.held : false,
      };
  }
}

export function effectiveRealtimeMicrophoneMuted(
  state: RealtimeTuiState,
): boolean {
  return state.muted || (state.pushToTalk && !state.pushToTalkHeld);
}

export function normalizeRealtimePeak(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(65_535, Math.round(value)));
}

export function realtimeLevelBar(peak: number, width = 12): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const filled = Math.round((normalizeRealtimePeak(peak) / 65_535) * safeWidth);
  return `${"#".repeat(filled)}${"-".repeat(safeWidth - filled)}`;
}

export function formatRealtimeItemSummary(item: JsonValue): string {
  if (item === null) return "null";
  if (typeof item !== "object") return String(item);
  if (Array.isArray(item)) return `array(${item.length})`;
  const type = item.type;
  if (typeof type === "string") {
    const id = typeof item.itemId === "string"
      ? item.itemId
      : typeof item.id === "string"
        ? item.id
        : null;
    return id === null ? type : `${type} ${id}`;
  }
  return truncateRealtimeSummary(JSON.stringify(item));
}

function truncateRealtimeSummary(value: string): string {
  return value.length <= 96 ? value : `${value.slice(0, 93)}...`;
}
