import { feature } from "bun:bundle";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";

import type { JsonRecord } from "../../config/json.js";
import {
  MANAGED_ONLY_CONFIG_KEYS,
  OPERATOR_ONLY_CONFIG_KEYS,
} from "../../config/layer-authority.js";
import { mergeConfigLayerSnapshots } from "../../config/repository.js";
import {
  KNOWN_CONFIG_KEYS,
  type AgenCConfig,
} from "../../config/schema.js";
import { applyCanonicalConfigPatchSync } from "../../config/update-sync.js";
import { hasSecurityAcknowledgementSync } from "../../permissions/trust/project-trust.js";
import { logError } from "../log.js";
import { clone } from "../slowOperations.js";
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from "./constants.js";
import {
  type SettingsWithErrors,
  type ValidationError,
} from "./validation.js";
import {
  type CanonicalSettingsAuthority,
  getCanonicalConfigLayers,
  getCanonicalSettingsAuthority,
} from "./canonicalAuthority.js";

const SETTINGS_STATE_NAMESPACE = "settings";

export interface RuntimeSettingsState {
  readonly fastModePerSessionOptIn?: boolean;
  readonly bypassPermissionsModeAcceptedIn?: readonly string[];
}

/**
 * The only runtime settings view: the canonical resolved TOML config plus the
 * two genuine mutable state facts. It deliberately introduces no renamed
 * compatibility fields.
 */
export type RuntimeSettingsSnapshot = AgenCConfig & RuntimeSettingsState;
export type RuntimeSettingsPatch = Partial<RuntimeSettingsSnapshot>;

const RuntimeSettingsStateSchema = z.object({
  fastModePerSessionOptIn: z.boolean().optional(),
  bypassPermissionsModeAcceptedIn: z.array(z.string()).optional(),
}).strict();

const STATE_OWNED_FIELDS = new Set([
  "fastModePerSessionOptIn",
  "bypassPermissionsModeAcceptedIn",
]);

const POLICY_OWNED_FIELDS: ReadonlySet<string> = new Set(
  MANAGED_ONLY_CONFIG_KEYS,
);

const CONFIG_OWNED_FIELDS = new Set(
  KNOWN_CONFIG_KEYS.filter(
    (key) =>
      key !== "configVersion" &&
      key !== "_unknown" &&
      !POLICY_OWNED_FIELDS.has(key),
  ),
);

function requireAuthority(
  authority: CanonicalSettingsAuthority | null,
): CanonicalSettingsAuthority {
  if (authority === null) {
    throw new Error(
      "Canonical settings authority is required for mutable runtime settings",
    );
  }
  return authority;
}

function readStateSettings(
  authority: CanonicalSettingsAuthority,
): RuntimeSettingsState {
  const raw = authority.stateRepository.getNamespace(SETTINGS_STATE_NAMESPACE);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`state.global.${SETTINGS_STATE_NAMESPACE} must be an object`);
  }
  const unauthorized = Object.keys(raw).filter(
    (key) => !STATE_OWNED_FIELDS.has(key),
  );
  if (unauthorized.length > 0) {
    throw new Error(
      `state.global.${SETTINGS_STATE_NAMESPACE} contains non-state fields: ${unauthorized.sort().join(", ")}`,
    );
  }
  const parsed = RuntimeSettingsStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `state.global.${SETTINGS_STATE_NAMESPACE} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function sourceScopes(source: SettingSource): readonly Parameters<typeof getCanonicalConfigLayers>[0][] {
  switch (source) {
    case "userSettings":
      return ["user"];
    case "projectSettings":
      return ["project"];
    case "localSettings":
      return ["local"];
    case "flagSettings":
      return ["flag", "profile", "environment", "cli"];
    case "policySettings":
      return ["managed"];
  }
}

function configForSource(
  source: SettingSource,
  authority: CanonicalSettingsAuthority | null,
): RuntimeSettingsSnapshot | null {
  const layers = sourceScopes(source).flatMap((scope) =>
    getCanonicalConfigLayers(scope, authority)
  );
  return mergeConfigLayerSnapshots(layers);
}

export function getSettingsForSource(
  source: SettingSource,
  authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
): RuntimeSettingsSnapshot | null {
  const config = configForSource(source, authority);
  if (source !== "userSettings") return config;
  const state = readStateSettings(requireAuthority(authority));
  return Object.keys(state).length > 0 || config !== null
    ? Object.freeze({ ...(config ?? {}), ...state })
    : null;
}

/** Canonical managed-TOML policy projection; no JSON policy file is read. */
export function loadManagedFileSettings(): {
  settings: RuntimeSettingsSnapshot | null;
  errors: ValidationError[];
} {
  return { settings: getSettingsForSource("policySettings"), errors: [] };
}

export function getManagedFileSettingsPresence(): {
  hasBase: boolean;
  hasDropIns: boolean;
} {
  const layers = getCanonicalConfigLayers("managed");
  return { hasBase: layers.length > 0, hasDropIns: layers.length > 1 };
}

export function getSettingsRootPathForSource(
  source: SettingSource,
  authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
): string {
  if (!authority) {
    throw new Error("Canonical ConfigStore context is required to resolve configuration paths");
  }
  switch (source) {
    case "userSettings":
      return authority.homeContext.path;
    case "projectSettings":
    case "localSettings":
      return resolve(authority.projectRoot);
    case "policySettings": {
      const path = getCanonicalConfigLayers("managed", authority).at(-1)?.path;
      if (!path) throw new Error("No canonical managed config.toml layer is active");
      return dirname(path);
    }
    case "flagSettings": {
      const path = getCanonicalConfigLayers("flag", authority)[0]?.path;
      if (!path) throw new Error("No canonical flag config.toml layer is active");
      return dirname(resolve(path));
    }
  }
}

export function getSettingsFilePathForSource(
  source: SettingSource,
  authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
): string | undefined {
  switch (source) {
    case "userSettings":
      return authority?.homeContext.configTomlPath;
    case "projectSettings":
      return getCanonicalConfigLayers("project", authority)[0]?.path ??
        (authority
          ? join(resolve(authority.projectRoot), ".agenc", "config.toml")
          : undefined);
    case "localSettings":
      return getCanonicalConfigLayers("local", authority)[0]?.path ??
        (authority
          ? join(resolve(authority.projectRoot), ".agenc", "config.local.toml")
          : undefined);
    case "policySettings":
      return getCanonicalConfigLayers("managed", authority).at(-1)?.path;
    case "flagSettings":
      return getCanonicalConfigLayers("flag", authority)[0]?.path;
  }
}

export function getRelativeSettingsFilePathForSource(
  source: "projectSettings" | "localSettings",
): string {
  return source === "projectSettings" ? ".agenc/config.toml" : ".agenc/config.local.toml";
}

function mergePatch(target: JsonRecord, patch: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
      continue;
    }
    if (
      typeof value === "object" && value !== null && !Array.isArray(value) &&
      typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key])
    ) {
      mergePatch(target[key] as JsonRecord, value as Record<string, unknown>);
      if (Object.keys(target[key] as JsonRecord).length === 0) delete target[key];
      continue;
    }
    target[key] = clone(value) as JsonRecord[string];
  }
}

function classifyUpdate(settings: RuntimeSettingsPatch): "config" | "state" | Error {
  let owner: "config" | "state" | null = null;
  for (const key of Object.keys(settings)) {
    const next = CONFIG_OWNED_FIELDS.has(key)
      ? "config"
      : STATE_OWNED_FIELDS.has(key)
        ? "state"
        : null;
    if (next === null) {
      const reason = POLICY_OWNED_FIELDS.has(key)
        ? "managed policy is writable only through a managed config.toml layer"
        : "the field belongs to trust, credentials, or a retired surface";
      return new Error(`Cannot persist ${key}: ${reason}`);
    }
    if (owner !== null && owner !== next) {
      return new Error(
        "A settings update cannot span config.toml and state.json; split it into two explicit updates",
      );
    }
    owner = next;
  }
  return owner ?? "state";
}

export async function updateSettingsForSource(
  source: EditableSettingSource,
  settings: RuntimeSettingsPatch,
  explicitAuthority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
): Promise<{ error: Error | null }> {
  const owner = classifyUpdate(settings);
  if (owner instanceof Error) return { error: owner };
  if (source === "projectSettings" || source === "localSettings") {
    const operatorOnly = Object.keys(settings).filter((key) =>
      OPERATOR_ONLY_CONFIG_KEYS.includes(
        key as (typeof OPERATOR_ONLY_CONFIG_KEYS)[number],
      )
    );
    if (operatorOnly.length > 0) {
      return {
        error: new Error(
          `Cannot persist ${operatorOnly.sort().join(", ")} to ${source}: operator-owned values belong in user or managed config.toml`,
        ),
      };
    }
    if (settings.disableAllHooks === false) {
      return {
        error: new Error(
          `Cannot persist disableAllHooks=false to ${source}: repository restrictions are monotonic`,
        ),
      };
    }
  }
  if (owner === "state" && source !== "userSettings") {
    return {
      error: new Error(`Mutable runtime preferences are user state and cannot be written to ${source}`),
    };
  }
  let authority: CanonicalSettingsAuthority;
  try {
    authority = requireAuthority(explicitAuthority);
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  try {
    if (owner === "state") {
      authority.stateRepository.updateNamespace(SETTINGS_STATE_NAMESPACE, (current) => {
        const next = clone(current) as JsonRecord;
        mergePatch(next, settings as Readonly<Record<string, unknown>>);
        const unauthorized = Object.keys(next).filter(
          (key) => !STATE_OWNED_FIELDS.has(key),
        );
        if (unauthorized.length > 0) {
          throw new Error(
            `state.global.${SETTINGS_STATE_NAMESPACE} contains non-state fields: ${unauthorized.sort().join(", ")}`,
          );
        }
        const parsed = RuntimeSettingsStateSchema.safeParse(next);
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          );
        }
        return parsed.data as JsonRecord;
      });
    } else {
      const path = getSettingsFilePathForSource(source, authority);
      if (!path) throw new Error(`No canonical config.toml target for ${source}`);
      const configScope = source === "userSettings"
        ? "user"
        : source === "projectSettings"
          ? "project"
          : "local";
      applyCanonicalConfigPatchSync(path, settings as JsonRecord, configScope);
      await authority.reload();
    }
    return { error: null };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    logError(wrapped);
    return { error: wrapped };
  }
}

export function getManagedSettingsKeysForLogging(settings: RuntimeSettingsPatch): string[] {
  const expanded = new Set<string>();
  const validSettings = settings as Record<string, unknown>;
  for (const key of Object.keys(validSettings)) {
    if (
      ["permissions", "sandbox", "hooks"].includes(key) &&
      validSettings[key] && typeof validSettings[key] === "object"
    ) {
      for (const child of Object.keys(validSettings[key] as Record<string, unknown>)) {
        expanded.add(`${key}.${child}`);
      }
    } else {
      expanded.add(key);
    }
  }
  return [...expanded].sort();
}

export function getInitialSettings(): RuntimeSettingsSnapshot {
  const authority = requireAuthority(getCanonicalSettingsAuthority());
  return Object.freeze({ ...authority.current(), ...readStateSettings(authority) });
}

export function getExecutionAuthoritySettings(): RuntimeSettingsSnapshot {
  return getInitialSettings();
}

export type SettingsWithSources = {
  effective: RuntimeSettingsSnapshot;
  sources: Array<{ source: SettingSource; settings: RuntimeSettingsSnapshot }>;
};

export function getSettingsWithSources(): SettingsWithSources {
  const sources: SettingsWithSources["sources"] = [];
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source);
    if (settings && Object.keys(settings).length > 0) sources.push({ source, settings });
  }
  return { effective: getInitialSettings(), sources };
}

export function getSettingsWithErrors(): SettingsWithErrors {
  return { settings: getInitialSettings(), errors: [] };
}

export function getPolicySettingsOrigin(): "managed-toml" | null {
  return getCanonicalConfigLayers("managed").length > 0 ? "managed-toml" : null;
}

export function hasAutoModeOptIn(): boolean {
  if (!feature("TRANSCRIPT_CLASSIFIER")) return false;
  const authority = getCanonicalSettingsAuthority();
  return authority !== null && hasSecurityAcknowledgementSync(
    "auto-mode-permission-prompt",
    { agencHome: authority.homeContext.path },
  );
}

export function getAutoModeConfig():
  | { allow?: string[]; soft_deny?: string[]; environment?: string[] }
  | undefined {
  if (!feature("TRANSCRIPT_CLASSIFIER")) return undefined;
  const schema = z.object({
    allow: z.array(z.string()).optional(),
    soft_deny: z.array(z.string()).optional(),
    environment: z.array(z.string()).optional(),
  });
  const result = schema.safeParse(getExecutionAuthoritySettings().autoMode);
  return result.success ? result.data : undefined;
}

export function rawSettingsContainsKey(key: string): boolean {
  return getEnabledSettingSources().some((source) => {
    const settings = getSettingsForSource(source);
    return settings !== null && Object.prototype.hasOwnProperty.call(settings, key);
  });
}
