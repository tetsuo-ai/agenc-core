import type { AgenCConfig, LightRequestOptions } from "../../config/schema.js";

export const DEFAULT_LIGHT_REQUEST = "full" as const;

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
  // tools keeps Write and apply_patch. shell and check are measured in jobs edit13 and rep13.
  edit_mode: "tools",
});

export type LeanEditMode = Required<LightRequestOptions>["edit_mode"];

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
  const override = services.providerEnvironment?.AGENC_LIGHT_REQUEST;
  const mode = override === undefined ? config?.light_request ?? DEFAULT_LIGHT_REQUEST : parseLightRequest(override);
  const settings = mode === "lean" ? Object.freeze({ ...LEAN_REQUEST_DEFAULTS, ...config?.light_request_options }) : null;
  sessionSettings.set(session, settings);
  return settings ?? undefined;
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
