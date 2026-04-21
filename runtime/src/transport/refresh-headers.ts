import type { HeaderMap, RefreshHeaders } from "./index.js";

const AUTH_HEADER_KEYS = [
  "Authorization",
  "Cookie",
  "X-Organization-Uuid",
] as const;

function normalizeAuthHeaders(headers: HeaderMap): HeaderMap {
  const next = { ...headers };
  if (next.Cookie) {
    delete next.Authorization;
  }
  return next;
}

function authFingerprint(headers: HeaderMap): string {
  return AUTH_HEADER_KEYS.map((key) => `${key}:${headers[key] ?? ""}`).join("\n");
}

export interface RefreshedHeadersResult {
  readonly headers: HeaderMap;
  readonly changed: boolean;
}

export function applyRefreshedHeaders(
  headers: HeaderMap,
  refreshHeaders?: RefreshHeaders,
): HeaderMap {
  if (!refreshHeaders) {
    return normalizeAuthHeaders(headers);
  }
  return normalizeAuthHeaders({
    ...headers,
    ...refreshHeaders(),
  });
}

export function refreshAuthHeaders(
  headers: HeaderMap,
  refreshHeaders?: RefreshHeaders,
): RefreshedHeadersResult {
  const next = applyRefreshedHeaders(headers, refreshHeaders);
  return {
    headers: next,
    changed: authFingerprint(next) !== authFingerprint(normalizeAuthHeaders(headers)),
  };
}
