export type TipContentContext = {
  readonly theme?: string;
  readonly accent?: (text: string) => string;
};

export type TipRuntimeState = {
  readonly numStartups?: number;
  readonly lastPlanModeUse?: number;
  readonly memoryUsageCount?: number;
  readonly promptQueueUseCount?: number;
  readonly worktreeCount?: number;
  readonly concurrentSessionCount?: number;
  readonly optionAsMetaKeyInstalled?: boolean;
  readonly shiftEnterKeyBindingInstalled?: boolean;
  readonly githubActionSetupCount?: number;
  readonly slackAppInstallCount?: number;
  readonly hasDefaultPermissionMode?: boolean;
  readonly statusLineConfigured?: boolean;
  readonly customTitleEnabled?: boolean;
  readonly hasVisitedPasses?: boolean;
  readonly fileHistoryEnabled?: boolean;
};

export type SpinnerTipsOverride = {
  readonly tips?: readonly string[];
  readonly excludeDefault?: boolean;
};

export type TipSettings = {
  readonly spinnerTipsEnabled?: boolean;
  readonly spinnerTipsOverride?: SpinnerTipsOverride;
  readonly defaultPermissionMode?: string;
  readonly effortLevel?: string;
};

export type TipFeatureFlags = {
  readonly desktop?: boolean;
  readonly web?: boolean;
  readonly mobile?: boolean;
  readonly marketplace?: boolean;
  readonly passes?: boolean;
  readonly overageCredit?: boolean;
  readonly scheduledPrompts?: boolean;
  readonly subagentsNudge?: boolean;
  readonly effortNudge?: boolean;
};

export type TipEnvironment = {
  readonly terminal?: string;
  readonly platform?: NodeJS.Platform | "macos" | "windows" | "linux";
  readonly isSsh?: boolean;
  readonly colorLevel?: number;
  readonly colorterm?: string;
  readonly supportsTerminalSetup?: boolean;
  readonly supportsVsCodeShellCommand?: boolean;
  readonly externalTerminalHasRunningIde?: boolean;
  readonly powershellToolEnabled?: boolean;
};

export type TipHistoryOptions = {
  readonly configHomeDir?: string;
  readonly historyFile?: string;
  readonly sessionCount?: number;
};

export type TipAnalytics = {
  readonly logEvent?: (
    eventName: string,
    metadata: Record<string, string | number | boolean | undefined>,
  ) => void;
};

export type TipContext = TipContentContext & {
  readonly state?: TipRuntimeState;
  readonly settings?: TipSettings;
  readonly features?: TipFeatureFlags;
  readonly env?: TipEnvironment;
  readonly history?: TipHistoryOptions;
  readonly analytics?: TipAnalytics;
  readonly readFileState?: ReadonlyMap<string, unknown> | Record<string, unknown>;
  readonly bashTools?: ReadonlySet<string>;
  readonly nowMs?: number;
  readonly model?: {
    readonly name?: string;
    readonly supportsEffort?: boolean;
    readonly userSpecifiedSetting?: string;
  };
};

export type Tip = {
  readonly id: string;
  readonly content: (context?: TipContentContext) => Promise<string>;
  readonly cooldownSessions: number;
  readonly isRelevant: (context?: TipContext) => Promise<boolean>;
};
