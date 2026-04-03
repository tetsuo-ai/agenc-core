import { sanitizeInlineText } from "./agenc-watch-text-utils.mjs";
import { normalizeSessionValue } from "./agenc-watch-session-utils.mjs";

export function normalizeWatchSessionLabel(value, fallback = null) {
  const text = sanitizeInlineText(String(value ?? "").replace(/\s+/g, " "));
  return text || fallback;
}

export function createWatchSessionLabelMap(source) {
  const map = new Map();
  const entries = source instanceof Map
    ? [...source.entries()]
    : Array.isArray(source)
      ? source
      : source && typeof source === "object"
        ? Object.entries(source)
        : [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const sessionId = normalizeSessionValue(entry[0]);
    const label = normalizeWatchSessionLabel(entry[1], null);
    if (!sessionId || !label) {
      continue;
    }
    map.set(sessionId, label);
  }
  return map;
}

export function serializeWatchSessionLabels(sessionLabels) {
  if (!(sessionLabels instanceof Map) || sessionLabels.size === 0) {
    return {};
  }
  return Object.fromEntries(
    [...sessionLabels.entries()]
      .map(([sessionId, label]) => [
        normalizeSessionValue(sessionId),
        normalizeWatchSessionLabel(label, null),
      ])
      .filter(([sessionId, label]) => Boolean(sessionId && label)),
  );
}

export function resolveWatchSessionLabel(sessionId, sessionLabels) {
  const normalizedSessionId = normalizeSessionValue(sessionId);
  if (!normalizedSessionId || !(sessionLabels instanceof Map)) {
    return null;
  }
  return normalizeWatchSessionLabel(sessionLabels.get(normalizedSessionId), null);
}

export function setWatchSessionLabel(sessionLabels, sessionId, label) {
  if (!(sessionLabels instanceof Map)) {
    throw new TypeError("setWatchSessionLabel requires a sessionLabels map");
  }
  const normalizedSessionId = normalizeSessionValue(sessionId);
  const normalizedLabel = normalizeWatchSessionLabel(label, null);
  if (!normalizedSessionId) {
    throw new TypeError("setWatchSessionLabel requires a sessionId");
  }
  if (!normalizedLabel) {
    throw new TypeError("setWatchSessionLabel requires a non-empty label");
  }
  const previous = resolveWatchSessionLabel(normalizedSessionId, sessionLabels);
  sessionLabels.set(normalizedSessionId, normalizedLabel);
  return {
    sessionId: normalizedSessionId,
    label: normalizedLabel,
    previous,
    changed: previous !== normalizedLabel,
  };
}

export function clearWatchSessionLabel(sessionLabels, sessionId) {
  if (!(sessionLabels instanceof Map)) {
    throw new TypeError("clearWatchSessionLabel requires a sessionLabels map");
  }
  const normalizedSessionId = normalizeSessionValue(sessionId);
  if (!normalizedSessionId) {
    return null;
  }
  const previous = resolveWatchSessionLabel(normalizedSessionId, sessionLabels);
  sessionLabels.delete(normalizedSessionId);
  return previous;
}

export function buildWatchSessionQueryCandidates(session, {
  sessionLabels = null,
} = {}) {
  const values = [
    session?.sessionId,
    session?.label,
    session?.workspaceRoot,
    session?.workspacePath,
    session?.cwd,
    session?.model,
    session?.provider,
    resolveWatchSessionLabel(session?.sessionId, sessionLabels),
  ];
  return values
    .map((value) => sanitizeInlineText(String(value ?? "")).toLowerCase())
    .filter(Boolean);
}
