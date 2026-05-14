/**
 * Short-lived declarations for moved purge-boundary files that still need narrow
 * ambient types. Keep this file narrow and delete it when those imports are
 * made strict.
 */

declare module "@opentelemetry/sdk-metrics" {
  export type MeterProvider = unknown;
}

// Optional runtime dep — only needed when the user provisions Bedrock
// for token-counting via tokenEstimation.ts. The literal-import gives
// tsup a chance to bundle it, but the package is not in our
// dependencies list, so a real declaration would force every consumer
// to install AWS SDK packages they don't need.
declare module "@aws-sdk/client-bedrock-runtime" {
  export const BedrockRuntimeClient: new (
    config: Record<string, unknown>,
  ) => unknown;
  const mod: Record<string, unknown>;
  export default mod;
}

// Optional runtime deps for the Bedrock provider — same rationale as
// `@aws-sdk/client-bedrock-runtime` above: declared loosely so dynamic
// imports compile without forcing consumers to install the SDK.
declare module "@aws-sdk/client-bedrock" {
  export const BedrockClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<{
      inferenceProfileSummaries?: Array<{ inferenceProfileId?: string }>;
      nextToken?: string;
      models?: Array<{ modelArn?: string }>;
    }>;
  };
  export const ListInferenceProfilesCommand: new (
    args: Record<string, unknown>,
  ) => unknown;
  export const GetInferenceProfileCommand: new (
    args: Record<string, unknown>,
  ) => unknown;
}

declare module "@smithy/node-http-handler" {
  export const NodeHttpHandler: new (...args: unknown[]) => unknown;
}

declare module "@smithy/core" {
  export const NoAuthSigner: new (...args: unknown[]) => unknown;
}

declare module "@opentelemetry/sdk-trace-base" {
  export type BasicTracerProvider = unknown;
}

declare module "src/entrypoints/agentSdkTypes.js" {
  export type HookEvent = any;
  export type ModelUsage = Record<string, unknown>;
  export const HOOK_EVENTS: readonly HookEvent[];
  export type SDKMessage = any;
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

declare module "cross-spawn" {
  import type {
    ChildProcess,
    SpawnOptions,
    SpawnSyncOptions,
    SpawnSyncReturns,
  } from "child_process";

  type CrossSpawn = {
    (
      command: string,
      args?: readonly string[],
      options?: SpawnOptions,
    ): ChildProcess;
    sync(
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptions,
    ): SpawnSyncReturns<Buffer>;
  };

  const crossSpawn: CrossSpawn;
  export default crossSpawn;
}

interface ObjectConstructor {
  entries<T>(o: Partial<Record<string, T[]>>): [string, T[]][];
}

type StructuredSerializeOptions = import("node:worker_threads").StructuredSerializeOptions;

declare const Bun: {
  embeddedFiles?: readonly unknown[];
  file(path: string): unknown;
  which(command: string): string | null;
  hash(input: string | ArrayBufferView | ArrayBuffer, seed?: number | bigint): bigint;
  gc(synchronous?: boolean): number;
  semver: {
    order(a: string, b: string): -1 | 0 | 1;
    satisfies(version: string, range: string): boolean;
  };
};

declare module "semver" {
  export type SemverOpts = { loose?: boolean; includePrerelease?: boolean };
  export function gt(a: string, b: string, opts?: SemverOpts): boolean;
  export function gte(a: string, b: string, opts?: SemverOpts): boolean;
  export function lt(a: string, b: string, opts?: SemverOpts): boolean;
  export function lte(a: string, b: string, opts?: SemverOpts): boolean;
  export function eq(a: string, b: string, opts?: SemverOpts): boolean;
  export function satisfies(version: string, range: string, opts?: SemverOpts): boolean;
  export function compare(a: string, b: string, opts?: SemverOpts): -1 | 0 | 1;
  export function coerce(input: string | null | undefined, opts?: SemverOpts): { version: string } | null;
  export function major(version: string, opts?: SemverOpts): number;
  export function minor(version: string, opts?: SemverOpts): number;
  export function patch(version: string, opts?: SemverOpts): number;
  export function valid(version: string | null | undefined): string | null;
  export function parse(version: string | null | undefined, opts?: SemverOpts): { version: string } | null;
  export function inc(version: string, release: string): string | null;
  export function diff(a: string, b: string): string | null;
}
