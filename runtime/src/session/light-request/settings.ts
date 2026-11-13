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
  const config = services.configStore?.current();
  const override = services.providerEnvironment?.AGENC_LIGHT_REQUEST;
  const mode = override === undefined ? config?.light_request ?? DEFAULT_LIGHT_REQUEST : parseLightRequest(override);
  return mode === "lean" ? { ...LEAN_REQUEST_DEFAULTS, ...config?.light_request_options } : undefined;
}
