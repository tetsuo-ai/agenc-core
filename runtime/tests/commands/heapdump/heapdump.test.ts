import { afterEach, describe, expect, it, vi } from "vitest";

// /heapdump uses performHeapDump, which writes V8 heap snapshot files
// to disk. Mock it so the test asserts on result-shape transformations
// without touching the filesystem.
vi.mock("../../utils/heapDumpService.js", () => ({
  performHeapDump: vi.fn(),
}));
const { performHeapDump } = await import("../../utils/heapDumpService.js");
const { call } = await import("./heapdump.js");

afterEach(() => {
  vi.mocked(performHeapDump).mockReset();
});

describe("heapdump call", () => {
  it("returns paths in the success case", async () => {
    vi.mocked(performHeapDump).mockResolvedValue({
      success: true,
      heapPath: "/home/tester/Desktop/agenc-heap.heapsnapshot",
      diagPath: "/home/tester/Desktop/agenc-heap.diag.json",
    });
    const result = await call();
    expect(result.type).toBe("text");
    expect(result.value).toContain("agenc-heap.heapsnapshot");
    expect(result.value).toContain("agenc-heap.diag.json");
    // Both paths are joined with a newline.
    expect(result.value.split("\n").length).toBe(2);
  });

  it("surfaces the underlying error message on failure", async () => {
    vi.mocked(performHeapDump).mockResolvedValue({
      success: false,
      error: "EACCES: permission denied opening /Desktop",
    });
    const result = await call();
    expect(result.type).toBe("text");
    expect(result.value).toContain("Failed to create heap dump");
    expect(result.value).toContain("EACCES");
  });
});
