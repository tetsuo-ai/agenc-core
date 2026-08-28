import { KNOWN_CONFIG_KEYS } from "./schema.js";

/** Retired persistence surfaces that may be inspected only by the v2 migrator. */
export type RetiredConfigSurface = "config-toml-v1" | "settings-json" | "global-state";

/** The single post-migration owner for a retired field. */
export type CanonicalFieldAuthority =
  | "config"
  | "policy"
  | "state"
  | "trust"
  | "credential"
  | "removed"
  | "unclassified";

export type RetiredFieldAction =
  | "copy"
  | "transform"
  | "retain"
  | "drop"
  | "block";

export interface RetiredFieldClassification {
  readonly surface: RetiredConfigSurface;
  readonly field: string;
  readonly authority: CanonicalFieldAuthority;
  readonly action: RetiredFieldAction;
  readonly target?: string;
  readonly note: string;
}

function entry(
  surface: RetiredConfigSurface,
  field: string,
  authority: CanonicalFieldAuthority,
  action: RetiredFieldAction,
  note: string,
  target?: string,
): RetiredFieldClassification {
  return Object.freeze({
    surface,
    field,
    authority,
    action,
    note,
    ...(target !== undefined ? { target } : {}),
  });
}

const V1_RENAMES = Object.freeze({
  configVersion: "config_version",
  modelProvider: "model_provider",
  provider: "model_provider",
  editorMode: "tui.vimMode",
  enabledPlugins: "plugins.plugins",
  effortLevel: "reasoning_effort",
  sandbox_policy: "sandbox_mode,sandbox",
  tools: "tools_config",
  model_reasoning_effort: "reasoning_effort",
  model_reasoning_summary: "reasoning_summary",
  agents: "agent_max_threads,agent_max_depth",
  cleanupPeriodDays: "transcriptPersistenceEnabled (only when zero)",
} as const);

const CONFIG_V1_REMOVED_FIELDS = Object.freeze([
  "agenc_home",
  "replBridgeEnabled",
  "remoteControlAtStartup",
  "default_agent",
  "managedWorkspaces",
  "privateStorage",
  "assistantName",
  "disableDeepLinkRegistration",
  "feedbackSurveyRate",
  "showClearContextOnPlanAccept",
  "spinnerTipsOverride",
  "terminalTitleFromRename",
  "useAutoModeDuringPlan",
  "voiceEnabled",
  "agentRouting",
  "assistant",
  "defaultView",
  "remote",
  "allowedChannelPlugins",
  "channelsEnabled",
  "classifierPermissionsEnabled",
  "companyAnnouncements",
  "forceLoginMethod",
  "maxSleepDurationMs",
  "minSleepDurationMs",
  "experiments",
  "tuiLayout",
  "toolBudget",
  "extraKnownMarketplaces",
  "review_model",
  "compact_prompt",
  "workspace",
  "advisorModel",
] as const);

const CONFIG_V1_ENTRIES = Object.freeze([
  ...KNOWN_CONFIG_KEYS
    .filter((field) => field !== "_unknown")
    .map((field) =>
      entry(
        "config-toml-v1",
        field,
        "config",
        Object.hasOwn(V1_RENAMES, field) ? "transform" : "copy",
        field === "configVersion"
          ? "schema marker is renamed and advanced to strict v2"
          : Object.hasOwn(V1_RENAMES, field)
            ? "retired field is normalized before v2 validation"
            : "the value remains owned by layered TOML",
        V1_RENAMES[field as keyof typeof V1_RENAMES] ?? field,
      ),
    ),
  ...Object.entries(V1_RENAMES)
    .filter(([field]) => !KNOWN_CONFIG_KEYS.includes(field))
    .map(([field, target]) =>
      entry(
        "config-toml-v1",
        field,
        "config",
        "transform",
        "retired alias is normalized before v2 validation",
        target,
      ),
    ),
  ...CONFIG_V1_REMOVED_FIELDS.map((field) =>
    entry(
      "config-toml-v1",
      field,
      "removed",
      "drop",
      field === "agenc_home"
        ? "AGENC_HOME through HomeContext is the only home authority"
        : "retired configuration has no schema-v2 behavior",
    )
  ),
]);

const SETTINGS_CONFIG_FIELDS = Object.freeze([
  "model",
  "permissions",
  "hooks",
  "autoFix",
  "sandbox",
  "enabledPlugins",
  "outputStyle",
  "fileSuggestion",
  "respectGitignore",
  "cleanupPeriodDays",
  "env",
  "attribution",
  "includeGitInstructions",
  "worktree",
  "defaultShell",
  "statusLine",
  "language",
  "spinnerTipsEnabled",
  "spinnerVerbs",
  "syntaxHighlightingDisabled",
  "alwaysThinkingEnabled",
  "swarmMode",
  "fastMode",
  "promptSuggestionEnabled",
  "pluginConfigs",
  "autoUpdatesChannel",
  "plansDirectory",
  "prefersReducedMotion",
  "autoMemoryEnabled",
  "autoMemoryDirectory",
  "autoDreamEnabled",
  "autoDreamMinHours",
  "autoDreamMinSessions",
  "showThinkingSummaries",
  "autoMode",
] as const);

const SETTINGS_POLICY_FIELDS = Object.freeze([
  "availableModels",
  "modelOverrides",
  "allowedMcpServers",
  "deniedMcpServers",
  "disableAllHooks",
  "allowManagedHooksOnly",
  "allowedHttpHookUrls",
  "httpHookAllowedEnvVars",
  "allowManagedPermissionRulesOnly",
  "allowManagedMcpServersOnly",
  "strictPluginOnlyCustomization",
  "strictKnownMarketplaces",
  "blockedMarketplaces",
  "forceLoginOrgUUID",
  "skipWebFetchPreflight",
  "minimumVersion",
  "disableAutoMode",
  "agencMdExcludes",
  "pluginTrustMessage",
] as const);

const SETTINGS_CREDENTIAL_FIELDS = Object.freeze([
  "apiKeyHelper",
  "awsCredentialExport",
  "awsAuthRefresh",
  "gcpAuthRefresh",
  "agentModels",
] as const);

const SETTINGS_TRUST_FIELDS = Object.freeze([
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "sshConfigs",
  "skipDangerousModePermissionPrompt",
  "skipAutoPermissionPrompt",
] as const);

const SETTINGS_REMOVED_FIELDS = Object.freeze([
  "fastModePerSessionOptIn",
  "$schema",
  "includeCoAuthoredBy",
  "assistantName",
  "disableDeepLinkRegistration",
  "feedbackSurveyRate",
  "showClearContextOnPlanAccept",
  "spinnerTipsOverride",
  "terminalTitleFromRename",
  "useAutoModeDuringPlan",
  "voiceEnabled",
  "agentRouting",
  "assistant",
  "defaultView",
  "remote",
  "remoteControlAtStartup",
  "agent",
  "allowedChannelPlugins",
  "channelsEnabled",
  "classifierPermissionsEnabled",
  "companyAnnouncements",
  "forceLoginMethod",
  "maxSleepDurationMs",
  "minSleepDurationMs",
  "extraKnownMarketplaces",
  "review_model",
  "compact_prompt",
  "workspace",
  "advisorModel",
] as const);

function settingsEntries(
  fields: readonly string[],
  authority: CanonicalFieldAuthority,
  action: RetiredFieldAction,
  note: string,
): readonly RetiredFieldClassification[] {
  return fields.map((field) =>
    entry("settings-json", field, authority, action, note, field),
  );
}

const SETTINGS_ENTRIES = Object.freeze([
  ...settingsEntries(
    SETTINGS_CONFIG_FIELDS,
    "config",
    "transform",
    "the migrator maps this value into its canonical TOML shape",
  ),
  ...settingsEntries(
    SETTINGS_POLICY_FIELDS,
    "policy",
    "transform",
    "managed policy moves into the canonical managed TOML layer",
  ),
  ...settingsEntries(
    SETTINGS_CREDENTIAL_FIELDS,
    "credential",
    "block",
    "secrets and credential helpers are never copied into TOML implicitly",
  ),
  ...settingsEntries(
    SETTINGS_TRUST_FIELDS,
    "trust",
    "block",
    "trust decisions must be migrated into the trust ledger explicitly",
  ),
  entry(
    "settings-json",
    "bypassPermissionsModeAcceptedIn",
    "state",
    "transform",
    "exact-cwd bypass consent moves into canonical runtime state after stable directory validation",
    "state.global.permissions.bypassPermissionsAcceptedByCwd",
  ),
  ...settingsEntries(
    SETTINGS_REMOVED_FIELDS,
    "removed",
    "drop",
    "deprecated setting has no v2 authority",
  ),
  entry(
    "settings-json",
    "effortLevel",
    "config",
    "transform",
    "retired effort is normalized into canonical reasoning effort",
    "reasoning_effort",
  ),
  entry(
    "settings-json",
    "xaaIdp",
    "config",
    "transform",
    "non-secret XAA IdP metadata moves into canonical TOML; client secrets remain in SecureStorage",
    "xaa_idp",
  ),
]);

const GLOBAL_CONFIG_FIELDS = Object.freeze([
  "projects",
  "numStartups",
  "installMethod",
  "doctorShownAtSession",
  "userID",
  "theme",
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "lastReleaseNotesSeen",
  "changelogLastFetched",
  "agencAiMcpEverConnected",
  "verbose",
  "preferredNotifChannel",
  "customApiKeyResponses",
  "hasAcknowledgedCostThreshold",
  "hasSeenUndercoverAutoNotice",
  "hasResetAutoModeOptInForDefaultOffer",
  "oauthAccount",
  "bypassPermissionsModeAccepted",
  "hasUsedBackslashReturn",
  "autoCompactEnabled",
  "toolHistoryCompressionEnabled",
  "showTurnDuration",
  "showCacheStats",
  "hasSeenTasksHint",
  "hasUsedStash",
  "hasUsedBackgroundTask",
  "queuedCommandUpHintCount",
  "diffTool",
  "iterm2SetupInProgress",
  "iterm2BackupPath",
  "appleTerminalBackupPath",
  "appleTerminalSetupInProgress",
  "shiftEnterKeyBindingInstalled",
  "optionAsMetaKeyInstalled",
  "autoConnectIde",
  "autoInstallIdeExtension",
  "hasIdeOnboardingBeenShown",
  "ideHintShownCount",
  "hasIdeAutoConnectDialogBeenShown",
  "tipsHistory",
  "companion",
  "companionMuted",
  "feedbackSurveyState",
  "transcriptShareDismissed",
  "memoryUsageCount",
  "hasShownS1MWelcomeV2",
  "s1mAccessCache",
  "s1mNonSubscriberAccessCache",
  "passesEligibilityCache",
  "groveConfigCache",
  "passesUpsellSeenCount",
  "hasVisitedPasses",
  "passesLastSeenRemaining",
  "overageCreditGrantCache",
  "overageCreditUpsellSeenCount",
  "hasVisitedExtraUsage",
  "voiceNoticeSeenCount",
  "voiceLangHintShownCount",
  "voiceLangHintLastLanguage",
  "voiceFooterHintSeenCount",
  "opus1mMergeNoticeSeenCount",
  "experimentNoticesSeenCount",
  "hasShownOpusPlanWelcome",
  "promptQueueUseCount",
  "lastPlanModeUse",
  "subscriptionNoticeCount",
  "hasAvailableSubscription",
  "todoFeatureEnabled",
  "showExpandedTodos",
  "showSpinnerTree",
  "firstStartTime",
  "messageIdleNotifThresholdMs",
  "githubActionSetupCount",
  "slackAppInstallCount",
  "fileCheckpointingEnabled",
  "terminalProgressBarEnabled",
  "showStatusInTerminalTab",
  "taskCompleteNotifEnabled",
  "inputNeededNotifEnabled",
  "agentPushNotifEnabled",
  "agencCodeFirstTokenDate",
  "modelSwitchCalloutDismissed",
  "modelSwitchCalloutLastShown",
  "modelSwitchCalloutVersion",
  "effortCalloutDismissed",
  "effortCalloutV2Dismissed",
  "remoteDialogSeen",
  "bridgeOauthDeadExpiresAt",
  "bridgeOauthDeadFailCount",
  "desktopUpsellSeenCount",
  "desktopUpsellDismissed",
  "idleReturnDismissed",
  "opusProMigrationComplete",
  "opusProMigrationTimestamp",
  "sonnet1m45MigrationComplete",
  "sonnet45To46MigrationTimestamp",
  "lastShownEmergencyTip",
  "copyFullResponse",
  "copyOnSelect",
  "flickerFreeMode",
  "githubRepoPaths",
  "deepLinkTerminal",
  "iterm2It2SetupComplete",
  "preferTmuxOverIterm2",
  "skillUsage",
  "officialMarketplaceAutoInstallAttempted",
  "officialMarketplaceAutoInstalled",
  "officialMarketplaceAutoInstallFailReason",
  "officialMarketplaceAutoInstallRetryCount",
  "officialMarketplaceAutoInstallLastAttemptTime",
  "officialMarketplaceAutoInstallNextRetryTime",
  "hasCompletedAgenCInChromeOnboarding",
  "agencInChromeDefaultEnabled",
  "cachedChromeExtensionInstalled",
  "chromeExtension",
  "lspRecommendationDisabled",
  "lspRecommendationNeverPlugins",
  "lspRecommendationIgnoredCount",
  "permissionExplainerEnabled",
  "teammateMode",
  "teammateDefaultModel",
  "prStatusFooterEnabled",
  "tungstenPanelVisible",
  "penguinModeOrgEnabled",
  "startupPrefetchedAt",
  "cachedExtraUsageDisabledReason",
  "autoPermissionsNotificationCount",
  "speculationEnabled",
  "clientDataCache",
  "additionalModelOptionsCache",
  "additionalModelOptionsCacheScope",
  "openaiAdditionalModelOptionsCache",
  "metricsStatusCache",
  "migrationVersion",
] as const);

const GLOBAL_STATE_FIELDS = new Set<string>([
  "projects",
  "installMethod",
  "userID",
  "hasAcknowledgedCostThreshold",
  "hasUsedBackslashReturn",
  "hasSeenTasksHint",
  "hasUsedStash",
  "appleTerminalBackupPath",
  "appleTerminalSetupInProgress",
  "shiftEnterKeyBindingInstalled",
  "optionAsMetaKeyInstalled",
  "hasIdeOnboardingBeenShown",
  "iterm2It2SetupComplete",
  "skillUsage",
]);

const GLOBAL_CONFIG_TARGETS = Object.freeze({
  theme: "tui.theme",
  showTurnDuration: "tui.showTurnDuration",
  autoInstallIdeExtension: "ideConnector.autoInstallExtension",
  fileCheckpointingEnabled: "fileCheckpointingEnabled",
  terminalProgressBarEnabled: "tui.terminalProgressBarEnabled",
  copyOnSelect: "tui.copyOnSelect",
  flickerFreeMode: "tui.flickerFreeMode",
  preferTmuxOverIterm2: "teammates.preferTmuxOverIterm2",
  teammateMode: "teammates.mode",
  teammateDefaultModel: "teammates.defaultModel",
  prStatusFooterEnabled: "tui.prStatusFooterEnabled",
  speculationEnabled: "speculationEnabled",
} as const);

const GLOBAL_CREDENTIAL_FIELDS = new Set<string>([
  "oauthAccount",
  "chromeExtension",
  "customApiKeyResponses",
]);

const GLOBAL_ENTRIES = Object.freeze([
  ...GLOBAL_CONFIG_FIELDS.map((field) => {
    if (GLOBAL_STATE_FIELDS.has(field)) {
      return entry(
        "global-state",
        field,
        "state",
        "retain",
        "observed runtime fact, acknowledgement, or bounded cache remains in state.json",
        field,
      );
    }
    const target = GLOBAL_CONFIG_TARGETS[
      field as keyof typeof GLOBAL_CONFIG_TARGETS
    ];
    if (target !== undefined) {
      return entry(
        "global-state",
        field,
        "config",
        "transform",
        "operator preference moves to its single canonical TOML key",
        target,
      );
    }
    if (GLOBAL_CREDENTIAL_FIELDS.has(field)) {
      const remediation = field === "oauthAccount"
        ? "re-login"
        : field === "chromeExtension"
          ? "re-pair the Chrome extension"
          : "re-approve ambient API keys";
      return entry(
        "global-state",
        field,
        "credential",
        "block",
        `security identity cannot be copied transactionally by the state migrator; ${remediation} after removing the retired field`,
      );
    }
    return entry(
      "global-state",
      field,
      "removed",
      "drop",
      "retired field has no runtime consumer or persistence authority",
    );
  }),
  entry(
    "global-state",
    "env",
    "config",
    "transform",
    "environment injection moves to canonical TOML",
    "shell_environment_policy",
  ),
  entry(
    "global-state",
    "autoUpdates",
    "config",
    "transform",
    "operator preference moves to canonical TOML",
    "autoUpdates",
  ),
  entry(
    "global-state",
    "editorMode",
    "config",
    "transform",
    "operator preference moves to canonical TOML",
    "tui.vimMode",
  ),
  entry(
    "global-state",
    "respectGitignore",
    "config",
    "transform",
    "operator preference moves to canonical TOML",
    "respectGitignore",
  ),
  entry(
    "global-state",
    "tui",
    "config",
    "transform",
    "operator preference moves to canonical TOML",
    "tui",
  ),
  entry(
    "global-state",
    "apiKeyHelper",
    "credential",
    "block",
    "command-based credential resolution requires explicit operator review",
  ),
  entry(
    "global-state",
    "primaryApiKey",
    "credential",
    "block",
    "API key must already exist in native secure storage before state cutover",
  ),
  entry(
    "global-state",
    "providerProfiles",
    "credential",
    "block",
    "retired profiles may contain secrets and require explicit operator review",
  ),
  entry(
    "global-state",
    "mcpServers",
    "trust",
    "block",
    "retired executable MCP declarations require explicit trust migration",
  ),
  ...[
    "remoteControlAtStartup",
    "autoUpdatesProtectedForNative",
    "activeProviderProfileId",
    "openaiAdditionalModelOptionsCacheByProfile",
    "cachedChangelog",
    "customNotifyCommand",
    "iterm2KeyBindingInstalled",
    "subscriptionUpsellShownCount",
    "recommendedSubscription",
    "legacyOpusMigrationTimestamp",
  ].map((field) =>
    entry(
      "global-state",
      field,
      "removed",
      "drop",
      "retired compatibility state has no runtime authority",
    )
  ),
]);

export const RETIRED_FIELD_MANIFEST: readonly RetiredFieldClassification[] =
  Object.freeze([
    ...CONFIG_V1_ENTRIES,
    ...SETTINGS_ENTRIES,
    ...GLOBAL_ENTRIES,
  ]);

const MANIFEST_INDEX = new Map(
  RETIRED_FIELD_MANIFEST.map((classification) => [
    `${classification.surface}:${classification.field}`,
    classification,
  ]),
);

/**
 * Every encountered key receives an answer. Unknown passthrough JSON fields
 * are deliberately classified as `unclassified/block`, never silently copied.
 */
export function classifyRetiredField(
  surface: RetiredConfigSurface,
  field: string,
): RetiredFieldClassification {
  return MANIFEST_INDEX.get(`${surface}:${field}`) ?? entry(
    surface,
    field,
    "unclassified",
    "block",
    "field is not in the reviewed migration manifest",
  );
}

export function retiredFieldManifestFor(
  surface: RetiredConfigSurface,
): readonly RetiredFieldClassification[] {
  return Object.freeze(
    RETIRED_FIELD_MANIFEST.filter((entry) => entry.surface === surface),
  );
}
