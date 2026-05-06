/**
 * Ports upstream `src/utils/multiTurnContext.ts` onto AgenC's conversation
 * runtime primitives.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC exposes an isolated manager for each daemon session. The
 *     module-level functions below are retained only as source-parity
 *     conveniences and must not be used by live multi-session code.
 *   - AgenC records prompt attachments and compaction-threshold status on
 *     the turn so downstream runtime items can wire the live turn loop
 *     without reimplementing token accounting.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Live turn-loop integration. RT-02 owns the reusable manager; later
 *     RT/PR items attach it to session execution.
 */

import {
  assembleTieredInstructions,
  formatTieredInstructionWarnings,
  loadTieredInstructions,
  type LoadTieredInstructionsOptions,
  type TieredInstructions,
} from "../prompts/agenc-md.js";
import {
  expandFileMentions,
  renderFileMentionAttachmentsBlock,
  type ExpandFileMentionsOptions,
  type FileMentionAttachment,
  type FileMentionExpansion,
  type FileMentionRejection,
} from "../prompts/file-mentions.js";
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from "../services/compact/autoCompact.js";
import type { CompactContext } from "../services/compact/types.js";
import {
  getSessionMemoryContent,
  type SessionMemoryPathOptions,
} from "../services/SessionMemory/sessionMemoryUtils.js";
import {
  roughTokenCountEstimationForContent,
  roughTokenCountEstimationForMessages,
  type TokenEstimationContent,
  type TokenEstimationMessage,
  type TokenizerProviderHint,
} from "../llm/token-estimation.js";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOKENS_PER_TURN = 50_000;

export interface MultiTurnOptions {
  readonly maxTurns?: number;
  readonly maxTokensPerTurn?: number;
  readonly preserveState?: boolean;
  readonly contextWindowTokens?: number;
  readonly mainLoopModel?: string;
  readonly providerName?: string;
  readonly autoCompactThresholdTokens?: number;
}

export interface NormalizedMultiTurnOptions {
  readonly maxTurns: number;
  readonly maxTokensPerTurn: number;
  readonly preserveState: boolean;
  readonly contextWindowTokens?: number;
  readonly mainLoopModel?: string;
  readonly providerName?: string;
  readonly autoCompactThresholdTokens?: number;
}

export interface MultiTurnToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly timestamp: number;
}

export type MultiTurnMessage = TokenEstimationMessage;

export type TurnAttachment =
  | FileMentionTurnAttachment
  | AgenCInstructionsTurnAttachment
  | SessionMemoryTurnAttachment;

export interface FileMentionTurnAttachment {
  readonly type: "file_mentions";
  readonly originalPrompt: string;
  readonly expandedPrompt: string;
  readonly attachments: readonly FileMentionAttachment[];
  readonly rejected: readonly FileMentionRejection[];
  readonly tokens: number;
  readonly timestamp: number;
}

export interface AgenCInstructionsTurnAttachment {
  readonly type: "agenc_instructions";
  readonly content: string;
  readonly warnings: readonly string[];
  readonly tiers: TieredInstructions;
  readonly tokens: number;
  readonly timestamp: number;
}

export interface SessionMemoryTurnAttachment {
  readonly type: "session_memory";
  readonly content: string;
  readonly tokens: number;
  readonly timestamp: number;
}

export interface TurnContext {
  readonly turnId: string;
  readonly startTime: number;
  readonly messages: readonly MultiTurnMessage[];
  readonly toolCalls: readonly MultiTurnToolCall[];
  readonly state: ReadonlyMap<string, unknown>;
  readonly attachments: readonly TurnAttachment[];
  readonly messageTokens: number;
  readonly attachmentTokens: number;
  readonly tokens: number;
}

interface MutableTurnContext {
  turnId: string;
  startTime: number;
  messages: MultiTurnMessage[];
  toolCalls: MultiTurnToolCall[];
  state: Map<string, unknown>;
  attachments: TurnAttachment[];
  messageTokens: number;
  attachmentTokens: number;
  tokens: number;
}

export interface MultiTurnStats {
  readonly totalTurns: number;
  readonly totalTokens: number;
  readonly avgTokensPerTurn: number;
}

export interface MultiTurnCompactionStatus {
  readonly currentTokens: number;
  readonly messageTokens: number;
  readonly attachmentTokens: number;
  readonly maxTokensPerTurn: number;
  readonly contextWindowTokens: number;
  readonly autoCompactThresholdTokens: number;
  readonly exceedsMaxTokensPerTurn: boolean;
  readonly exceedsAutoCompactThreshold: boolean;
  readonly shouldCompact: boolean;
  readonly remainingTokensUntilCompact: number;
}

export interface MultiTurnContextDependencies {
  readonly now?: () => number;
  readonly estimateContentTokens?: (
    content: TokenEstimationContent,
    hint?: TokenizerProviderHint,
  ) => number;
  readonly estimateMessageTokens?: (
    messages: readonly TokenEstimationMessage[],
    hint?: TokenizerProviderHint,
  ) => number;
  readonly expandFileMentions?: (
    input: string,
    options: ExpandFileMentionsOptions,
  ) => Promise<FileMentionExpansion>;
  readonly renderFileMentionAttachmentsBlock?: (
    attachments: readonly FileMentionAttachment[],
  ) => string;
  readonly loadTieredInstructions?: (
    opts: LoadTieredInstructionsOptions,
  ) => Promise<TieredInstructions>;
  readonly assembleTieredInstructions?: (tiers: TieredInstructions) => string;
  readonly formatTieredInstructionWarnings?: (
    tiers: TieredInstructions,
  ) => readonly string[];
  readonly getSessionMemoryContent?: (
    options?: SessionMemoryPathOptions | string,
  ) => Promise<string | null>;
}

export interface MultiTurnTracker {
  readonly startTurn: () => TurnContext;
  readonly getCurrentTurn: () => TurnContext | null;
  readonly addMessage: (message: MultiTurnMessage) => void;
  readonly addToolCall: (call: MultiTurnToolCall) => void;
  readonly setState: (key: string, value: unknown) => void;
  readonly getState: <T>(key: string) => T | undefined;
  readonly getHistory: () => TurnContext[];
  readonly getRecent: (n: number) => TurnContext[];
  readonly getStats: () => MultiTurnStats;
  readonly reset: () => void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function optionalPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeOptions(options: MultiTurnOptions = {}): NormalizedMultiTurnOptions {
  return {
    maxTurns: positiveInteger(options.maxTurns, DEFAULT_MAX_TURNS),
    maxTokensPerTurn: positiveInteger(
      options.maxTokensPerTurn,
      DEFAULT_MAX_TOKENS_PER_TURN,
    ),
    preserveState: options.preserveState ?? true,
    contextWindowTokens: optionalPositiveInteger(options.contextWindowTokens),
    mainLoopModel:
      typeof options.mainLoopModel === "string" && options.mainLoopModel.trim()
        ? options.mainLoopModel
        : undefined,
    providerName:
      typeof options.providerName === "string" && options.providerName.trim()
        ? options.providerName
        : undefined,
    autoCompactThresholdTokens: optionalPositiveInteger(
      options.autoCompactThresholdTokens,
    ),
  };
}

function cloneTurn(turn: MutableTurnContext): TurnContext {
  return {
    turnId: turn.turnId,
    startTime: turn.startTime,
    messages: [...turn.messages],
    toolCalls: turn.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: { ...call.input },
      timestamp: call.timestamp,
    })),
    state: new Map(turn.state),
    attachments: [...turn.attachments],
    messageTokens: turn.messageTokens,
    attachmentTokens: turn.attachmentTokens,
    tokens: turn.tokens,
  };
}

function cloneStateForNewTurn(
  previousTurn: MutableTurnContext | null,
  options: NormalizedMultiTurnOptions,
): Map<string, unknown> {
  if (!options.preserveState || previousTurn === null) {
    return new Map();
  }
  return new Map(previousTurn.state);
}

function averageTokens(turns: readonly MutableTurnContext[]): number {
  if (turns.length === 0) return 0;
  return Math.round(
    turns.reduce((acc, turn) => acc + turn.tokens, 0) / turns.length,
  );
}

function compactContextForOptions(
  options: NormalizedMultiTurnOptions,
): CompactContext {
  return {
    options: {
      ...(options.mainLoopModel !== undefined
        ? { mainLoopModel: options.mainLoopModel }
        : {}),
      ...(options.contextWindowTokens !== undefined
        ? { contextWindowTokens: options.contextWindowTokens }
        : {}),
    },
    ...(options.providerName !== undefined
      ? { provider: { name: options.providerName } as CompactContext["provider"] }
      : {}),
  };
}

function addTokens(turn: MutableTurnContext, tokens: number, kind: "message" | "attachment"): void {
  const safeTokens = Math.max(0, Math.round(tokens));
  if (kind === "message") {
    turn.messageTokens += safeTokens;
  } else {
    turn.attachmentTokens += safeTokens;
  }
  turn.tokens = turn.messageTokens + turn.attachmentTokens;
}

export class MultiTurnContextManager {
  private turnHistory: MutableTurnContext[] = [];
  private currentTurn: MutableTurnContext | null = null;
  private turnCounter = 0;
  private activeOptions: NormalizedMultiTurnOptions;
  private readonly deps: Required<MultiTurnContextDependencies>;

  constructor(
    options: MultiTurnOptions = {},
    deps: MultiTurnContextDependencies = {},
  ) {
    this.activeOptions = normalizeOptions(options);
    this.deps = {
      now: deps.now ?? (() => Date.now()),
      estimateContentTokens:
        deps.estimateContentTokens ??
        ((content, hint) => roughTokenCountEstimationForContent(content, hint)),
      estimateMessageTokens:
        deps.estimateMessageTokens ??
        ((messages, hint) => roughTokenCountEstimationForMessages(messages, hint)),
      expandFileMentions: deps.expandFileMentions ?? expandFileMentions,
      renderFileMentionAttachmentsBlock:
        deps.renderFileMentionAttachmentsBlock ??
        renderFileMentionAttachmentsBlock,
      loadTieredInstructions: deps.loadTieredInstructions ?? loadTieredInstructions,
      assembleTieredInstructions:
        deps.assembleTieredInstructions ?? assembleTieredInstructions,
      formatTieredInstructionWarnings:
        deps.formatTieredInstructionWarnings ?? formatTieredInstructionWarnings,
      getSessionMemoryContent:
        deps.getSessionMemoryContent ?? getSessionMemoryContent,
    };
  }

  configure(options: MultiTurnOptions = {}): void {
    this.activeOptions = normalizeOptions(options);
    while (this.turnHistory.length > this.activeOptions.maxTurns) {
      this.turnHistory.shift();
    }
  }

  startNewTurn(): TurnContext {
    while (this.turnHistory.length >= this.activeOptions.maxTurns) {
      this.turnHistory.shift();
    }

    const now = this.deps.now();
    const turn: MutableTurnContext = {
      turnId: `turn_${++this.turnCounter}_${now}`,
      startTime: now,
      messages: [],
      toolCalls: [],
      state: cloneStateForNewTurn(this.currentTurn, this.activeOptions),
      attachments: [],
      messageTokens: 0,
      attachmentTokens: 0,
      tokens: 0,
    };

    this.currentTurn = turn;
    this.turnHistory.push(turn);

    return cloneTurn(turn);
  }

  getCurrentTurn(): TurnContext | null {
    return this.currentTurn ? cloneTurn(this.currentTurn) : null;
  }

  addMessageToTurn(message: MultiTurnMessage): void {
    const turn = this.ensureTurn();
    turn.messages.push(message);
    const tokens = this.deps.estimateMessageTokens([message], {
      provider: this.activeOptions.providerName,
      model: this.activeOptions.mainLoopModel,
    });
    addTokens(turn, tokens, "message");
  }

  addToolCallToTurn(call: MultiTurnToolCall): void {
    const turn = this.ensureTurn();
    turn.toolCalls.push({
      id: call.id,
      name: call.name,
      input: { ...call.input },
      timestamp: call.timestamp,
    });
  }

  setTurnState(key: string, value: unknown): void {
    this.ensureTurn().state.set(key, value);
  }

  getTurnState<T>(key: string): T | undefined {
    return this.currentTurn?.state.get(key) as T | undefined;
  }

  getTurnHistory(): TurnContext[] {
    return this.turnHistory.map(cloneTurn);
  }

  getRecentTurns(n: number): TurnContext[] {
    const count = positiveInteger(n, 0);
    return count === 0 ? [] : this.turnHistory.slice(-count).map(cloneTurn);
  }

  getMultiTurnStats(): MultiTurnStats {
    return {
      totalTurns: this.turnHistory.length,
      totalTokens: this.turnHistory.reduce((acc, turn) => acc + turn.tokens, 0),
      avgTokensPerTurn: averageTokens(this.turnHistory),
    };
  }

  clearTurnHistory(): void {
    this.turnHistory = [];
    this.currentTurn = null;
  }

  resetMultiTurnState(): void {
    this.clearTurnHistory();
    this.turnCounter = 0;
  }

  getCompactionStatus(turn: TurnContext | null = this.getCurrentTurn()): MultiTurnCompactionStatus {
    const currentTokens = turn?.tokens ?? 0;
    const messageTokens = turn?.messageTokens ?? 0;
    const attachmentTokens = turn?.attachmentTokens ?? 0;
    const compactContext = compactContextForOptions(this.activeOptions);
    const contextWindowTokens = getEffectiveContextWindowSize(compactContext);
    const autoCompactThresholdTokens =
      this.activeOptions.autoCompactThresholdTokens ??
      getAutoCompactThreshold(compactContext);
    const exceedsMaxTokensPerTurn =
      currentTokens >= this.activeOptions.maxTokensPerTurn;
    const exceedsAutoCompactThreshold =
      currentTokens >= autoCompactThresholdTokens;
    const threshold = Math.min(
      this.activeOptions.maxTokensPerTurn,
      autoCompactThresholdTokens,
    );
    return {
      currentTokens,
      messageTokens,
      attachmentTokens,
      maxTokensPerTurn: this.activeOptions.maxTokensPerTurn,
      contextWindowTokens,
      autoCompactThresholdTokens,
      exceedsMaxTokensPerTurn,
      exceedsAutoCompactThreshold,
      shouldCompact: exceedsMaxTokensPerTurn || exceedsAutoCompactThreshold,
      remainingTokensUntilCompact: Math.max(0, threshold - currentTokens),
    };
  }

  shouldCompactCurrentTurn(): boolean {
    return this.getCompactionStatus().shouldCompact;
  }

  async attachFileMentions(
    prompt: string,
    options: ExpandFileMentionsOptions,
  ): Promise<FileMentionTurnAttachment> {
    const turn = this.ensureTurn();
    const expansion = await this.deps.expandFileMentions(prompt, options);
    const attachmentBlock =
      expansion.attachments.length > 0
        ? this.deps.renderFileMentionAttachmentsBlock(expansion.attachments)
        : "";
    const tokens = attachmentBlock.length > 0
      ? this.deps.estimateContentTokens(attachmentBlock, {
          provider: this.activeOptions.providerName,
          model: this.activeOptions.mainLoopModel,
        })
      : 0;
    const attachment: FileMentionTurnAttachment = {
      type: "file_mentions",
      originalPrompt: prompt,
      expandedPrompt: expansion.prompt,
      attachments: [...expansion.attachments],
      rejected: [...expansion.rejected],
      tokens,
      timestamp: this.deps.now(),
    };
    turn.attachments.push(attachment);
    addTokens(turn, tokens, "attachment");
    return attachment;
  }

  async attachAgenCInstructions(
    options: LoadTieredInstructionsOptions,
  ): Promise<AgenCInstructionsTurnAttachment | null> {
    const turn = this.ensureTurn();
    const tiers = await this.deps.loadTieredInstructions(options);
    const content = this.deps.assembleTieredInstructions(tiers);
    const warnings = this.deps.formatTieredInstructionWarnings(tiers);
    if (content.trim().length === 0 && warnings.length === 0) {
      return null;
    }
    const tokens = content.length > 0
      ? this.deps.estimateContentTokens(content, {
          provider: this.activeOptions.providerName,
          model: this.activeOptions.mainLoopModel,
        })
      : 0;
    const attachment: AgenCInstructionsTurnAttachment = {
      type: "agenc_instructions",
      content,
      warnings,
      tiers,
      tokens,
      timestamp: this.deps.now(),
    };
    turn.attachments.push(attachment);
    addTokens(turn, tokens, "attachment");
    return attachment;
  }

  async attachSessionMemory(
    options: SessionMemoryPathOptions | string,
  ): Promise<SessionMemoryTurnAttachment | null> {
    const turn = this.ensureTurn();
    const content = await this.deps.getSessionMemoryContent(options);
    if (content === null || content.trim().length === 0) {
      return null;
    }
    const tokens = this.deps.estimateContentTokens(content, {
      provider: this.activeOptions.providerName,
      model: this.activeOptions.mainLoopModel,
    });
    const attachment: SessionMemoryTurnAttachment = {
      type: "session_memory",
      content,
      tokens,
      timestamp: this.deps.now(),
    };
    turn.attachments.push(attachment);
    addTokens(turn, tokens, "attachment");
    return attachment;
  }

  createTracker(): MultiTurnTracker {
    return {
      startTurn: () => this.startNewTurn(),
      getCurrentTurn: () => this.getCurrentTurn(),
      addMessage: (message) => this.addMessageToTurn(message),
      addToolCall: (call) => this.addToolCallToTurn(call),
      setState: (key, value) => this.setTurnState(key, value),
      getState: <T>(key: string) => this.getTurnState<T>(key),
      getHistory: () => this.getTurnHistory(),
      getRecent: (n) => this.getRecentTurns(n),
      getStats: () => this.getMultiTurnStats(),
      reset: () => this.resetMultiTurnState(),
    };
  }

  private ensureTurn(): MutableTurnContext {
    if (this.currentTurn === null) {
      this.startNewTurn();
    }
    return this.currentTurn!;
  }
}

export function createMultiTurnContextManager(
  options: MultiTurnOptions = {},
  deps: MultiTurnContextDependencies = {},
): MultiTurnContextManager {
  return new MultiTurnContextManager(options, deps);
}

const defaultManager = new MultiTurnContextManager();

/**
 * Compatibility wrapper for the donor module-level API.
 *
 * Production daemon/session code must use `createMultiTurnContextManager`
 * so turn history and state remain isolated per conversation.
 */
export function startNewTurn(): TurnContext {
  return defaultManager.startNewTurn();
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function getCurrentTurn(): TurnContext | null {
  return defaultManager.getCurrentTurn();
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function addMessageToTurn(message: MultiTurnMessage): void {
  defaultManager.addMessageToTurn(message);
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function addToolCallToTurn(call: MultiTurnToolCall): void {
  defaultManager.addToolCallToTurn(call);
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function setTurnState(key: string, value: unknown): void {
  defaultManager.setTurnState(key, value);
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function getTurnState<T>(key: string): T | undefined {
  return defaultManager.getTurnState<T>(key);
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function getTurnHistory(): TurnContext[] {
  return defaultManager.getTurnHistory();
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function getRecentTurns(n: number): TurnContext[] {
  return defaultManager.getRecentTurns(n);
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function getMultiTurnStats(): MultiTurnStats {
  return defaultManager.getMultiTurnStats();
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function clearTurnHistory(): void {
  defaultManager.clearTurnHistory();
}

/**
 * Compatibility wrapper for the donor module-level API.
 * Production callers should use a per-session manager instance instead.
 */
export function resetMultiTurnState(): void {
  defaultManager.resetMultiTurnState();
}

/**
 * Compatibility wrapper for the donor module-level tracker factory.
 *
 * This configures the module-level default manager for source parity. Live
 * multi-session code must call `createMultiTurnContextManager` instead.
 */
export function createMultiTurnTracker(
  options: MultiTurnOptions = {},
): MultiTurnTracker {
  defaultManager.configure(options);
  return defaultManager.createTracker();
}
