export function enableUpstreamConfigGate(): Promise<void>;

export function loadContextCollapseModule(): Promise<{
  applyCollapsesIfNeeded: (
    messages: unknown[],
    toolUseContext: unknown,
    querySource?: string,
  ) => Promise<{ messages: unknown[]; committed: number }>;
  recoverFromOverflow: (
    messages: unknown[],
  ) => { messages: unknown[]; committed: number };
}>;

export function loadAutoCompactModule(): Promise<{
  autoCompactIfNeeded: (
    messages: unknown[],
    toolUseContext: unknown,
    cacheSafeParams: unknown,
    querySource?: string,
    tracking?: unknown,
    snipTokensFreed?: number,
  ) => Promise<{
    wasCompacted: boolean;
    compactionResult?: unknown;
    consecutiveFailures?: number;
  }>;
}>;

export function loadCompactModule(): Promise<{
  buildPostCompactMessages: (result: unknown) => unknown[];
}>;

export function loadMicroCompactModule(): Promise<{
  microcompactMessages: (
    messages: unknown[],
    toolUseContext?: unknown,
    querySource?: string,
  ) => Promise<{ messages: unknown[]; compactionInfo?: unknown }>;
  resetMicrocompactState: () => void;
}>;

export function loadToolResultStorageModule(): Promise<{
  applyToolResultBudget: (
    messages: unknown[],
    state?: unknown,
    writeToTranscript?: unknown,
    skipToolNames?: ReadonlySet<string>,
  ) => Promise<{ messages: unknown[]; newlyReplaced: unknown[] }>;
}>;

export function loadPromptContextModules(): Promise<{
  getSystemPrompt: (
    tools: unknown,
    model: string,
    additionalWorkingDirectories?: string[],
    mcpClients?: unknown,
  ) => Promise<string[]>;
  getUserContext: () => Promise<Record<string, string>>;
  getSystemContext: () => Promise<Record<string, string>>;
  buildEffectiveSystemPrompt: (params: {
    mainThreadAgentDefinition: unknown;
    toolUseContext: unknown;
    customSystemPrompt?: string;
    defaultSystemPrompt: string[];
    appendSystemPrompt?: string;
  }) => readonly string[];
}>;

export function loadMessageUtilityModule(): Promise<{
  createSyntheticUserCaveatMessage: () => unknown;
  createUserMessage: (params: {
    content: unknown;
    timestamp?: string;
  }) => unknown;
  formatCommandInputTags: (commandName: string, args: string) => string;
}>;

export function loadManualCompactCommand(): Promise<{
  call: (
    args: string,
    context: unknown,
  ) => Promise<{
    type: string;
    compactionResult?: unknown;
    displayText?: string;
  }>;
}>;

export function loadContextNonInteractiveCommand(): Promise<{
  call: (
    args: string,
    context: unknown,
  ) => Promise<{
    type: "text";
    value: string;
  }>;
}>;
