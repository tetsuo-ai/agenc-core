import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { fromAgenCRuntimeMessages, toAgenCRuntimeMessages } from "../../src/session/runtime-message-conversion.js";
import { projectRepeatedReads } from "../../src/tools/read-result-projection.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { toolResultMessage } from "../../src/phases/execute-tools.js";
import { withPersistedToolResultRepresentation } from "../../src/session/tool-result-integrity.js";
import { runWithStartupProviderSelection } from "../../src/utils/model/providers.js";
import { clearSessionReadState } from "../../src/tools/system/filesystem.js";
import { bindExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";

let root: string;
const sessionId = "read-dedup-test";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-dedup-")); });
afterEach(async () => { clearSessionReadState(sessionId, root); await rm(root, { recursive: true, force: true }); });
function enabled<T>(run: () => T, value = "on") {
  return runWithStartupProviderSelection({ provider: "openai", model: "test", environment: { AGENC_READ_DEDUP: value } }, run);
}
async function fixture() {
  const path = join(root, "code.txt");
  await writeFile(path, "alpha\nbeta\ngamma");
  const tool = bindExplicitDangerBoundary(createFileReadTool({ allowedPaths: [root] }));
  const read = async (id: string, args = {}) => {
    const result = await tool.execute({ file_path: path, __agencSessionId: sessionId, ...args });
    return toolResultMessage(sessionId, id, "FileRead", result, "workspace", true);
  };
  return { path, read };
}

test("identical reads reference the first intact visible result and keep full history", () => enabled(async () => {
  const { read } = await fixture();
  const first = await read("read-1", { offset: 2, limit: 1 });
  const second = await read("read-2", { offset: 2, limit: 1 });
  const third = await read("read-3", { offset: 2, limit: 1 });
  const messages = [first, second, third];
  const projected = projectRepeatedReads(fromAgenCRuntimeMessages(toAgenCRuntimeMessages(messages)));
  expect(projected[0]).toEqual(first);
  expect(projected[1]!.content).toBe('[unchanged; same file and range as FileRead call "read-1"]');
  expect(projected[2]!.content).toBe(projected[1]!.content);
  expect(second.content).toContain("beta");
  expect(projectRepeatedReads([second, third])[1]!.content).toContain('"read-2"');
  expect(projectRepeatedReads([third])[0]).toBe(third);
}));
test("changed files, changed ranges and restored bytes with a new timestamp remain full", () => enabled(async () => {
  const { path, read } = await fixture();
  const first = await read("read-1", { limit: 1 });
  const otherRange = await read("range", { offset: 2, limit: 1 });
  await writeFile(path, "changed\nbeta\ngamma");
  const changed = await read("changed", { limit: 1 });
  await writeFile(path, "alpha\nbeta\ngamma");
  await utimes(path, new Date(), new Date(Date.now() + 1000));
  const restored = await read("restored", { limit: 1 });
  const messages = [first, otherRange, changed, restored];
  expect(projectRepeatedReads(messages)).toEqual(messages);
}));
test("missing, shortened and unverified earlier results cannot serve as references", () => enabled(async () => {
  const { read } = await fixture();
  const first = await read("read-1");
  const second = await read("read-2");
  const shortened: LLMMessage = { ...first, content: "shortened", runtimeOnly: { ...first.runtimeOnly,
    toolResultIntegrity: withPersistedToolResultRepresentation(first.runtimeOnly!.toolResultIntegrity!, "compacted", "shortened") } };
  for (const earlier of [shortened, { ...first, content: "unverified" }, { ...first, runtimeOnly: undefined }]) {
    expect(projectRepeatedReads([earlier, second])[1]).toBe(second);
  }
}));
test("a compaction clears earlier references even with a retained read", () => enabled(async () => {
  const { read } = await fixture();
  const first = await read("read-1");
  const second = await read("read-2");
  const boundary = { role: "user", content: "summary", runtimeOnly: { compactionHistory: { version: 1, kind: "summary" } } } as LLMMessage;
  expect(projectRepeatedReads([first, boundary, second])[2]).toBe(second);
}));
test("off, unset and malformed switches preserve the exact request and read bytes", () => enabled(async () => {
  const { read } = await fixture();
  const messages = [await read("read-1"), await read("read-2")];
  runWithStartupProviderSelection({ provider: "openai", model: "test", environment: {} }, () => {
    expect(projectRepeatedReads(messages)).toBe(messages);
  });
  for (const value of ["off", "", "invalid"]) enabled(() => {
    expect(projectRepeatedReads(messages)).toBe(messages);
  }, value);
}));
