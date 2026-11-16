/**
 * What the USER sees after an AskUserQuestion call settles.
 *
 * The tool result text is written for the model ("User has answered your
 * questions: ... You can now continue with the user's answers in mind.").
 * No surface may print that sentence. The tool also returns the structured
 * outcome as result metadata (`metadata.askUserQuestion`, never sent to a
 * model); clients render from it. Sessions recorded before the metadata
 * existed fall back to parsing the model-facing text.
 *
 * Pure module: no TUI, provider or registry imports, so the daemon, the TUI
 * and tests can all share it.
 */

export const ASK_USER_QUESTION_DISPLAY_KEY = "askUserQuestion";

export type AskUserQuestionOutcome =
  | "answered"
  | "skipped"
  | "chat_about_this"
  | "skip_plan_interview";

export interface AskUserQuestionDisplayEntry {
  readonly question: string;
  readonly answer: string;
  readonly note?: string;
}

export interface AskUserQuestionDisplay {
  readonly outcome: AskUserQuestionOutcome;
  readonly entries: readonly AskUserQuestionDisplayEntry[];
}

export const QUESTIONS_SKIPPED_TEXT = "Questions skipped";
export const QUESTIONS_ANSWERED_TEXT = "Questions answered";
export const QUESTIONS_DISCUSS_TEXT = "Chose to discuss the questions first";
export const PLAN_INTERVIEW_SKIPPED_TEXT = "Planning interview skipped";
export const QUESTIONS_UNANSWERED_TEXT = "No answer given";

const ANSWERED_PREFIX = "User has answered your questions: ";
const ANSWERED_SUFFIX = ". You can now continue with the user's answers in mind.";
const SKIPPED_PREFIX = "User skipped these questions.";
const CHAT_PREFIX = "User wants to chat about these questions before answering.";
const SKIP_INTERVIEW_PREFIX = "User skipped the planning interview";
const UNANSWERED_TEXT = "User did not provide answers.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function questionTexts(questions: unknown): string[] {
  if (!Array.isArray(questions)) return [];
  const out: string[] = [];
  for (const item of questions) {
    const text = typeof item === "string"
      ? item
      : isRecord(item) && typeof item.question === "string" ? item.question : "";
    if (text.length > 0) out.push(text);
  }
  return out;
}

/** Builds the metadata value the tool attaches to its result. */
export function buildAskUserQuestionDisplay(input: {
  readonly outcome: AskUserQuestionOutcome;
  readonly questions?: unknown;
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}): AskUserQuestionDisplay {
  if (input.outcome !== "answered") return { outcome: input.outcome, entries: [] };
  const answers = input.answers ?? {};
  const ordered = questionTexts(input.questions).filter((q) => Object.hasOwn(answers, q));
  for (const question of Object.keys(answers)) {
    if (!ordered.includes(question)) ordered.push(question);
  }
  const entries: AskUserQuestionDisplayEntry[] = [];
  for (const question of ordered) {
    const answer = answers[question];
    if (typeof answer !== "string") continue;
    const annotation = input.annotations?.[question];
    const note = isRecord(annotation) && typeof annotation.notes === "string"
      ? annotation.notes.trim()
      : "";
    entries.push({ question, answer, ...(note.length > 0 ? { note } : {}) });
  }
  return { outcome: "answered", entries };
}

/** Validates an untrusted value (event metadata, a stored row) as a display. */
export function parseAskUserQuestionDisplay(value: unknown): AskUserQuestionDisplay | null {
  if (!isRecord(value)) return null;
  const outcome = value.outcome;
  if (
    outcome !== "answered" && outcome !== "skipped" &&
    outcome !== "chat_about_this" && outcome !== "skip_plan_interview"
  ) {
    return null;
  }
  const entries: AskUserQuestionDisplayEntry[] = [];
  if (Array.isArray(value.entries)) {
    for (const item of value.entries) {
      if (!isRecord(item) || typeof item.question !== "string" || typeof item.answer !== "string") {
        continue;
      }
      entries.push({
        question: item.question,
        answer: item.answer,
        ...(typeof item.note === "string" && item.note.length > 0 ? { note: item.note } : {}),
      });
    }
  }
  return { outcome, entries };
}

/** True when `text` is one of the tool's model-facing result sentences. */
export function isAskUserQuestionModelText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(ANSWERED_PREFIX) || trimmed.startsWith(SKIPPED_PREFIX) ||
    trimmed.startsWith(CHAT_PREFIX) || trimmed.startsWith(SKIP_INTERVIEW_PREFIX) ||
    trimmed.includes(UNANSWERED_TEXT);
}

function splitAnswerSegment(segment: string): { answer: string; note?: string } {
  // `answer" selected preview:\n<preview> user notes: <note>`; both tails optional.
  let body = segment;
  let note: string | undefined;
  const noteAt = body.lastIndexOf('" user notes: ');
  const previewNoteAt = body.lastIndexOf(" user notes: ");
  const previewAt = body.indexOf('" selected preview:\n');
  if (previewAt >= 0) {
    if (previewNoteAt > previewAt) note = body.slice(previewNoteAt + " user notes: ".length);
    body = body.slice(0, previewAt);
  } else if (noteAt >= 0) {
    note = body.slice(noteAt + '" user notes: '.length);
    body = body.slice(0, noteAt);
  } else if (body.endsWith('"')) {
    body = body.slice(0, -1);
  }
  const trimmedNote = note?.trim();
  return { answer: body, ...(trimmedNote ? { note: trimmedNote } : {}) };
}

/**
 * Recovers the display from the model-facing result text of a session that
 * carries no metadata. `questions` (the call's input) makes the split exact;
 * without it the pairs are found by their `"question"="` markers.
 */
export function askUserQuestionDisplayFromModelText(
  text: string,
  questions?: unknown,
): AskUserQuestionDisplay | null {
  const trimmed = text.trim();
  if (trimmed.startsWith(SKIPPED_PREFIX)) return { outcome: "skipped", entries: [] };
  if (trimmed.startsWith(CHAT_PREFIX)) return { outcome: "chat_about_this", entries: [] };
  if (trimmed.startsWith(SKIP_INTERVIEW_PREFIX)) return { outcome: "skip_plan_interview", entries: [] };
  if (!trimmed.startsWith(ANSWERED_PREFIX)) return null;
  let body = trimmed.slice(ANSWERED_PREFIX.length);
  const suffixAt = body.lastIndexOf(ANSWERED_SUFFIX);
  if (suffixAt >= 0) body = body.slice(0, suffixAt);

  const markers: { question: string; start: number; end: number }[] = [];
  const known = questionTexts(questions);
  let cursor = 0;
  for (const question of known) {
    const marker = `"${question}"="`;
    const at = body.indexOf(marker, cursor);
    if (at < 0) continue;
    markers.push({ question, start: at, end: at + marker.length });
    cursor = at + marker.length;
  }
  if (markers.length === 0) {
    const pattern = /(?:^|, |\n)"([^\n]+?)"="/gu;
    for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
      markers.push({
        question: match[1]!,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  const entries: AskUserQuestionDisplayEntry[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const next = markers[index + 1];
    let segment = body.slice(marker.end, next?.start ?? body.length);
    if (next !== undefined) segment = segment.replace(/(?:, |\n)$/u, "");
    const { answer, note } = splitAnswerSegment(segment);
    entries.push({ question: marker.question, answer, ...(note !== undefined ? { note } : {}) });
  }
  return { outcome: "answered", entries };
}

/** Plain text for surfaces without rich rendering (one line per answer). */
export function formatAskUserQuestionDisplay(display: AskUserQuestionDisplay): string {
  switch (display.outcome) {
    case "skipped":
      return QUESTIONS_SKIPPED_TEXT;
    case "chat_about_this":
      return QUESTIONS_DISCUSS_TEXT;
    case "skip_plan_interview":
      return PLAN_INTERVIEW_SKIPPED_TEXT;
    case "answered": {
      if (display.entries.length === 0) return QUESTIONS_ANSWERED_TEXT;
      const lines: string[] = [];
      for (const entry of display.entries) {
        lines.push(`${entry.question}  ${entry.answer}`);
        if (entry.note !== undefined) lines.push(`  Note: ${entry.note}`);
      }
      return lines.join("\n");
    }
  }
}

/**
 * Resolves what to show for a settled AskUserQuestion call. Returns null only
 * when the result is not one of the tool's own texts (an unrelated error such
 * as a permission denial), which callers render through their normal path.
 */
export function resolveAskUserQuestionDisplay(input: {
  readonly result: unknown;
  readonly metadata?: unknown;
  readonly questions?: unknown;
}): AskUserQuestionDisplay | null {
  const fromMetadata = isRecord(input.metadata)
    ? parseAskUserQuestionDisplay(input.metadata[ASK_USER_QUESTION_DISPLAY_KEY])
    : null;
  if (fromMetadata !== null) return fromMetadata;
  if (typeof input.result !== "string") return null;
  return askUserQuestionDisplayFromModelText(input.result, input.questions);
}

/** User-facing replacement for the tool's "no answers" validation error. */
export function askUserQuestionErrorDisplay(result: unknown): string | null {
  return typeof result === "string" && result.includes(UNANSWERED_TEXT)
    ? QUESTIONS_UNANSWERED_TEXT
    : null;
}
