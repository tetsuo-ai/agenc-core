declare module "@opentelemetry/sdk-metrics" {
  export type MeterProvider = unknown;
}

declare module "@opentelemetry/sdk-trace-base" {
  export type BasicTracerProvider = unknown;
}

declare module "src/entrypoints/agentSdkTypes.js" {
  export type HookEvent =
    | "PreToolUse"
    | "PostToolUse"
    | "PostToolUseFailure"
    | "Notification"
    | "UserPromptSubmit"
    | "SessionStart"
    | "SessionEnd"
    | "Stop"
    | "StopFailure"
    | "SubagentStart"
    | "SubagentStop"
    | "PreCompact"
    | "PostCompact"
    | "PermissionRequest"
    | "PermissionDenied"
    | "Setup"
    | "TeammateIdle"
    | "TaskCreated"
    | "TaskCompleted"
    | "Elicitation"
    | "ElicitationResult"
    | "ConfigChange"
    | "WorktreeCreate"
    | "WorktreeRemove"
    | "InstructionsLoaded"
    | "CwdChanged"
    | "FileChanged";
  export const HOOK_EVENTS: readonly HookEvent[];
  export type ModelUsage = unknown;
}

declare module "src/types/hooks.js" {
  export type HookCallbackMatcher = Readonly<Record<string, unknown>>;
}

declare module "src/utils/model/model.js" {
  export type ModelSetting = string | null;
}

declare module "src/utils/model/modelStrings.js" {
  export type ModelStrings = Readonly<Record<string, string>>;
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
  export type PluginHookMatcher = Readonly<Record<string, unknown>> & {
    readonly pluginRoot?: string;
  };
}

declare module "src/services/mcp/types.js" {
  export type ConfigScope = "local" | "user" | "project";

  export interface MCPServerConnection {
    readonly [key: string]: unknown;
  }
}

declare const Bun: {
  readonly embeddedFiles?: readonly unknown[];
  readonly which?: (command: string) => string | null;
} | undefined;

interface StructuredSerializeOptions {
  transfer?: Transferable[];
}

type BodyInit = import("undici-types/fetch").BodyInit;
