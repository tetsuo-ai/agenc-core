// T10 Group D — profile resolution (port of reference runtime profile_toml.rs).
//
// Profiles are named override bundles stored under `config.profiles`.
// Only these keys may be overridden by a profile:
//   - model
//   - model_provider
//   - approval_policy
//   - sandbox_mode
//   - reasoning_effort
//   - model_verbosity
//   - service_tier
//   - personality
//   - web_search
//   - tools (→ tools_config)
//
// Any other key in the profile is ignored (forward-compat silent drop).

import type {
  AgenCConfig,
  ProfileOverride,
  ToolsConfig,
} from "./schema.js";
import { mergeConfigs } from "./schema.js";

// Writable scratch view — `AgenCConfig` fields are readonly by design,
// but building the override payload needs assignability.
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class UnknownProfileError extends Error {
  readonly profile: string;
  readonly available: readonly string[];
  constructor(profile: string, available: readonly string[]) {
    super(
      `Unknown profile "${profile}". Available: ${available.length > 0 ? available.join(", ") : "<none>"}`,
    );
    this.name = "UnknownProfileError";
    this.profile = profile;
    this.available = Object.freeze([...available]);
  }
}

/**
 * Allowed overrideable fields. Everything else in a profile is ignored.
 */
const OVERRIDABLE_PROFILE_KEYS: readonly (keyof ProfileOverride)[] = Object.freeze([
  "model",
  "model_provider",
  "approval_policy",
  "sandbox_mode",
  "reasoning_effort",
  "approvals_reviewer",
  "model_verbosity",
  "service_tier",
  "personality",
  "web_search",
  "tools",
]);

function hasProfileOverride(
  profile: ProfileOverride,
  key: keyof ProfileOverride,
): boolean {
  return OVERRIDABLE_PROFILE_KEYS.includes(key) && profile[key] !== undefined;
}

/**
 * Merge the named profile over `config` and return a new frozen snapshot.
 *
 * - `profileName === undefined` → returns `config` unchanged.
 * - Unknown profile → `UnknownProfileError`.
 * - Only `OVERRIDABLE_PROFILE_KEYS` fields are applied; the rest is ignored.
 * - `tools` maps to `tools_config` on the canonical config.
 */
export function resolveProfile(
  config: AgenCConfig,
  profileName?: string,
): AgenCConfig {
  if (!profileName) return config;
  const profiles = config.profiles ?? {};
  const profile = profiles[profileName];
  if (!profile) {
    throw new UnknownProfileError(profileName, Object.keys(profiles));
  }

  const override: Mutable<Partial<AgenCConfig>> = {};
  if (hasProfileOverride(profile, "model")) override.model = profile.model;
  if (hasProfileOverride(profile, "model_provider"))
    override.model_provider = profile.model_provider;
  if (hasProfileOverride(profile, "approval_policy"))
    override.approval_policy = profile.approval_policy;
  if (hasProfileOverride(profile, "sandbox_mode"))
    override.sandbox_mode = profile.sandbox_mode;
  if (hasProfileOverride(profile, "reasoning_effort"))
    override.reasoning_effort = profile.reasoning_effort;
  if (hasProfileOverride(profile, "approvals_reviewer"))
    override.approvals_reviewer = profile.approvals_reviewer;
  if (hasProfileOverride(profile, "model_verbosity")) {
    override.model_verbosity = profile.model_verbosity;
  }
  if (hasProfileOverride(profile, "service_tier")) {
    override.service_tier = profile.service_tier;
  }
  if (hasProfileOverride(profile, "personality"))
    override.personality = profile.personality;
  if (hasProfileOverride(profile, "web_search")) {
    const tools: ToolsConfig = {
      ...(config.tools_config ?? {}),
      web_search:
        typeof profile.web_search === "boolean"
          ? profile.web_search
          : profile.web_search !== "never",
    };
    override.tools_config = tools;
  }
  if (hasProfileOverride(profile, "tools")) {
    override.tools_config = {
      ...(config.tools_config ?? {}),
      ...profile.tools,
    };
  }

  return mergeConfigs(config, override);
}

/** List all profile names declared in `config.profiles`. */
export function listProfiles(config: AgenCConfig): readonly string[] {
  const profiles = config.profiles ?? {};
  return Object.freeze(Object.keys(profiles).sort());
}
