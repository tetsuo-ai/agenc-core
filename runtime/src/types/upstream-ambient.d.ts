declare module "@opentelemetry/sdk-metrics" {
  export interface MeterProvider {
    forceFlush?: () => Promise<void>;
    shutdown?: () => Promise<void>;
  }
}

declare module "@opentelemetry/sdk-trace-base" {
  export interface BasicTracerProvider {
    forceFlush?: () => Promise<void>;
    shutdown?: () => Promise<void>;
  }
}

declare module "src/entrypoints/agentSdkTypes.js" {
  type JsonValue =
    | string
    | number
    | boolean
    | null
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

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
  export type ModelUsage = {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadInputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly webSearchRequests: number;
    readonly costUSD: number;
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
  };
  export type HookJSONOutput = JsonValue | undefined;
  export type SyncHookJSONOutput = HookJSONOutput;
  export type AsyncHookJSONOutput = Promise<HookJSONOutput>;
}

declare module "src/types/hooks.js" {
  type HookJSONOutput = import("src/entrypoints/agentSdkTypes.js").HookJSONOutput;
  export type HookCallback = {
    readonly command?: string;
    readonly timeout?: number;
    readonly internal?: boolean;
  } | ((input: object, context?: object) => Promise<HookJSONOutput>);
  export type HookCallbackMatcher = {
    readonly matcher?: string;
    readonly hooks: readonly HookCallback[];
    readonly pluginName?: string;
  };
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
  export type HookCommand =
    | {
        readonly type: "command";
        readonly command: string;
        readonly if?: string;
        readonly shell?: "bash" | "powershell";
        readonly timeout?: number;
        readonly statusMessage?: string;
        readonly once?: boolean;
        readonly async?: boolean;
        readonly asyncRewake?: boolean;
      }
    | {
        readonly type: "prompt" | "agent";
        readonly prompt: string;
        readonly if?: string;
        readonly timeout?: number;
        readonly model?: string;
        readonly statusMessage?: string;
        readonly once?: boolean;
      }
    | {
        readonly type: "http";
        readonly url: string;
        readonly if?: string;
        readonly timeout?: number;
        readonly headers?: Readonly<Record<string, string>>;
        readonly allowedEnvVars?: readonly string[];
        readonly statusMessage?: string;
        readonly once?: boolean;
      };
  export type PluginHookMatcher = {
    readonly matcher?: string;
    readonly hooks: readonly HookCommand[];
    readonly pluginRoot: string;
    readonly pluginName?: string;
    readonly pluginId?: string;
  };
}

declare module "src/services/mcp/types.js" {
  type JsonValue =
    | string
    | number
    | boolean
    | null
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

  export type ConfigScope = "local" | "user" | "project" | "dynamic" | "enterprise" | "claudeai" | "managed";

  export type ScopedMcpServerConfig = {
    readonly scope: ConfigScope;
    readonly type?: "stdio" | "sse" | "sse-ide" | "http" | "ws" | "sdk";
    readonly pluginSource?: string;
    readonly [key: string]: JsonValue | undefined;
  };

  export type MCPServerConnection = {
    readonly name: string;
    readonly type: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
    readonly config: ScopedMcpServerConfig;
    readonly capabilities?: object;
    readonly serverInfo?: { readonly name: string; readonly version: string };
    readonly instructions?: string;
    readonly error?: string;
    readonly reconnectAttempt?: number;
    readonly maxReconnectAttempts?: number;
    readonly cleanup?: () => Promise<void>;
  };
}

declare const Bun: {
  readonly embeddedFiles?: readonly object[];
  readonly which?: (command: string) => string | null;
} | undefined;

interface StructuredSerializeOptions {
  transfer?: Transferable[];
}

type BodyInit = import("undici-types/fetch").BodyInit;
