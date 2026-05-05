declare module "@opentelemetry/sdk-metrics" {
  export type MeterProvider = unknown;
}

declare module "@opentelemetry/sdk-trace-base" {
  export type BasicTracerProvider = unknown;
}

declare module "src/entrypoints/agentSdkTypes.js" {
  export type HookEvent = string;
  export type ModelUsage = Record<string, unknown>;
  export const HOOK_EVENTS: readonly HookEvent[];
}

declare module "src/types/hooks.js" {
  export type HookCallbackMatcher = Record<string, unknown>;
}

declare module "src/utils/model/model.js" {
  export type ModelSetting = string | null;
}

declare module "src/utils/model/modelStrings.js" {
  export type ModelStrings = Record<string, string>;
}

declare module "src/utils/settings/constants.js" {
  export type SettingSource =
    | "userSettings"
    | "projectSettings"
    | "localSettings"
    | "flagSettings"
    | "policySettings";
}

declare module "src/utils/settings/types.js" {
  export type PluginHookMatcher = Record<string, unknown> & {
    pluginRoot?: string;
  };
}

declare module "src/services/mcp/types.js" {
  export type ConfigScope = string;
}

interface ObjectConstructor {
  entries<T>(o: Partial<Record<string, T[]>>): [string, T[]][];
}

type StructuredSerializeOptions = import("node:worker_threads").StructuredSerializeOptions;

declare const Bun: {
  embeddedFiles?: readonly unknown[];
  file(path: string): unknown;
  which(command: string): string | null;
};
