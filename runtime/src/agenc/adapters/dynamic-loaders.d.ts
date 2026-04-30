export function loadContextCollapseModule(): Promise<{
  applyCollapsesIfNeeded: (
    messages: unknown[],
    toolUseContext: unknown,
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
