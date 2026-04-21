// T10 Group D — config subsystem barrel.
//
// Public surface:
//   - types + defaults + merge
//   - TOML loader (inline minimal parser, no new npm dep)
//   - profile resolver (codex-derived)
//   - env resolvers
//   - I-60 model disambiguation
//   - ConfigStore (snapshot + reload + subscribe; I-47 integration lives in T10-I)

export type {
  AgenCConfig,
  ApprovalPolicy,
  SandboxMode,
  SandboxPolicy,
  ShellEnvironmentPolicy,
  ReasoningEffort,
  ReasoningSummary,
  Personality,
  PermissionMode,
  PermissionsConfig,
  WebSearchMode,
  ProfileOverride,
  ToolsConfig,
  ToolBudget,
  HookCommand,
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
  normalizeCodexKeyAliases,
  resolveModelDisambiguated,
  isValidPermissionMode,
  validatePermissionsConfig,
  AmbiguousModelError,
  InvalidPermissionsConfigError,
  UnknownModelError,
  KNOWN_CONFIG_KEYS,
} from "./schema.js";

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
  resolveModel,
  resolveWorkspace,
  resolveSimpleMode,
  applyEnvOverrides,
} from "./env.js";

export type { ConfigStoreListener, ConfigStoreOptions } from "./store.js";
export { ConfigStore } from "./store.js";
