import { AGENC_DAEMON_CLIENT_ENV_KEYS } from "../app-server/protocol/index.js";

/**
 * Complete client-owned environment surface captured once per runtime session.
 * The daemon protocol represents missing values as explicit empty clears so a
 * client cannot inherit another client's provider, credential, or tool state;
 * local process ingress simply omits values that were not present.
 * Home and workspace identity are deliberately absent; those come from the
 * daemon instance and trusted request cwd/config authorities.
 *
 * The list itself lives on the protocol surface
 * (`AGENC_DAEMON_CLIENT_ENV_KEYS`) so the SDK's generated wire types carry the
 * same allowlist and embedders forward exactly what the CLI forwards.
 */
export const CANONICAL_SESSION_ENV_KEYS = Object.freeze(
  AGENC_DAEMON_CLIENT_ENV_KEYS,
);

export type CanonicalSessionEnvironmentKey =
  (typeof CANONICAL_SESSION_ENV_KEYS)[number];

/**
 * Remote MCP bearer values are the only dynamic session environment keys.
 * The dedicated prefix makes the protocol surface auditable without opening
 * `agent.create.envOverrides` to arbitrary daemon-process state.
 */
export const SESSION_CREDENTIAL_ENV_PREFIX = "AGENC_CREDENTIAL_";

export function isDynamicSessionCredentialEnvironmentKey(key: string): boolean {
  return /^AGENC_CREDENTIAL_[A-Z0-9_]+$/u.test(key);
}

/** Return the complete static surface plus explicitly present MCP secret keys. */
export function canonicalSessionEnvironmentKeys(
  ...environments: ReadonlyArray<Readonly<Record<string, string | undefined>>>
): readonly string[] {
  const dynamicKeys = environments.flatMap((environment) =>
    Object.keys(environment).filter(isDynamicSessionCredentialEnvironmentKey),
  );
  return Object.freeze([
    ...CANONICAL_SESSION_ENV_KEYS,
    ...new Set(dynamicKeys.sort()),
  ]);
}
