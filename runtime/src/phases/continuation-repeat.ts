/**
 * Joining a reply the output limit cut with its continuation.
 *
 * When a reply reaches the output limit, Core asks the model to go on and to
 * start by repeating the last words it wrote (`RESUME_META_CONTENT` in
 * recovery/max-output-tokens.ts). The continuation then opens with a copy of
 * the reply's end, and the reply joins where that copy ends. A cut inside a
 * word or between two words reads as one text, with the model's own spacing.
 *
 * What counts as the repeat:
 * - a suffix of the reply so far that the continuation writes at its start,
 *   after at most a short lead of spaces and one ellipsis ("..." or the
 *   ellipsis character; models often open a continuation with one). A line
 *   break or a lone period is no lead: it starts new text;
 * - its words match character for character. A run of spaces or line breaks
 *   matches any other run (a paragraph break repeated as a space), and the
 *   first letter of a repeat of more than one word may differ in case (the
 *   first word of a message, or a sentence repeated after "and");
 * - it starts at a word boundary of the reply, never inside a word; in
 *   scripts written without spaces (Chinese, Japanese, Thai and others) it may
 *   start at any character. It is at most `MAX_REPEAT_CHARS` long there;
 * - it may come in up to `MAX_REPEATS` pieces in a row, each such a suffix
 *   and each at least as long as the one before (models write the last word,
 *   then the five words: "free. The second law ... for free."). Together the
 *   pieces hold at least `MIN_REPEAT_WORD_CHARS` letters or digits, so a short
 *   accidental match ("e", ".", a doubled "had") never counts.
 *
 * Spacing at the join: when the reply ends with spaces or line breaks, the
 * repeat matches up to them, and the continuation's own spacing right after
 * the repeat adds only what the reply's spacing lacks ("\n" then "\n\n" gives
 * a paragraph break; a space after "\n\n" adds nothing).
 *
 * Without a repeat the continuation is kept as written. Nothing is ever added,
 * and nothing inside a word is dropped by guess.
 *
 * While streaming, the continuation's first characters are held until the
 * repeat is resolved (`ContinuationRepeatHold`): the repeated words never
 * stream, and the committed reply is what the hold let through. The hold
 * decides early only when no longer repeat can still complete, so for any
 * chunking it lets through what `joinedContinuation` returns for the whole
 * text.
 *
 * @module
 */

/** A repeat counts only with at least this many letters or digits, all its pieces together. */
export const MIN_REPEAT_WORD_CHARS = 5;
/** The longest repeat recognized, in characters of the reply. */
export const MAX_REPEAT_CHARS = 1_000;
/** The longest lead (spaces and one ellipsis) allowed before a repeat. */
export const MAX_LEAD_CHARS = 8;
/** The longest run of spaces or line breaks the continuation may write for one in the reply. */
export const MAX_SPACE_RUN_CHARS = 16;
/** How many pieces a repeat may come in. */
export const MAX_REPEATS = 3;

/** Spaces or tabs, at most one ellipsis, spaces or tabs. */
const LEAD = /^[ \t]*(?:…|\.{2,})?[ \t]*/u;
/** Text that can still grow into a longer lead. */
const OPEN_LEAD = /^[ \t]*(?:…|\.*)[ \t]*$/u;
const SPACE_CHAR = /^\s$/u;
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
/** Scripts written without spaces between words. */
const UNSPACED_CHAR =
  /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Tibetan}]$/u;

interface RepeatCandidate {
  /** Where the repeated text starts in the reply; it ends where the reply's text ends. */
  readonly start: number;
  /** Its length in the reply. */
  readonly length: number;
  /** More than one word: its first letter may differ in case. */
  readonly words: boolean;
}

interface RepeatResolution {
  /** Characters of the held text the repeat takes: its lead and the repeat. */
  readonly drop: number;
  /** The repeat's length in the reply. */
  readonly length: number;
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && SPACE_CHAR.test(char);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

function isUnspaced(char: string | undefined): boolean {
  return char !== undefined && UNSPACED_CHAR.test(char);
}

function letterCount(text: string, from: number): number {
  let count = 0;
  for (let index = from; index < text.length; index += 1) {
    if (LETTER_OR_DIGIT.test(text[index]!)) count += 1;
  }
  return count;
}

/** A position between two characters of one word (not in a script without spaces). */
function insideWord(text: string, at: number): boolean {
  const before = text[at - 1];
  const after = text[at];
  return isWordChar(before) && isWordChar(after) && !isUnspaced(before) && !isUnspaced(after);
}

/** Every suffix of the reply's text that may be repeated, the longest first. */
function repeatCandidates(previous: string, end: number): RepeatCandidate[] {
  const candidates: RepeatCandidate[] = [];
  let letters = 0;
  let words = false;
  for (let start = end - 1; start >= 0 && end - start <= MAX_REPEAT_CHARS; start -= 1) {
    if (LETTER_OR_DIGIT.test(previous[start]!)) letters += 1;
    if (isSpace(previous[start])) words = true;
    if (letters === 0 || isSpace(previous[start]) || insideWord(previous, start)) continue;
    candidates.push({ start, length: end - start, words });
  }
  return candidates.reverse();
}

/** One way the held text can repeat the reply: a candidate after `skip` lead characters. */
interface RepeatMatch {
  readonly candidate: RepeatCandidate;
  readonly skip: number;
  /** The next character of the reply to match. */
  at: number;
  /** The next character of the held text to match. */
  next: number;
  /** Where the run of spaces the continuation is still writing began, if it is in one. */
  spaceRun: number | undefined;
}

type MatchState = "mismatch" | "open" | "complete";

/** Matches what has arrived since the last call. */
function advance(match: RepeatMatch, previous: string, end: number, held: string): MatchState {
  if (match.spaceRun !== undefined) {
    while (match.next < held.length && isSpace(held[match.next])) match.next += 1;
    if (match.next - match.spaceRun > MAX_SPACE_RUN_CHARS) return "mismatch";
    if (match.next === held.length) return "open";
    match.spaceRun = undefined;
  }
  while (match.at < end) {
    if (match.next >= held.length) return "open";
    const original = previous[match.at]!;
    const written = held[match.next]!;
    if (isSpace(original)) {
      // A run of spaces or line breaks matches any other run.
      if (!isSpace(written)) return "mismatch";
      while (match.at < end && isSpace(previous[match.at])) match.at += 1;
      const runStart = match.next;
      while (match.next < held.length && isSpace(held[match.next])) match.next += 1;
      if (match.next - runStart > MAX_SPACE_RUN_CHARS) return "mismatch";
      if (match.next === held.length) {
        match.spaceRun = runStart;
        return "open";
      }
      continue;
    }
    if (written !== original && !(match.candidate.words && match.at === match.candidate.start &&
      written.toLowerCase() === original.toLowerCase())) {
      return "mismatch";
    }
    match.at += 1;
    match.next += 1;
  }
  return "complete";
}

/**
 * Holds the start of a streamed continuation until its repeat of the reply's
 * end is resolved, then lets the rest through. Feed it the continuation's
 * visible text in order; what it returns is what may stream.
 *
 * The repeat is the first match, in candidate order (the longest first), that
 * still holds. While that match is incomplete the text is held: a longer
 * repeat can still complete. Each arriving character is checked once per
 * match still alive, so the work stays bounded.
 */
export class ContinuationRepeatHold {
  private readonly previous: string;
  /** Where the reply's text ends: before its trailing spaces or line breaks. */
  private readonly textEnd: number;
  /** The reply's trailing spaces or line breaks. */
  private readonly trailing: string;
  private readonly candidates: readonly RepeatCandidate[];
  private held = "";
  private matches: RepeatMatch[] | undefined;
  /** The pieces of the repeat found so far, with their leads, and their letters and digits. */
  private pieces = "";
  private pieceLetters = 0;
  private lastPieceLength = 0;
  private repeats = 0;
  /** How much of the reply's trailing spacing the continuation's spacing has repeated. */
  private spacingMatched = 0;
  private stage: "repeat" | "spacing" | "trim" | "pass" = "repeat";
  private consumedText = "";
  private releasedText = "";

  constructor(previous: string) {
    this.previous = previous;
    this.textEnd = previous.trimEnd().length;
    this.trailing = previous.slice(this.textEnd);
    this.candidates = repeatCandidates(previous, this.textEnd);
  }

  /** Everything pushed so far. */
  get consumed(): string {
    return this.consumedText;
  }

  /** Everything let through so far. */
  get released(): string {
    return this.releasedText;
  }

  /** The next streamed text. Returns the text that may stream now. */
  push(text: string): string {
    this.consumedText += text;
    this.held += text;
    return this.release(this.drain(false));
  }

  /** Nothing more comes before what is held must show (the end, a tool call). */
  flush(): string {
    return this.release(this.drain(true));
  }

  private release(text: string): string {
    this.releasedText += text;
    return text;
  }

  private drain(final: boolean): string {
    let out = "";
    for (;;) {
      if (this.stage === "pass") {
        out += this.held;
        this.held = "";
        return out;
      }
      if (this.stage === "trim") {
        // The continuation's spacing differs from the reply's: it goes.
        let index = 0;
        while (index < this.held.length && isSpace(this.held[index])) index += 1;
        this.held = this.held.slice(index);
        if (this.held.length === 0) return out;
        this.stage = "pass";
        continue;
      }
      if (this.stage === "spacing") {
        // The reply's own spacing already separates the words: the
        // continuation's spacing after the repeat adds only what it lacks.
        let index = 0;
        while (index < this.held.length && this.spacingMatched < this.trailing.length &&
          this.held[index] === this.trailing[this.spacingMatched]) {
          index += 1;
          this.spacingMatched += 1;
        }
        this.held = this.held.slice(index);
        if (this.spacingMatched === this.trailing.length) {
          this.stage = "pass";
        } else if (this.held.length > 0) {
          this.stage = isSpace(this.held[0]) ? "trim" : "pass";
        } else {
          if (!final) return out;
          this.stage = "pass";
        }
        continue;
      }
      const resolution = this.resolve(final);
      if (resolution === undefined) return out;
      this.matches = undefined;
      if (resolution.drop > 0) {
        const piece = this.held.slice(0, resolution.drop);
        this.pieces += piece;
        this.pieceLetters += letterCount(piece, 0);
        this.lastPieceLength = resolution.length;
        this.held = this.held.slice(resolution.drop);
        this.repeats += 1;
        // Another, at least as long, may follow this one.
        if (this.repeats < MAX_REPEATS) continue;
      }
      if (this.repeats > 0 && this.pieceLetters < MIN_REPEAT_WORD_CHARS) {
        // Too short to be a repeat: the continuation is kept as written.
        this.held = this.pieces + this.held;
        this.repeats = 0;
      }
      this.pieces = "";
      this.stage = this.repeats > 0 && this.trailing.length > 0 ? "spacing" : "pass";
    }
  }

  /** Where a repeat ends in what is held; undefined while it may still grow. */
  private resolve(final: boolean): RepeatResolution | undefined {
    const held = this.held;
    if (this.matches === undefined) {
      // Spacing or dots that can still grow into a lead: a repeat may not have started yet.
      if (!final && held.length < MAX_LEAD_CHARS && OPEN_LEAD.test(held)) return undefined;
      const lead = Math.min(MAX_LEAD_CHARS, LEAD.exec(held)?.[0].length ?? 0);
      this.matches = [];
      for (const candidate of this.candidates) {
        if (candidate.length < this.lastPieceLength) continue;
        for (let skip = 0; skip <= lead; skip += 1) {
          this.matches.push({ candidate, skip, at: candidate.start, next: skip, spaceRun: undefined });
        }
      }
    }
    const states = new Map<RepeatMatch, MatchState>();
    this.matches = this.matches.filter((match) => {
      const state = advance(match, this.previous, this.textEnd, held);
      states.set(match, state);
      return state !== "mismatch";
    });
    let partial: RepeatMatch | undefined;
    const letters = new Map<number, number>();
    for (const match of this.matches) {
      if (states.get(match) === "complete") return { drop: match.next, length: match.candidate.length };
      // A longer repeat can still complete: keep holding.
      if (!final) return undefined;
      if (partial === undefined) {
        const count = letters.get(match.skip) ?? letterCount(held, match.skip);
        letters.set(match.skip, count);
        if (count >= MIN_REPEAT_WORD_CHARS) partial = match;
      }
    }
    // A continuation that stops inside its repeat adds nothing to the reply.
    if (partial !== undefined) return { drop: held.length, length: partial.candidate.length };
    return { drop: 0, length: 0 };
  }
}

/**
 * The continuation as it joins the reply so far: without the words it
 * repeated from the reply's end. Equal to what `ContinuationRepeatHold` lets
 * through for the same text.
 */
export function joinedContinuation(previous: string, continuation: string): string {
  const hold = new ContinuationRepeatHold(previous);
  return hold.push(continuation) + hold.flush();
}
