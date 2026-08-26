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
import {
  type EditableSettingSource,
  type SettingSource,
} from "./constants.js";
import { type SettingsWithErrors } from "./validation.js";
import {
  type CanonicalSettingsAuthority,
  getCanonicalConfigLayers,
  getCanonicalSettingsAuthority,
} from "./canonicalAuthority.js";

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
): AgenCConfig | null {
  const layers = sourceScopes(source).flatMap((scope) =>
    getCanonicalConfigLayers(scope, authority)
  );
  return mergeConfigLayerSnapshots(layers);
}

export function getSettingsForSource(
  source: SettingSource,
  authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
): AgenCConfig | null {
  return configForSource(source, authority);
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

function classifyUpdate(settings: Partial<AgenCConfig>): "config" | Error {
  for (const key of Object.keys(settings)) {
    if (!CONFIG_OWNED_FIELDS.has(key)) {
      const reason = POLICY_OWNED_FIELDS.has(key)
        ? "managed policy is writable only through a managed config.toml layer"
        : "the field belongs to trust, credentials, or a retired surface";
      return new Error(`Cannot persist ${key}: ${reason}`);
    }
  }
  return "config";
}

export async function updateSettingsForSource(
  source: EditableSettingSource,
  settings: Partial<AgenCConfig>,
  explicitAuthority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
): Promise<{ error: Error | null }> {
  const classification = classifyUpdate(settings);
  if (classification instanceof Error) return { error: classification };
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
  let authority: CanonicalSettingsAuthority;
  try {
    authority = requireAuthority(explicitAuthority);
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  try {
    const path = getSettingsFilePathForSource(source, authority);
    if (!path) throw new Error(`No canonical config.toml target for ${source}`);
    const configScope = source === "userSettings"
      ? "user"
      : source === "projectSettings"
        ? "project"
        : "local";
    applyCanonicalConfigPatchSync(path, settings as JsonRecord, configScope);
    await authority.reload();
    return { error: null };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    logError(wrapped);
    return { error: wrapped };
  }
}

export function getInitialSettings(
  authority: CanonicalSettingsAuthority = requireAuthority(
    getCanonicalSettingsAuthority(),
  ),
): AgenCConfig {
  return authority.current();
}

export function getExecutionAuthoritySettings(): AgenCConfig {
  return getInitialSettings();
}

export function getSettingsWithErrors(): SettingsWithErrors {
  return { settings: getInitialSettings(), errors: [] };
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
