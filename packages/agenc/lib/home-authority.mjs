import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export const RETIRED_CONFIG_DIR_ENV = "AGENC_CONFIG_DIR";

export class RetiredConfigDirError extends Error {
  name = "RetiredConfigDirError";
}

export class InvalidHomePathError extends Error {
  name = "InvalidHomePathError";
}

function nonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function assertNoRetiredConfigDir(env = process.env) {
  if (env.AGENC_CONFIG_DIR === undefined) return;
  const retired = nonEmpty(env.AGENC_CONFIG_DIR);
  const replacement = retired === undefined
    ? "set AGENC_HOME to the intended absolute home directory"
    : `set AGENC_HOME=${JSON.stringify(retired)}`;
  throw new RetiredConfigDirError(
    `AGENC_CONFIG_DIR is no longer a runtime configuration authority; ` +
      `${replacement} and remove AGENC_CONFIG_DIR. ` +
      `Only "agenc config migrate" may inspect this retired variable.`,
  );
}

export function canonicalizeAgenCHomePath(path) {
  const normalized = path.normalize("NFC");
  if (!isAbsolute(normalized)) {
    throw new InvalidHomePathError(
      `AGENC_HOME must be an absolute path so daemon, lock, and secure-storage identity is stable: ${JSON.stringify(path)}`,
    );
  }
  const missingComponents = [];
  let existingAncestor = normalized;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new InvalidHomePathError(
        `AGENC_HOME has no resolvable existing ancestor: ${JSON.stringify(path)}`,
      );
    }
    missingComponents.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  if (!statSync(existingAncestor).isDirectory()) {
    throw new InvalidHomePathError(
      `AGENC_HOME must resolve beneath a directory: ${JSON.stringify(path)}`,
    );
  }
  return join(realpathSync(existingAncestor), ...missingComponents).normalize("NFC");
}

export function resolveAgenCHome(env = process.env, userHome = homedir()) {
  assertNoRetiredConfigDir(env);
  const configured = nonEmpty(env.AGENC_HOME);
  return canonicalizeAgenCHomePath(configured ?? join(userHome, ".agenc"));
}
