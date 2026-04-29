import { listResumableSessions } from "../commands/resume.js";

export type ResumeSessionResolution =
  | { readonly kind: "ok"; readonly sessionId: string }
  | { readonly kind: "none" }
  | { readonly kind: "not_found"; readonly input: string }
  | {
      readonly kind: "ambiguous";
      readonly input: string;
      readonly matches: readonly string[];
    };

function projectSessions(cwd: string): readonly string[] {
  const seen = new Set<string>();
  const sessionIds: string[] = [];
  for (const entry of listResumableSessions(cwd, {
    maxFiles: 10_000,
    limit: 10_000,
  })) {
    if (seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    sessionIds.push(entry.sessionId);
  }
  return sessionIds;
}

export function resolveLatestSessionId(cwd: string): ResumeSessionResolution {
  const latest = projectSessions(cwd)[0];
  return latest ? { kind: "ok", sessionId: latest } : { kind: "none" };
}

export function resolveResumeSessionId(
  cwd: string,
  input: string,
): ResumeSessionResolution {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { kind: "not_found", input };
  }

  const sessionIds = projectSessions(cwd);
  const exact = sessionIds.find((sessionId) => sessionId === trimmed);
  if (exact !== undefined) {
    return { kind: "ok", sessionId: exact };
  }

  const prefixMatches = sessionIds.filter((sessionId) =>
    sessionId.startsWith(trimmed),
  );
  if (prefixMatches.length === 1) {
    return { kind: "ok", sessionId: prefixMatches[0]! };
  }
  if (prefixMatches.length > 1) {
    return {
      kind: "ambiguous",
      input: trimmed,
      matches: prefixMatches.slice(0, 8),
    };
  }
  return { kind: "not_found", input: trimmed };
}
