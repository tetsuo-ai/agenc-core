import { describe, expect, test } from "vitest";
import {
  ContinuationRepeatHold,
  joinedContinuation,
  MAX_LEAD_CHARS,
  MAX_REPEAT_CHARS,
} from "../../src/phases/continuation-repeat.js";

// [reply so far, continuation, the continuation as it joins]
const CASES: ReadonlyArray<readonly [string, string, string]> = [
  // The repeat ends at the cut.
  ["attacks the same", "attacks the same problem.", " problem."],
  ["attacks the same", " the same problem.", " problem."],
  ["the slow thickening of ", "the slow thickening of lubricants", "lubricants"],
  // Inside a word: the word is completed, nothing added.
  ["one tooth of the escap", "of the escapement wheel", "ement wheel"],
  // A lead of dots or spaces before the repeat goes with it.
  ["against its spring.", "...against its spring. That", " That"],
  ["against its spring.", "…against its spring.\n\nThat", "\n\nThat"],
  ["against its spring.", " \u2026 against its spring. That", " That"],
  // A line break starts new text, never a lead: kept as written.
  ["against its spring.", "\n against its spring. That", "\n against its spring. That"],
  // Only the first letter may differ in case, and only in a repeat of more
  // than one word (live: "and", then the last sentence with "Rays" lowercased).
  ["and the slow thickening", "And the slow thickening goes on", " goes on"],
  ["lens. Rays from a distant point arrive nearly parallel and",
    "and rays from a distant point arrive nearly parallel and are brought to a focus", " are brought to a focus"],
  ["and the slow thickening", "and The slow thickening goes on", "and The slow thickening goes on"],
  // The repeat stops before the reply's trailing spacing; the continuation's
  // spacing after it adds only what the reply's lacks.
  ["rate as well.\n\n", "rate as well. Finally", "Finally"],
  ["rate as well.\n\n", "rate as well.\n\nFinally", "Finally"],
  ["rate as well.\n\n", "rate as well.\nFinally", "Finally"],
  ["rate as well.\n", "rate as well.\n\nFinally", "\nFinally"],
  // Any run of spaces or line breaks matches another (live: a paragraph
  // break repeated as a space), up to a limit.
  ["shakes uselessly.\n\nSo the answer comes", "uselessly. So the answer comes down to it", " down to it"],
  ["the gear train turns", `the gear${" ".repeat(20)}train turns on`, `the gear${" ".repeat(20)}train turns on`],
  // A repeat in pieces goes whole (live: "so that", then the five words; the
  // last word, then the last sentence). A short piece alone is no repeat.
  ["and the boiler is arranged so that", "so that the boiler is arranged so that the gas", " the gas"],
  ["The second law says you can never do it for free.", "free. The second law says you can never do it for free. So", " So"],
  ["it is the same", "same, the same", "same, the same"],
  // No repeat: kept as written.
  ["on to the", "escape wheel", "escape wheel"],
  ["its spring.", "...That division", "...That division"],
  ["the watchmaker had", " had enough", " had enough"],
  ["in the hairspring", "spring, which", "spring, which"],
  ["a cut", "a cut", "a cut"],
  ["rate as well.", "rate as well, and", "rate as well, and"],
  ["", "Anything at all", "Anything at all"],
  ["A reply", "", ""],
  // The longest repeat wins.
  ["tick tock tick tock", "tick tock tick tock goes", " goes"],
  // A complete repeat wins over a longer one the continuation only began.
  ["red green blue red green blue", "red green blue red", " red"],
  // A long repeated pattern: the longest repeat that completes.
  [("ab ".repeat(400)).trim(), "ab ab ab ab end", " end"],
  // Scripts written without spaces: a repeat may start at any character.
  ["首先我们需要仔细检查服务器上的配置文件和系统日志", "配置文件和系统日志，然后重启服务。", "，然后重启服务。"],
  ["まずサーバーのシステムログとエラー情報を", "ログとエラー情報を確認します。", "確認します。"],
  ["ก่อนอื่นให้ตรวจสอบบันทึกของระบบ", "บันทึกของระบบก่อน", "ก่อน"],
  ["配置文件的", "的问题很多。", "的问题很多。"],
  // New text after a repeat stays: a lone period or a line break is no lead,
  // a later piece is never shorter than the one before, and only the
  // continuation's first letter may differ in case.
  ["so the answer is no", "so the answer is no. No, really.", ". No, really."],
  ["so the answer is no", "so the answer is no no matter what", " no matter what"],
  ["import sys\nimport json", "import sys\nimport json\njson.dump(data, sys.stdout)", "\njson.dump(data, sys.stdout)"],
  ["we cache it in Redis", "we cache it in Redis. Redis keeps it", ". Redis keeps it"],
  ["Then configure the server", ".\n\nServer settings live in one file.", ".\n\nServer settings live in one file."],
  ["The run is done.\n\n## Results", "\n\nResults show a 3x speedup.", "\n\nResults show a 3x speedup."],
  ["Then configure the server", " Server settings live", " Server settings live"],
  ["attacks the same", "attacks the same attacks the same problem", " problem"],
  // A continuation that stops inside its repeat adds nothing.
  ["the balance wheel swings", "the balance whe", ""],
  ["the balance wheel swings", "the b", "the b"],
];

function streamInChunks(previous: string, continuation: string, sizes: readonly number[]): {
  readonly streamed: string;
  readonly maxHeld: number;
} {
  const hold = new ContinuationRepeatHold(previous);
  let streamed = "";
  let received = 0;
  let maxHeld = 0;
  let index = 0;
  for (let at = 0; at < continuation.length;) {
    const size = sizes[index % sizes.length]!;
    index += 1;
    streamed += hold.push(continuation.slice(at, at + size));
    at += size;
    received = Math.min(at, continuation.length);
    maxHeld = Math.max(maxHeld, received - streamed.length);
  }
  streamed += hold.flush();
  return { streamed, maxHeld };
}

describe("joining a continuation where its repeat ends", () => {
  test.each(CASES)("%j + %j", (previous, continuation, joined) => {
    expect(joinedContinuation(previous, continuation)).toBe(joined);
  });

  test("any chunking streams exactly the joined text", () => {
    for (const [previous, continuation, joined] of CASES) {
      for (const sizes of [[1], [2], [3], [5], [8], [13], [1, 4, 2], [7, 1, 1, 9]]) {
        expect(streamInChunks(previous, continuation, sizes).streamed).toBe(joined);
      }
    }
  });

  test("the hold lets text through as soon as no repeat can complete", () => {
    const hold = new ContinuationRepeatHold("the balance wheel swings back and forth");
    expect(hold.push("swings")).toBe("");
    expect(hold.push(" back and forth")).toBe("");
    // The repeat is complete and no longer one can still match.
    expect(hold.push(" five")).toBe(" five");
    expect(hold.push(" times")).toBe(" times");
    expect(hold.flush()).toBe("");

    const plain = new ContinuationRepeatHold("the balance wheel swings back and forth");
    expect(plain.push("Then")).toBe("Then");
  });

  test("spacing after a repeat streams as it arrives once it covers the reply's own", () => {
    const hold = new ContinuationRepeatHold("keeps the rate as well.\n");
    expect(hold.push("keeps the rate as well.")).toBe("");
    // The reply's line break is there already.
    expect(hold.push("\n")).toBe("");
    for (let index = 0; index < 5_000; index += 1) expect(hold.push("\n")).toBe("\n");
    expect(hold.push("Done")).toBe("Done");
    expect(hold.flush()).toBe("");
    expect(hold.released).toBe("\n".repeat(5_000) + "Done");

    const other = new ContinuationRepeatHold("keeps the rate as well.\n\n");
    expect(other.push("keeps the rate as well. ")).toBe("");
    for (let index = 0; index < 5_000; index += 1) expect(other.push(" ")).toBe("");
    expect(other.push("Done")).toBe("Done");
  });

  test("a repeat longer than the hold so far keeps it growing, never past the limit", () => {
    const repeated = "the balance wheel it drives swings at a natural period that sets the rate of the whole watch ".repeat(4).trim();
    const previous = "Two parts decide how well a watch keeps time: " + repeated;
    const { streamed, maxHeld } = streamInChunks(previous, repeated + ", from the start.", [3]);
    expect(streamed).toBe(", from the start.");
    expect(maxHeld).toBeGreaterThanOrEqual(repeated.length);
    expect(maxHeld).toBeLessThanOrEqual(MAX_REPEAT_CHARS + MAX_LEAD_CHARS + 3);

    const long = Array.from({ length: 120 }, (_, index) => `Part ${index} of ${index * 7}.`).join(" ");
    const beyond = long.slice(long.length - MAX_REPEAT_CHARS - 50) + " More.";
    const limited = streamInChunks(long, beyond, [11]);
    expect(limited.streamed).toBe(beyond);
    expect(limited.maxHeld).toBeLessThanOrEqual(MAX_REPEAT_CHARS + MAX_LEAD_CHARS + 11);
  });
});
