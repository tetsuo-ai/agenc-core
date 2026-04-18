function plainText(line) {
  if (typeof line === "string") {
    return line;
  }
  return String(line?.plainText ?? line?.text ?? "");
}

function usesPreviewHeadline(kind) {
  return kind === "you" || kind === "queued" || kind === "agent";
}

export function splitTranscriptPreviewForHeadline(event, previewLines = []) {
  const lines = Array.isArray(previewLines) ? [...previewLines] : [];
  if (!usesPreviewHeadline(String(event?.kind ?? ""))) {
    return {
      headline: "",
      bodyLines: lines,
    };
  }

  const firstPreviewLine = plainText(lines.shift() ?? "");
  return {
    headline: firstPreviewLine,
    bodyLines: lines,
  };
}

export function computeTranscriptPreviewMaxLines({
  eventKind = "",
  sourcePreview = false,
  mutationPreview = false,
  latestIsCurrent = false,
  following = false,
  viewportLines = 12,
  maxPreviewSourceLines = 160,
} = {}) {
  const viewport = Math.max(12, Number(viewportLines) || 12);
  if (eventKind === "agent" && latestIsCurrent && following) {
    return Infinity;
  }
  const sourceInlineBudget = mutationPreview
    ? Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 32 : 18,
        Math.floor(viewport * (latestIsCurrent ? 0.84 : 0.56)),
      ),
    )
    : Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 12 : 6,
        Math.floor(viewport * (latestIsCurrent ? 0.32 : 0.2)),
      ),
    );
  if (mutationPreview) {
    return sourceInlineBudget;
  }
  if (sourcePreview) {
    return Math.min(sourceInlineBudget, latestIsCurrent ? 10 : 6);
  }
  if (eventKind === "agent") {
    return Math.max(
      latestIsCurrent ? 10 : 6,
      Math.floor(viewport * (latestIsCurrent ? 0.42 : 0.24)),
    );
  }
  if (eventKind === "market") {
    return latestIsCurrent ? 8 : 6;
  }
  // Tool and subagent outputs are where code and file contents land. The
  // old 2-line cap reduced an editFile diff, a readFile of a 200-line
  // source file, or a bash build log to "first line + ellipsis", which
  // is exactly what made every non-trivial tool result look "cut off".
  // Use the same proportional sizing as `sourceInlineBudget` so tool
  // output respects the viewport instead of a hard cap.
  if (
    eventKind === "tool" ||
    eventKind === "tool result" ||
    eventKind === "tool error" ||
    eventKind === "subagent tool" ||
    eventKind === "subagent tool result" ||
    eventKind === "subagent error"
  ) {
    return Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 20 : 10,
        Math.floor(viewport * (latestIsCurrent ? 0.55 : 0.3)),
      ),
    );
  }
  if (eventKind === "subagent") {
    // Subagent status cards are lighter than their tool output — a
    // short summary is enough — but 2 was too aggressive; show the
    // full summary headline + progress lines.
    return latestIsCurrent ? 6 : 4;
  }
  if (eventKind === "you" || eventKind === "operator" || eventKind === "queued") {
    return 3;
  }
  if (eventKind === "error" || eventKind === "approval") {
    return 3;
  }
  // Keep the conservative default for unrecognized event kinds. The
  // tool/subagent cases above are where the "code is cut off"
  // symptom lives; unknown kinds are rare and a tight default
  // prevents spam when new event types are added without explicit
  // sizing.
  return 2;
}
