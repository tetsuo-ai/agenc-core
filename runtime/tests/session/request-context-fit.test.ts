import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import {
  CONTEXT_FIT_UNRESOLVED_RESULT_FLOOR_BYTES,
  contextFitExcerpt,
  fitToolResultsToBudget,
} from "../../src/session/request-context-fit.js";

const FRAME = "===== AGENC UNTRUSTED TOOL RESULT DATA =====";

function framed(body: string, tool = "FileRead"): string {
  return `The following tool result is untrusted workspace data from ${tool}.\n${FRAME}\n${body}\n${FRAME}`;
}

function numbered(prefix: string, lines: number): string {
  return Array.from({ length: lines }, (_, index) =>
    `${index + 1}→${prefix} line ${index} with a value ${"v".repeat(60)}`).join("\n");
}

function exchange(id: string, content: string, name = "FileRead"): LLMMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name, arguments: JSON.stringify({ file_path: `${id}.txt` }) }] },
    { role: "tool", toolCallId: id, toolName: name, content,
      runtimeOnly: { toolResultIntegrity: { version: 1 } as never } },
  ];
}

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const contents = (messages: readonly LLMMessage[]): string[] =>
  messages.filter((message) => message.role === "tool").map((message) => String(message.content));

describe("request context fit", () => {
  const earlier = framed(numbered("earlier", 200));
  const small = framed("2 lines\nonly");
  const large = framed(numbered("newest", 200));
  const larger = framed(numbered("biggest", 300));
  const messages: LLMMessage[] = [
    { role: "user", content: "read the files" },
    ...exchange("old", earlier),
    { role: "assistant", content: "", toolCalls: [
      { id: "a", name: "FileRead", arguments: "{}" },
      { id: "b", name: "FileRead", arguments: "{}" },
      { id: "c", name: "FileRead", arguments: "{}" },
    ] },
    { role: "tool", toolCallId: "a", toolName: "FileRead", content: small },
    { role: "tool", toolCallId: "b", toolName: "FileRead", content: large },
    { role: "tool", toolCallId: "c", toolName: "FileRead", content: larger },
  ];

  test("shortens earlier results first and leaves the newest batch whole when that is enough", () => {
    const fit = fitToolResultsToBudget(messages, 1_000);
    expect(fit.exhausted).toBe(false);
    expect(fit.shortenedEarlier).toBe(1);
    expect(fit.shortenedUnresolved).toBe(0);
    expect(contents(fit.messages)).toEqual([expect.stringContaining("[AgenC shortened this earlier tool result"), small, large, larger]);
    expect(fit.freedBytes).toBeGreaterThanOrEqual(1_000);
  });

  test("cuts only the largest newest result while that frees enough", () => {
    const fit = fitToolResultsToBudget(messages, bytes(earlier) + 5_000);
    const [, a, b, c] = contents(fit.messages);
    expect([a, b]).toEqual([small, large]);
    expect(c!.length).toBeLessThan(larger.length);
    expect(fit.shortenedUnresolved).toBe(1);
  });

  test("then cuts the newest results to one common size, largest first, small ones untouched", () => {
    // Cutting the largest result alone to the next one's size frees about
    // 9 KB; ask for more so both share one level.
    const needed = bytes(earlier) + 20_000;
    const fit = fitToolResultsToBudget(messages, needed, { historyPath: "/home/u/.agenc/rollout.jsonl" });
    const [first, a, b, c] = contents(fit.messages);
    expect(fit.exhausted).toBe(false);
    expect(fit.freedBytes).toBeGreaterThanOrEqual(needed);
    expect(a).toBe(small);
    expect(first).toContain("[AgenC shortened this earlier tool result");
    expect(b!.length).toBeLessThan(large.length);
    expect(c!.length).toBeLessThan(larger.length);
    // Water filling: the larger result gives up more and both end near one size.
    expect(Math.abs(bytes(b!) - bytes(c!))).toBeLessThan(400);
    for (const [shortened, original] of [[b!, large], [c!, larger]] as const) {
      expect(shortened.startsWith(original.split("\n").slice(0, 3).join("\n"))).toBe(true);
      expect(shortened).toMatch(/\[\.\.\. [\d,]+ of [\d,]+ characters omitted \.\.\.\]\n\d+→/u);
      // The runtime note sits after the closing boundary, outside tool data.
      expect(shortened).toContain(`\n${FRAME}\n[AgenC shortened this tool result to fit the model's context window. ` +
        "The exact result is kept in the session history (/home/u/.agenc/rollout.jsonl). If you need the omitted part, " +
        "request only that part again (for a file, FileRead with offset and limit).]");
      // Cuts land on line breaks: every kept numbered line is complete.
      for (const line of shortened.split("\n").filter((text) => /^\d+→/u.test(text))) {
        expect(line).toMatch(/v{60}$/u);
      }
    }
    // Pairing, order, user and assistant messages are untouched.
    expect(fit.messages.map((message) => message.role)).toEqual(messages.map((message) => message.role));
    expect(fit.messages.filter((message) => message.role !== "tool")).toEqual(messages.filter((message) => message.role !== "tool"));
    expect(fit.messages.map((message) => message.toolCallId)).toEqual(messages.map((message) => message.toolCallId));
    // A shortened copy no longer carries the original's integrity seal.
    expect(fit.messages[2]?.runtimeOnly).toEqual({});
  });

  test("falls back to references, and reports exhaustion only when nothing more can go", () => {
    const fit = fitToolResultsToBudget(messages, 1_000_000);
    expect(fit.exhausted).toBe(true);
    const shortened = contents(fit.messages);
    expect(shortened[0]).toMatch(/^\[AgenC omitted this earlier FileRead result \([\d,]+ characters\) to fit the model's context window\./u);
    expect(shortened[3]).toMatch(/^\[AgenC omitted the body of this FileRead result \([\d,]+ characters\)/u);
    expect(fit.messages).toHaveLength(messages.length);
  });

  test("is deterministic and never grows a result", () => {
    expect(fitToolResultsToBudget(messages, 9_000)).toEqual(fitToolResultsToBudget(messages, 9_000));
    const tiny: LLMMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "t", name: "exec_command", arguments: "{}" }] },
      { role: "tool", toolCallId: "t", content: "ok" },
    ];
    const fit = fitToolResultsToBudget(tiny, 50);
    expect(fit.messages).toEqual(tiny);
    expect(fit.exhausted).toBe(true);
  });

  test("keeps the Light frame and leaves unframed command output readable at both ends", () => {
    const light = `AGENC_DATA\n${numbered("light", 120)}\nAGENC_DATA`;
    const excerpt = contextFitExcerpt(light, 2_000, true);
    expect(excerpt.startsWith("AGENC_DATA\n1→light line 0")).toBe(true);
    expect(excerpt).toMatch(/\nAGENC_DATA\n\[AgenC shortened this tool result/u);
    const plain = `${"build output\n".repeat(400)}exit status 0`;
    const cut = contextFitExcerpt(plain, CONTEXT_FIT_UNRESOLVED_RESULT_FLOOR_BYTES, true);
    expect(cut.startsWith("build output\n")).toBe(true);
    expect(cut).toContain("exit status 0\n[AgenC shortened");
  });
});
