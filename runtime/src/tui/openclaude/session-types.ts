import type { LLMMessage } from "../../llm/types.js";
import type { AgenCConfig } from "../../config/index.js";
import type { Event } from "../../session/event-log.js";
import type { ApprovalResolver } from "../../tools/orchestrator.js";
import type { ToolPermissionContext } from "../../permissions/types.js";

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

export interface OpenClaudeBridgeSession {
  readonly conversationId: string;
  readonly services: {
    readonly permissionModeRegistry: PermissionModeRegistryLike;
    approvalResolver?: ApprovalResolver;
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
  /**
   * Stage a provider/model switch for the next turn. Mirrors
   * `Session.setPendingProviderSwitch` on the runtime — the staged
   * switch is applied at the start of the next turn so the model
   * picker in the TUI actually changes what runs.
   *
   * Bridge implementations that wrap the live `Session` class get this
   * for free since `Session` already exposes the method; a no-op
   * implementation is fine for test fixtures that don't drive turns.
   */
  setPendingProviderSwitch?(
    pending: { provider: string; model: string; profile?: string } | null,
  ): void;
  /**
   * Snapshot of configured MCP server connections for the composer's
   * MCP picker / inspection surface. Optional so test fixtures may
   * omit it; the production bridge wires this to
   * `projectMcpManagerToConnections` over the live runtime
   * `MCPManager`.
   */
  listMcpClients?(): readonly import("../../agenc/upstream/services/mcp/types.js").MCPServerConnection[];
}

export interface ConfigStoreLike {
  readonly snapshot?: unknown;
  current?(): AgenCConfig;
  subscribe?(listener: (config: unknown) => void): (() => void) | void;
  warnings?(): readonly string[];
}

export interface OpenClaudeTuiProps {
  readonly session: OpenClaudeBridgeSession;
  readonly configStore: ConfigStoreLike;
  readonly model?: string;
  readonly initialPrompt?: string;
  readonly initialComposerText?: string;
  readonly initialUserMessages?: readonly LLMMessage[];
}
