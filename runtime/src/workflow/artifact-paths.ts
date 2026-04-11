const DOC_ONLY_PATH_RE = /\.(?:md|mdx|txt|rst|adoc)$/i;
const DOC_BASENAME_RE =
  /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|LICENSE|COPYING|NOTES|AGENTS|AGENC|PLAN)(?:\.[^/]+)?$/i;

function isDocumentationArtifactPath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return DOC_ONLY_PATH_RE.test(trimmed) || DOC_BASENAME_RE.test(trimmed);
}

export function areDocumentationOnlyArtifacts(
  values: readonly string[],
): boolean {
  const normalized = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return normalized.length > 0 &&
    normalized.every((value) => isDocumentationArtifactPath(value));
}
