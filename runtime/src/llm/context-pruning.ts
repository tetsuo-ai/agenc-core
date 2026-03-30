import type { ContextArtifactRef } from "../memory/artifact-store.js";

const DEFAULT_MAX_ARTIFACT_CONTEXT_CHARS = 1_600;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9._/-]{3,}/g)?.filter((token) => token.length > 2) ?? [],
  );
}

function scoreRef(
  artifact: ContextArtifactRef,
  queryTerms: ReadonlySet<string>,
): number {
  let score = 0;
  const haystack = tokenize(
    `${artifact.kind} ${artifact.title} ${artifact.summary} ${artifact.tags.join(" ")}`,
  );
  for (const term of queryTerms) {
    if (haystack.has(term)) score += 2;
  }
  if (
    artifact.kind === "plan" ||
    artifact.kind === "test_result" ||
    artifact.kind === "compiler_diagnostic"
  ) {
    score += 2;
  }
  return score;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 3)}...`;
}

export function selectRelevantArtifactRefs(params: {
  readonly artifacts: readonly ContextArtifactRef[];
  readonly query: string;
  readonly maxChars?: number;
}): readonly string[] {
  const maxChars = Math.max(
    0,
    params.maxChars ?? DEFAULT_MAX_ARTIFACT_CONTEXT_CHARS,
  );
  if (maxChars === 0 || params.artifacts.length === 0) {
    return [];
  }

  const queryTerms = tokenize(params.query);
  const ranked = params.artifacts
    .map((artifact) => ({
      artifact,
      score: scoreRef(artifact, queryTerms),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.artifact.createdAt - left.artifact.createdAt;
    });

  const lines: string[] = [];
  let used = 0;
  for (const { artifact } of ranked) {
    const line = `[artifact-ref:${artifact.kind}:${artifact.id}] ${artifact.title} — ${artifact.summary}`;
    const normalized = truncateText(line.replace(/\s+/g, " ").trim(), 320);
    if (used > 0 && used + normalized.length + 1 > maxChars) {
      break;
    }
    lines.push(normalized);
    used += normalized.length + 1;
  }

  return lines;
}
