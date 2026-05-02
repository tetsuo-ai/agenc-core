// T10 Group D — config subsystem barrel.
//
// Public surface:
//   - types + defaults + merge
//   - TOML loader (inline minimal parser, no new npm dep)
//   - profile resolver (AgenC-owned)
//   - env resolvers
//   - I-60 model disambiguation
//   - ConfigStore (snapshot + reload + subscribe; I-47 integration lives in T10-I)

export type {
  AgenCConfig,
  AgentBudgetConfig,
  AgentConfig,
  ApprovalPolicy,
  ApprovalsReviewer,
  SandboxMode,
  SandboxPolicy,
  ShellEnvironmentPolicy,
  ReasoningEffort,
  ReasoningSummary,
  ModelVerbosity,
  Personality,
  PermissionMode,
  AttachmentsConfig,
  AuthBackendConfigKind,
  AuthConfig,
  DaemonConfig,
  DaemonTransport,
  PermissionsConfig,
  ProviderCapabilityOverrides,
  ProviderConfig,
  ServiceTier,
  WebSearchMode,
  ProfileOverride,
  ToolsConfig,
  ToolBudget,
  HookCommand,
  HookEventName,
  HookMatcher,
  HooksMap,
  ExperimentsConfig,
  IdeConnectorConfig,
  ManagedWorkspacesConfig,
  PrivateStorageConfig,
  McpServerConfig,
  McpTransport,
  ProviderModelPair,
} from "./schema.js";

export {
  defaultConfig,
  mergeConfigs,
  normalizeRawConfig,
  normalizeAgenCKeyAliases,
  resolveModelDisambiguated,
  isValidPermissionMode,
  validatePermissionsConfig,
  validateHooksConfig,
  normalizeHookEventName,
  AmbiguousModelError,
  InvalidHooksConfigError,
  InvalidPermissionsConfigError,
  UnknownModelError,
  HOOK_EVENT_NAMES,
  KNOWN_CONFIG_KEYS,
} from "./schema.js";

export {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
  buildProviderModelCatalog,
  normalizeProviderSlug,
  readProviderConfig,
  resolveProviderSelection,
  resolveProviderSettings,
} from "./resolve-provider.js";

export {
  configuredModelForProvider,
  defaultModelForProvider,
  resolveDisambiguatedModelSelection,
  resolveModelSelection,
} from "./resolve-model.js";

export type {
  LoadConfigOptions,
  LoadedConfig,
} from "./loader.js";

export { loadConfig, parseToml, TomlParseError } from "./loader.js";

export {
  resolveProfile,
  listProfiles,
  OVERRIDABLE_PROFILE_KEYS,
  UnknownProfileError,
} from "./profiles.js";

export type { EnvSnapshot } from "./env.js";
export {
  resolveAgencHome,
  resolveApiKey,
  resolveProvider,
  resolveProfileName,
  resolveProviderApiKey,
  resolveModel,
  resolveWorkspace,
  resolveSimpleMode,
  applyEnvOverrides,
} from "./env.js";

export type { ConfigStoreListener, ConfigStoreOptions } from "./store.js";
export { ConfigStore } from "./store.js";
