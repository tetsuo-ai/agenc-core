import type { JsonRecord } from "../config/json.js";
import type { RuntimeStateRepository } from "../config/runtime-state-repository.js";
import { resolveCanonicalSessionCwd } from "../session/session-store.js";
import {
  immutableToolPermissionContext,
  type ToolPermissionContext,
} from "./types.js";

const PERMISSIONS_STATE_NAMESPACE = "permissions";
const BYPASS_ACCEPTANCE_FIELD = "bypassPermissionsAcceptedByCwd";
const BYPASS_ACCEPTANCE_VERSION = 1 as const;

declare const canonicalBypassPermissionsCwdBrand: unique symbol;

export type CanonicalBypassPermissionsCwd = string & {
  readonly [canonicalBypassPermissionsCwdBrand]: true;
};

interface BypassPermissionsCwdIdentity {
  readonly canonicalCwd: CanonicalBypassPermissionsCwd;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface PersistedBypassPermissionsConsent extends JsonRecord {
  readonly version: typeof BYPASS_ACCEPTANCE_VERSION;
  readonly canonicalCwd: CanonicalBypassPermissionsCwd;
  readonly dev: string;
  readonly ino: string;
}

function resolveBypassPermissionsCwdIdentity(
  cwd: string,
): BypassPermissionsCwdIdentity {
  const resolved = resolveCanonicalSessionCwd(cwd);
  if (resolved.kind === "identity_unsupported") {
    throw new Error(
      `Cannot bind bypassPermissions consent: this platform or filesystem does not provide stable workspace identity: ${cwd}`,
    );
  }
  if (resolved.kind !== "ok") {
    throw new Error(
      `Cannot bind bypassPermissions consent: cwd is not a stable canonical directory: ${cwd}`,
    );
  }
  return Object.freeze({
    canonicalCwd: resolved.cwd as CanonicalBypassPermissionsCwd,
    dev: resolved.dev,
    ino: resolved.ino,
  });
}

export function canonicalizeBypassPermissionsCwd(
  cwd: string,
): CanonicalBypassPermissionsCwd {
  return resolveBypassPermissionsCwdIdentity(cwd).canonicalCwd;
}

function acceptedByCwd(
  repository: RuntimeStateRepository,
): Readonly<Record<string, PersistedBypassPermissionsConsent>> {
  const namespace = repository.getNamespace(PERMISSIONS_STATE_NAMESPACE);
  const accepted = namespace[BYPASS_ACCEPTANCE_FIELD];
  if (accepted === undefined) return Object.freeze({});
  return accepted as Readonly<Record<string, PersistedBypassPermissionsConsent>>;
}

export function loadBypassPermissionsConsent(
  repository: RuntimeStateRepository,
  cwd: string,
  options: { readonly reload?: boolean } = {},
): readonly CanonicalBypassPermissionsCwd[] {
  const identity = resolveBypassPermissionsCwdIdentity(cwd);
  if (options.reload === true) repository.reload();
  const persisted = acceptedByCwd(repository)[identity.canonicalCwd];
  if (persisted === undefined) return [];
  if (
    persisted.version !== BYPASS_ACCEPTANCE_VERSION ||
    persisted.canonicalCwd !== identity.canonicalCwd ||
    persisted.dev !== identity.dev.toString(10) ||
    persisted.ino !== identity.ino.toString(10)
  ) {
    throw new Error(
      `Stored bypassPermissions consent no longer matches the current workspace identity: ${identity.canonicalCwd}`,
    );
  }
  return [identity.canonicalCwd];
}

export function recordBypassPermissionsConsent(
  repository: RuntimeStateRepository,
  cwd: string,
): CanonicalBypassPermissionsCwd {
  const identity = resolveBypassPermissionsCwdIdentity(cwd);
  const persisted = Object.freeze({
    version: BYPASS_ACCEPTANCE_VERSION,
    canonicalCwd: identity.canonicalCwd,
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
  });
  repository.updateNamespace(PERMISSIONS_STATE_NAMESPACE, (current) => {
    const accepted = current[BYPASS_ACCEPTANCE_FIELD] as
      | Readonly<Record<string, PersistedBypassPermissionsConsent>>
      | undefined;
    const existing = accepted?.[identity.canonicalCwd];
    if (
      existing?.version === persisted.version &&
      existing.canonicalCwd === persisted.canonicalCwd &&
      existing.dev === persisted.dev &&
      existing.ino === persisted.ino
    ) {
      return current as JsonRecord;
    }
    return {
      ...current,
      [BYPASS_ACCEPTANCE_FIELD]: {
        ...accepted,
        [identity.canonicalCwd]: persisted,
      },
    };
  });
  return identity.canonicalCwd;
}

export function bindBypassPermissionsConsent(
  context: ToolPermissionContext,
  canonicalCwd: CanonicalBypassPermissionsCwd,
): ToolPermissionContext {
  const accepted = context.bypassPermissionsAcceptedIn ?? [];
  return immutableToolPermissionContext(
    accepted.includes(canonicalCwd)
      ? context
      : {
          ...context,
          bypassPermissionsAcceptedIn: [...accepted, canonicalCwd],
        },
  );
}

/** Bind exact-cwd consent and establish session authority when policy permits. */
export function authorizeBypassPermissionsConsent(
  context: ToolPermissionContext,
  canonicalCwd: CanonicalBypassPermissionsCwd,
): ToolPermissionContext {
  if (context.bypassPermissionsModeDisabledByPolicy === true) {
    throw new Error(
      "Cannot authorize bypassPermissions because managed policy disables it",
    );
  }
  return immutableToolPermissionContext({
    ...bindBypassPermissionsConsent(context, canonicalCwd),
    isBypassPermissionsModeAvailable: true,
  });
}
