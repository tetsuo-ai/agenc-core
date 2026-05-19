import { realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export {
  REDACTED_SECRET,
  redactSecrets,
  redactSecretsInValue,
  type RedactableJson,
} from "./sanitizer.js";

export class SecretName {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  static parse(raw: string): SecretName {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new Error("secret name must not be empty");
    }
    if (!/^[A-Z0-9_]+$/.test(trimmed)) {
      throw new Error("secret name must contain only A-Z, 0-9, or _");
    }
    return new SecretName(trimmed);
  }

  toString(): string {
    return this.value;
  }
}

export type SecretScope =
  | { readonly kind: "global" }
  | { readonly kind: "environment"; readonly environmentId: string };

export const GLOBAL_SECRET_SCOPE: SecretScope = { kind: "global" };

export function environmentSecretScope(environmentId: string): SecretScope {
  const trimmed = environmentId.trim();
  if (trimmed.length === 0) {
    throw new Error("environment id must not be empty");
  }
  return { kind: "environment", environmentId: trimmed };
}

export function canonicalSecretKey(scope: SecretScope, name: SecretName): string {
  if (scope.kind === "global") return `global/${name.value}`;
  return `env/${scope.environmentId}/${name.value}`;
}

export function environmentIdFromCwd(cwd: string): string {
  const repoRoot = findGitRepoRoot(cwd);
  if (repoRoot !== null) {
    const name = path.basename(repoRoot).trim();
    if (name.length > 0) return name;
  }

  const canonical = canonicalOrSame(cwd);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `cwd-${digest.slice(0, 12)}`;
}

function findGitRepoRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    if (pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function canonicalOrSame(pathToCanonicalize: string): string {
  try {
    return realpathSync.native(pathToCanonicalize);
  } catch {
    try {
      return realpathSync(pathToCanonicalize);
    } catch {
      return pathToCanonicalize;
    }
  }
}

function pathExists(pathToCheck: string): boolean {
  try {
    realpathSync(pathToCheck);
    return true;
  } catch {
    return false;
  }
}
