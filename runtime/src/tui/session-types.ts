import type { LLMMessage } from "../llm/types.js";
import type { AgenCConfig } from "../config/index.js";
import type { Event } from "../session/event-log.js";
import type { ApprovalResolver } from "../tools/orchestrator.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../elicitation/types.js";

export interface PermissionModeRegistryLike {
  current(): ToolPermissionContext;
  update?(next: ToolPermissionContext): Promise<void> | void;
  subscribeToModeChange?(
    cb: (
      next: ToolPermissionContext["mode"],
      previous: ToolPermissionContext["mode"],
    ) => void,
  ): () => void;
}

export interface AgenCBridgeSession {
  readonly conversationId: string;
  readonly services: {
    readonly permissionModeRegistry: PermissionModeRegistryLike;
    approvalResolver?: ApprovalResolver;
    requestUserInputResolver?: {
      request(
        event: RequestUserInputEvent,
        signal?: AbortSignal,
      ): Promise<RequestUserInputResponse | null>;
    };
    mcpElicitationResolver?: {
      request(
        event: McpElicitationRequestEvent,
        signal?: AbortSignal,
      ): Promise<McpElicitationResponse | null>;
    };
  };
  readonly activeTurn?: {
    unsafePeek(): { readonly turnId: string } | null;
  } | null;
  readonly abortController?: { readonly signal: AbortSignal };
  readonly eventLog?: {
    subscribe(cb: (event: Event) => void): () => void;
  };
  readonly initialTranscriptEvents?: readonly unknown[];
  getInitialTranscriptEvents?(): readonly unknown[];
  subscribeToEvents?(cb: (event: unknown) => void): () => void;
  submit?(
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ): Promise<void>;
  enqueueIdleInput?(input: LLMMessage): number;
  abortTerminal?(reason: string): void;
  flushEventLog?(): Promise<void> | void;
  emit?(event: Event | { readonly kind: string; readonly [key: string]: unknown }): void;
  nextInternalSubId?(): string;
  readonly sessionConfiguration?: {
    readonly cwd?: string;
    readonly collaborationMode?: { readonly model?: string };
    readonly provider?: { readonly slug?: string };
  };
  readonly cwd?: string;
  readonly home?: string;
  appStateBridge?: {
    setModel?: (next: string) => void;
    setExpandedView?: (next: "none" | "tasks") => void;
  };
  setPendingProviderSwitch?(
    pending: { provider: string; model: string; profile?: string } | null,
  ): void;
  listMcpClients?(): readonly import("../agenc/upstream/services/mcp/types.js").MCPServerConnection[];
}

export interface ConfigStoreLike {
  readonly snapshot?: unknown;
  current?(): AgenCConfig;
  subscribe?(listener: (config: unknown) => void): (() => void) | void;
  warnings?(): readonly string[];
}

export interface AgenCTuiProps {
  readonly session: AgenCBridgeSession;
  readonly configStore: ConfigStoreLike;
  readonly model?: string;
  readonly initialPrompt?: string;
  readonly initialComposerText?: string;
  readonly initialUserMessages?: readonly LLMMessage[];
}
