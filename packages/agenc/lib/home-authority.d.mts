export interface AgenCHomeEnvironment {
  readonly AGENC_HOME?: string;
  readonly AGENC_CONFIG_DIR?: string;
  readonly [key: string]: string | undefined;
}

export const RETIRED_CONFIG_DIR_ENV: "AGENC_CONFIG_DIR";

export class RetiredConfigDirError extends Error {
  readonly name: "RetiredConfigDirError";
}

export class InvalidHomePathError extends Error {
  readonly name: "InvalidHomePathError";
}

export function assertNoRetiredConfigDir(
  env?: AgenCHomeEnvironment,
): void;

export function canonicalizeAgenCHomePath(path: string): string;

export function resolveAgenCHome(
  env?: AgenCHomeEnvironment,
  userHome?: string,
): string;
