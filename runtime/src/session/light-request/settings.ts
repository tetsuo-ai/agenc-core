import type { AgenCConfig, LightRequestOptions } from "../../config/schema.js";

// Native DeepSeek Light runs lean unless the user chose otherwise (0.19.34). Other providers and
// standard sessions never reach the lean profile (resolveLightRequest returns early for them).
export const DEFAULT_LIGHT_REQUEST = "lean" as const;

/** All lean defaults live here so measurement results can change them together. */
export const LEAN_REQUEST_DEFAULTS: Readonly<Required<LightRequestOptions>> = Object.freeze({
  short_system_prompt: true,
  environment_in_system: true,
  reminders: false,
  compact_tool_results: true,
  tool_result_markers: true,
  core_tools_only: true,
  tool_search: false,
  process_tools: true,
  compact_tool_definitions: true,
  low_effort: true,
  // Measured in job lean12: minimal keeps the saving on workflow-engine at the control's score.
  system_text: "minimal",
  // Shell edits reduced measured cost at equal score; tools restores Write and apply_patch.
  edit_mode: "shell",
});

export type LeanEditMode = Required<LightRequestOptions>["edit_mode"];

/**
 * Applied only when nobody chose a request (no `light_request`, no AGENC_LIGHT_REQUEST): the default keeps
 * tool search on, so sub-agents, web, MCP and skills stay reachable for everyone who did not opt into the
 * measured lean profile. An explicit `light_request = "lean"` keeps LEAN_REQUEST_DEFAULTS as they are, and
 * `light_request_options` override both.
 */
export const DEFAULT_LEAN_OVERRIDES: Readonly<Partial<Required<LightRequestOptions>>> = Object.freeze({
  tool_search: true,
});

export interface LightRequestSession {
  readonly services?: {
    readonly runtimeOptions?: { readonly lightMode?: boolean; readonly simpleMode?: boolean };
    readonly providerEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly configStore?: {
      current(): AgenCConfig;
      provenance?(key: string): { readonly scope: string } | undefined;
    };
  };
}

// The prompt is assembled at startup. Reloading presentation switches later
// must not leave its text, tool surface and wire layout on different profiles.
const sessionSettings = new WeakMap<LightRequestSession, Readonly<Required<LightRequestOptions>> | null>();

export function parseLightRequest(value: string): "full" | "lean" {
  const mode = value.trim().toLowerCase();
  if (mode === "full" || mode === "lean") return mode;
  throw new Error("invalid AGENC_LIGHT_REQUEST; expected full or lean");
}

/** Native DeepSeek only, from the session's config and captured client environment. */
export function resolveLightRequest(
  session: LightRequestSession,
  provider: string | undefined,
): Readonly<Required<LightRequestOptions>> | undefined {
  const services = session.services;
  if (services?.runtimeOptions?.lightMode !== true || services.runtimeOptions.simpleMode === true ||
      provider !== "deepseek") return undefined;
  const captured = sessionSettings.get(session);
  if (captured !== undefined) return captured ?? undefined;
  const config = services.configStore?.current();
  const chosen = chosenLightRequest(session);
  const mode = chosen ?? DEFAULT_LIGHT_REQUEST;
  const base = chosen === undefined ? { ...LEAN_REQUEST_DEFAULTS, ...DEFAULT_LEAN_OVERRIDES } : LEAN_REQUEST_DEFAULTS;
  const settings = mode === "lean" ? Object.freeze({ ...base, ...config?.light_request_options }) : null;
  sessionSettings.set(session, settings);
  return settings ?? undefined;
}

/**
 * The request the user chose for this session: AGENC_LIGHT_REQUEST from the captured client environment,
 * else `light_request` from config, else undefined (the default applies). Throws on an invalid override,
 * as resolveLightRequest always did.
 */
export function chosenLightRequest(session: LightRequestSession): "full" | "lean" | undefined {
  const override = session.services?.providerEnvironment?.AGENC_LIGHT_REQUEST;
  if (override !== undefined) return parseLightRequest(override);
  return session.services?.configStore?.current()?.light_request;
}

/**
 * The session's captured lean edit mode, or undefined outside lean. The registry and the tool
 * executor ask on every call; an invalid AGENC_LIGHT_REQUEST is left to the request builder.
 */
export function leanEditMode(
  session: LightRequestSession | null | undefined,
  provider: string | undefined,
): LeanEditMode | undefined {
  if (session == null) return undefined;
  try { return resolveLightRequest(session, provider)?.edit_mode; } catch { return undefined; }
}
