import { expect, it, vi } from "vitest";

const load = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/lazy-runtime-packages.js", () => ({ loadDiff: load }));

it("keeps diff out of metadata inspection and propagates a mutation diff load failure", async () => {
  const metadata = await import("../../src/tools/result-metadata.js");
  expect(metadata.recoverableFailureKind({ recoverable: true, kind: "input_validation" })).toBe(null);
  expect(load).not.toHaveBeenCalled();
  const failure = new Error("diff unavailable");
  load.mockImplementation(() => { throw failure; });
  expect(() => metadata.buildFileMutationMetadata({
    filePath: "a", operation: "edit", beforeText: "a", afterText: "b",
  })).toThrow(failure);
  expect(load).toHaveBeenCalledOnce();
});
