const ROLE_LABELS = Object.freeze({
  coding: "Runner",
  implement: "Runner",
  worker: "Runner",
  docs: "Scribe",
  documentation: "Scribe",
  research: "Scanner",
  explore: "Scanner",
  explorer: "Scanner",
  verify: "Sentinel",
  verification: "Sentinel",
  verifier: "Sentinel",
  review: "Sentinel",
  reviewer: "Sentinel",
  operator: "Fixer",
  marketplace: "Broker",
  market: "Broker",
  "browser-testing": "Ghost",
  "browser-test": "Ghost",
  browser: "Ghost",
  "remote-debugging": "Trace",
  "remote-debug": "Trace",
  remote: "Trace",
});

function normalizeRoleKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^project:/, "")
    .replace(/^user:/, "")
    .replace(/[_\s]+/gu, "-");
}

export function resolveWatchAgentLabel(value, fallback = null) {
  const key = normalizeRoleKey(value);
  if (!key) return fallback;
  return ROLE_LABELS[key] ?? fallback;
}

export function looksLikeCanonicalTaskPath(value) {
  return /^\/root(?:\/|$)/.test(String(value ?? "").trim());
}

export function compactAgentSessionFallback(value, compactSessionToken) {
  const token = typeof compactSessionToken === "function"
    ? compactSessionToken(value)
    : null;
  return token ? `Agent ${token}` : "Child agent";
}
