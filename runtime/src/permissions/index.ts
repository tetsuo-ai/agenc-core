/**
 * T11 Wave 1 — permissions barrel.
 *
 * Consumers should import from `./permissions` rather than deep paths.
 * Wave 2 modules (classifier, hooks, dangerous-patterns, denial
 * tracking, permission-prompt tools) will extend this barrel — keep
 * the surface additive.
 *
 * @module
 */

// Types + runtime constants.
export type {
  AdditionalWorkingDirectory,
  EditablePermissionRuleSource,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionBehavior,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMode,
  PermissionPassthroughDecision,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionUpdate,
  PermissionUpdateDestination,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
  WorkingDirectorySource,
} from "./types.js";
export {
  ALL_PERMISSION_MODES,
  EDITABLE_SOURCES,
  LEGACY_TOOL_NAME_ALIASES,
  PERMISSION_BEHAVIORS,
  PERMISSION_RULE_SOURCES,
  SETTING_SOURCES,
  USER_ADDRESSABLE_PERMISSION_MODES,
  createEmptyToolPermissionContext,
  deepFreeze,
  isPermissionMode,
} from "./types.js";

// Rule parser + evaluator.
export {
  applyPermissionRulesToPermissionContext,
  applyPermissionUpdate,
  applyPermissionUpdates,
  clearAllRulesFromSource,
  convertRulesToUpdates,
  escapeRuleContent,
  filterDeniedAgents,
  getAllowRules,
  getAskRuleForTool,
  getAskRules,
  getDenyRuleForAgent,
  getDenyRuleForTool,
  getDenyRules,
  getLegacyToolNames,
  getRuleByContentsForTool,
  isPermissionUpdateDestination,
  matchRule,
  normalizeLegacyToolName,
  parseRuleString,
  serializeRuleValue,
  setRulesForSource,
  toolAlwaysAllowedRule,
  unescapeRuleContent,
} from "./rules.js";
export type { ToolLike } from "./rules.js";

// Evaluator (Wave 2-A).
export {
  attachContextDefaults,
  checkRuleBasedPermissions,
  hasPermissionsToUseTool,
  hasPermissionsToUseToolInner,
} from "./evaluator.js";
export type {
  AppStateSnapshot,
  CanUseToolFn,
  DecisionPhase,
  ToolEvaluatorContext,
  ToolLike as EvaluatorToolLike,
} from "./evaluator.js";

// Permission dialog context (Wave 2-A).
export {
  createPermissionContext,
  createPermissionQueueOps,
  createResolveOnce,
  defaultSupportsPersistence,
} from "./context.js";
export type {
  CreatePermissionContextOpts,
  DialogLogger,
  PendingPermissionRequest,
  PermissionApprovalSource,
  PermissionDialogContext,
  PermissionDecisionSource,
  PermissionHookResult,
  PermissionQueueOps,
  PermissionRejectionSource,
  PermissionRequestHook,
  PermissionToolLike,
  PersistDestinationCheck,
  ResolveOnce,
} from "./context.js";

// Auto-mode classifier (Wave 2-A stub).
export {
  classifyYoloAction,
  formatActionForClassifier,
  isAutoModeAllowlistedTool,
  isAutoModeGateEnabled as isAutoModeGateEnabledClassifier,
} from "./classifier.js";
export type {
  ClassifyYoloActionOpts,
  ClassifierWarningSink,
  LLMMessage,
  LLMUsage,
  YoloClassifierResult,
} from "./classifier.js";

// Settings (disk-facing glue).
export {
  addPermissionRulesToSettings,
  deletePermissionRule,
  getConfigFromStore,
  getEnabledSettingSources,
  getSettingsFilePathForSource,
  initialPermissionModeFromCLI,
  initializeToolPermissionContext,
  listAllRuleSources,
  listEditableSources,
  loadAllPermissionRulesFromDisk,
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
  readSettingsFileLenient,
  settingsJsonToRules,
  shouldAllowManagedPermissionRulesOnly,
  syncPermissionRulesFromDisk,
} from "./settings.js";
export type {
  AddPermissionRulesOpts,
  DeletePermissionRuleOpts,
  DiskEnv,
  InitialPermissionModeInput,
  InitialPermissionModeResult,
  InitializeToolPermissionContextOpts,
  InitializeToolPermissionContextResult,
  SettingsJson,
  SettingsPermissionsBlock,
} from "./settings.js";
