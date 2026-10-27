import { describe, expect, test } from "vitest";
import { verifiedLiteralFile } from "../../src/phases/completion-gate-literal.js";
import { completionGate } from "../../src/phases/completion-gate.js";
import { syntheticGate, syntheticResult } from "./completion-gate-synthetic.js";

const task = 'Create note.txt containing exactly "hello". Then read the file back with a tool and reply with only its content.';
const write = syntheticResult("write", { toolName: "FileWrite", arguments: JSON.stringify({file_path: "note.txt", content: "hello"}), content: "written" });
const read = syntheticResult("read", { arguments: JSON.stringify({file_path: "/app/note.txt"}), content: "1→hello" });
const check = (results = [write, read], prompt = task, answer = "hello") => verifiedLiteralFile(prompt, answer, results, "/app");

describe("literal file completion", () => {
  test("accepts a small literal write and an independent complete read", async () => {
    expect(check()).toBe(true);
    const {state, context, session, last} = syntheticGate(task, "hello");
    state.completionGateRound = 0;
    state.completedToolResults = [write, read];
    await completionGate(state, {...context, cwd: "/app"}, session);
    expect(state.transition).toBeUndefined();
    expect(last()).toMatchObject({outcome: "verified", reason: "literal_file_verified"});
    for (const cmd of ["printf 'hello' > note.txt", "printf 'hello' > note.txt && od -An -tx1 note.txt", "printf 'hello' > note.txt && xxd note.txt"]) {
      expect(check([{ ...write, toolName: "exec_command", arguments: JSON.stringify({cmd}), metadata: {exitCode: 0} }, read])).toBe(true);
    }
  });
  test("requires consistent byte counts and literal content for hexadecimal requests", () => {
    const prompt = "Use a tool to create note.txt in the current folder containing exactly five bytes, hexadecimal 68 65 6c 6c 6f (the letters hello), with no punctuation or newline. Then read the file back with a tool and reply with only its content.";
    expect(check([write, read], prompt)).toBe(true);
    expect(check([write, read], prompt.replace("five bytes", "six bytes"))).toBe(false);
    expect(check([write, read], prompt.replace("letters hello", "letters world"))).toBe(false);
  });
  test("does not waive extra requirements, unrelated evidence or claimed success", () => {
    expect(check([write])).toBe(false);
    expect(check([write, read, read])).toBe(false);
    expect(check([read, write])).toBe(false);
    expect(check([write, {...read, content: "1→wrong"}])).toBe(false);
    expect(check([write, {...read, isError: true}])).toBe(false);
    expect(check([write, {...read, arguments: JSON.stringify({file_path: "/other/note.txt"})}])).toBe(false);
    expect(check([write, {...read, arguments: JSON.stringify({file_path: "note.txt", limit: 1})}])).toBe(false);
    expect(check([write, read], task + " Also encrypt it.")).toBe(false);
    expect(check([write, read], task, "Done.")).toBe(false);
    expect(check([{...write, arguments: "invalid"}, read])).toBe(false);
  });
  test.each(["printf 'hello' > note.txt; rm other.txt", "echo hello > note.txt", "printf 'hello' > other.txt", "printf 'hello' > note.txt && chmod +x note.txt"])("unknown shell effects keep the gate: %s", cmd => {
    expect(check([{...write, toolName: "exec_command", arguments: JSON.stringify({cmd}), metadata: {exitCode: 0}}, read])).toBe(false);
  });
  test.each([null, 1, undefined])("unfinished or failed shell writes keep the gate (%s)", exitCode => {
    expect(check([{...write, toolName: "exec_command", arguments: JSON.stringify({cmd: "printf 'hello' > note.txt"}), metadata: {exitCode}}, read])).toBe(false);
  });
});
