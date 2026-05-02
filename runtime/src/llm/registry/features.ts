/**
 * Ports donor runtime `co\u0064ex-rs/features/src/*` staged feature registry
 * semantics onto AgenC feature names.
 */

export type AgenCFeatureStage =
  | "under_development"
  | "experimental"
  | "stable"
  | "deprecated"
  | "removed";

export type AgenCFeatureKey =
  | "shell_tool"
  | "unified_exec"
  | "shell_snapshot"
  | "apply_patch_freeform"
  | "apply_patch_streaming_events"
  | "exec_permission_approvals"
  | "request_permissions_tool"
  | "web_search_request"
  | "web_search_cached"
  | "multi_agent"
  | "multi_agent_v2"
  | "goals"
  | "fast_mode"
  | "personality"
  | "workspace_dependencies";

export interface AgenCFeatureSpec {
  readonly key: AgenCFeatureKey;
  readonly stage: AgenCFeatureStage;
  readonly defaultEnabled: boolean;
  readonly menuName?: string;
  readonly menuDescription?: string;
}

export const AGENC_FEATURE_SPECS: readonly AgenCFeatureSpec[] = Object.freeze([
  {
    key: "shell_tool",
    stage: "stable",
    defaultEnabled: true,
  },
  {
    key: "unified_exec",
    stage: "stable",
    defaultEnabled: process.platform !== "win32",
  },
  {
    key: "shell_snapshot",
    stage: "stable",
    defaultEnabled: true,
  },
  {
    key: "apply_patch_freeform",
    stage: "under_development",
    defaultEnabled: false,
  },
  {
    key: "apply_patch_streaming_events",
    stage: "under_development",
    defaultEnabled: false,
  },
  {
    key: "exec_permission_approvals",
    stage: "under_development",
    defaultEnabled: false,
  },
  {
    key: "request_permissions_tool",
    stage: "under_development",
    defaultEnabled: false,
  },
  {
    key: "web_search_request",
    stage: "deprecated",
    defaultEnabled: false,
  },
  {
    key: "web_search_cached",
    stage: "deprecated",
    defaultEnabled: false,
  },
  {
    key: "multi_agent",
    stage: "stable",
    defaultEnabled: true,
  },
  {
    key: "multi_agent_v2",
    stage: "under_development",
    defaultEnabled: false,
  },
  {
    key: "goals",
    stage: "experimental",
    defaultEnabled: false,
    menuName: "Goals",
    menuDescription: "Set a persistent goal AgenC can continue over time.",
  },
  {
    key: "fast_mode",
    stage: "stable",
    defaultEnabled: true,
  },
  {
    key: "personality",
    stage: "stable",
    defaultEnabled: true,
  },
  {
    key: "workspace_dependencies",
    stage: "stable",
    defaultEnabled: true,
  },
]);

const LEGACY_FEATURE_ALIASES: Readonly<Record<string, AgenCFeatureKey>> =
  Object.freeze({
    include_apply_patch_tool: "apply_patch_freeform",
    experimental_use_freeform_apply_patch: "apply_patch_freeform",
    experimental_use_unified_exec_tool: "unified_exec",
    request_permissions: "exec_permission_approvals",
    web_search: "web_search_request",
    collab: "multi_agent",
  });

export class AgenCFeatureSet {
  readonly #enabled: Set<AgenCFeatureKey>;

  private constructor(enabled: Iterable<AgenCFeatureKey>) {
    this.#enabled = new Set(enabled);
  }

  static withDefaults(): AgenCFeatureSet {
    return new AgenCFeatureSet(
      AGENC_FEATURE_SPECS.filter((spec) => spec.defaultEnabled).map(
        (spec) => spec.key,
      ),
    );
  }

  static fromConfig(
    entries: Readonly<Record<string, boolean | undefined>> = {},
  ): AgenCFeatureSet {
    const features = AgenCFeatureSet.withDefaults();
    features.apply(entries);
    features.normalizeDependencies();
    return features;
  }

  enabled(feature: AgenCFeatureKey): boolean {
    return this.#enabled.has(feature);
  }

  enabledFeatures(): readonly AgenCFeatureKey[] {
    return Object.freeze([...this.#enabled].sort());
  }

  setEnabled(feature: AgenCFeatureKey, enabled: boolean): void {
    if (enabled) {
      this.#enabled.add(feature);
    } else {
      this.#enabled.delete(feature);
    }
  }

  apply(entries: Readonly<Record<string, boolean | undefined>>): void {
    for (const [rawKey, enabled] of Object.entries(entries)) {
      if (enabled === undefined) continue;
      const feature = featureForKey(rawKey);
      if (feature === undefined) continue;
      this.setEnabled(feature, enabled);
    }
  }

  normalizeDependencies(): void {
    if (this.enabled("multi_agent_v2")) {
      this.setEnabled("multi_agent", true);
    }
  }
}

export function featureForKey(key: string): AgenCFeatureKey | undefined {
  if (isCanonicalFeatureKey(key)) return key;
  return LEGACY_FEATURE_ALIASES[key];
}

export function isKnownFeatureKey(key: string): boolean {
  return featureForKey(key) !== undefined;
}

export function experimentalFeatureSpecs(): readonly AgenCFeatureSpec[] {
  return Object.freeze(
    AGENC_FEATURE_SPECS.filter((spec) => spec.stage === "experimental"),
  );
}

function isCanonicalFeatureKey(key: string): key is AgenCFeatureKey {
  return AGENC_FEATURE_SPECS.some((spec) => spec.key === key);
}
