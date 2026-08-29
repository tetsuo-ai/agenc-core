import { isPlainRecord } from "./json.js";

export function normalizedCredentialFieldName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
}

function isCredentialReferenceField(name: string): boolean {
  return /_(?:DIGEST|ENV|ENVIRONMENT|ENV_VAR|FILE|HASH|ID|NAME|PATH|SHA256|TYPE|URL)$/u
    .test(name);
}

/**
 * Conservative name-only classifier used at plaintext persistence boundaries.
 * Reference fields such as `authorization_env` and `token_file` are excluded;
 * literal credential families fail closed.
 */
export function isCredentialLikeFieldName(value: string): boolean {
  const name = normalizedCredentialFieldName(value);
  if (isCredentialReferenceField(name)) return false;
  return (
    /(?:^|_)API_KEYS?(?:_|$)/u.test(name) ||
    /(?:^|_)(?:CLIENT_SECRET|CREDENTIAL|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|TOKEN)S?$/u
      .test(name) ||
    /(?:^|_)(?:ACCESS|AUTH|BEARER|ID|REFRESH|SESSION)_TOKENS?(?:_|$)/u.test(name) ||
    /(?:^|_)(?:AUTHORIZATIONS?|BEARERS?)(?:_|$)/u.test(name)
  );
}

function isSensitiveHeaderName(value: string): boolean {
  const name = normalizedCredentialFieldName(value);
  return (
    isCredentialLikeFieldName(name) ||
    name === "AUTHORIZATION" ||
    name === "COOKIE" ||
    name === "PROXY_AUTHORIZATION" ||
    name === "SET_COOKIE"
  );
}

function isPureEnvironmentHeaderTemplate(value: string): boolean {
  const placeholder = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/gu;
  if (!placeholder.test(value)) return false;
  placeholder.lastIndex = 0;
  const remainder = value.replace(placeholder, "").trim();
  return remainder.length === 0 || /^(?:Basic|Bearer)$/iu.test(remainder);
}

/** Return the first secret-like literal path without ever returning its value. */
export function firstPlaintextCredentialPath(value: unknown): string | undefined {
  const pending: Array<{
    readonly value: unknown;
    readonly path: string;
    readonly containerField?: string;
    readonly sensitivity?: "field" | "header";
  }> = [{ value, path: "" }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "string") {
      if (
        current.sensitivity === "field" ||
        (current.sensitivity === "header" &&
          !isPureEnvironmentHeaderTemplate(current.value))
      ) return current.path;
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
          ...(current.containerField !== undefined
            ? { containerField: current.containerField }
            : {}),
          ...(current.sensitivity !== undefined
            ? { sensitivity: current.sensitivity }
            : {}),
        });
      }
      continue;
    }
    if (!isPlainRecord(current.value)) continue;
    const entries = Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, nested] = entries[index]!;
      const path = current.path.length > 0 ? `${current.path}.${key}` : key;
      const field = normalizedCredentialFieldName(key);
      const sensitivity = current.sensitivity ??
        (current.containerField === "HEADERS" && isSensitiveHeaderName(field)
          ? "header"
          : isCredentialLikeFieldName(field)
            ? "field"
            : undefined);
      pending.push({
        value: nested,
        path,
        containerField: field,
        ...(sensitivity !== undefined ? { sensitivity } : {}),
      });
    }
  }
  return undefined;
}
