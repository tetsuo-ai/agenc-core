import type { CliRuntimeContext, CliStatusCode, ParsedArgv } from "./types.js";

export type RoutedStatus = CliStatusCode | null;

export interface CliRouteContext {
  parsed: ParsedArgv;
  context: CliRuntimeContext;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface CliRouteModule {
  run(routeContext: CliRouteContext): Promise<RoutedStatus>;
}

export interface CliRouteDescriptor {
  name: string;
  matches(parsed: ParsedArgv): boolean;
  load(): Promise<CliRouteModule>;
}
