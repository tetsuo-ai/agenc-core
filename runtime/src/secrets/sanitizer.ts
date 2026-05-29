/**
 * Ports upstream Rust `secrets/src/sanitizer.rs` onto AgenC log and artifact
 * payloads.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC consumers persist structured JSON events, so this module redacts
 *     both raw strings and nested JSON-like values.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Local encrypted secret storage from the same upstream crate; SE-01 owns
 *     sanitizer behavior for logs, transcripts, hook output, and traces.
 */

export const REDACTED_SECRET = "[REDACTED_SECRET]";

const SECRET_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    // xAI — the runtime's OWN classifier key shape; redact first so a bare
    // `xai-...` never leaks even when no surrounding key/context is present.
    pattern: /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9_-]{16,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /(?<![A-Za-z0-9_-])gsk_[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}(?=$|[^A-Za-z0-9_])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}(?=$|[^A-Za-z0-9_])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    // Slack tokens (bot/app/user/refresh/configuration).
    pattern: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}(?=$|[^A-Za-z0-9-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    // Google API keys: fixed `AIza` prefix + 35 chars is specific enough on its own.
    pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    // AWS secret access keys are 40-char base64 with no distinctive prefix, so a
    // bare 40-char token is too noisy to redact. Scope to an explicit
    // aws/secret/access-key context word immediately preceding the value to keep
    // false positives off ordinary prose. The separator tolerates a closing
    // quote before the colon so JSON-quoted keys (`"aws_secret_access_key":`) are
    // covered, and the value tolerates trailing `=` base64 padding.
    pattern:
      /\b(aws[_-]?secret[_-]?access[_-]?key|aws[_-]?secret|secret[_-]?access[_-]?key)\b(["']?\s*[:=]\s*|\s+)(["']?)[A-Za-z0-9/+]{40}={0,2}(?![A-Za-z0-9/+=])/gi,
    replacement: `$1$2$3${REDACTED_SECRET}`,
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}(?=$|[^A-Za-z0-9._~+/=-])/gi,
    replacement: `Bearer ${REDACTED_SECRET}`,
  },
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern:
      /(["'])(api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)\1(\s*:\s*)(["']?)[^\s"',}]{8,}/gi,
    replacement: `$1$2$1$3$4${REDACTED_SECRET}`,
  },
  {
    pattern:
      /\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b(\s*[:=]\s*)(["']?)[^\s"',}]{8,}/gi,
    replacement: `$1$2$3${REDACTED_SECRET}`,
  },
];

const QUOTED_SECRET_ASSIGNMENT_PATTERN =
  /(["'])([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|authorization)[A-Za-z0-9_-]*)\1(\s*:\s*)(["']?)[^\s"',}]{8,}/gi;

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|authorization)[A-Za-z0-9_-]*)\b(\s*[:=]\s*)(["']?)[^\s"',}]{8,}/gi;

export type RedactableJson =
  | null
  | boolean
  | number
  | string
  | RedactableJson[]
  | { readonly [key: string]: RedactableJson };

/** Redacts common API keys, access tokens, bearer tokens, JWTs, and secret assignments. */
export function redactSecrets(input: string): string {
  let redacted = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  redacted = redacted.replace(
    QUOTED_SECRET_ASSIGNMENT_PATTERN,
    (match, quote: string, key: string, separator: string, valueQuote: string) =>
      isSensitiveKey(key)
        ? `${quote}${key}${quote}${separator}${valueQuote}${REDACTED_SECRET}`
        : match,
  );
  redacted = redacted.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (match, key: string, separator: string, valueQuote: string) =>
      isSensitiveKey(key)
        ? `${key}${separator}${valueQuote}${REDACTED_SECRET}`
        : match,
  );
  return redacted;
}

/** Redacts strings inside JSON-like artifacts without mutating the original value. */
export function redactSecretsInValue<T>(value: T): T {
  return redactValue(value, new WeakMap<object, unknown>()) as T;
}


function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) {
      output.push(redactValue(item, seen));
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key) && nested !== null && nested !== undefined) {
      output[key] = REDACTED_SECRET;
      continue;
    }
    output[key] = redactValue(nested, seen);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return (
    normalized === "apikey" ||
    normalized.endsWith("apikey") ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized.endsWith("tokenvalue") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secretvalue") ||
    // AWS access keys normalize to `...accesskey`/`...secretkey`, matching neither
    // `apikey` nor `secret`; recognize their specific shapes without making every
    // `...key` sensitive.
    normalized.endsWith("secretaccesskey") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("accesskeyid") ||
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwordvalue") ||
    normalized.includes("authorization")
  );
}
