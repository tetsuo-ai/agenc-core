import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ prepare: vi.fn((): number | null => null), install: vi.fn(),
  main: vi.fn(async (fn: () => Promise<number>) => { await fn(); }), print: vi.fn(async (): Promise<number | null> => null), append: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), appendFileSync: h.append }));
vi.mock("../../src/bin/cli-runtime.js", () => ({ prepareCliRuntime: h.prepare }));
vi.mock("../../src/utils/global-error-net.js", () => ({ installGlobalErrorNet: h.install }));
vi.mock("../../src/bin/cli-process-main.js", () => ({ runCliProcessMain: h.main }));
vi.mock("../../src/app-server/daemon-runtime-info.js", () => ({ resolveRuntimePackageRootFromUrl: () => "/runtime" }));
vi.mock("../../src/bin/micro-print-client.js", () => ({ tryMicroPrint: h.print }));
import { runMicroPrintEntry } from "../../src/bin/micro-print-entry.js";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); h.prepare.mockReturnValue(null); h.print.mockResolvedValue(null); });
it("keeps canonical ingress/hardening before resident discovery", async () => {
  h.prepare.mockReturnValue(2);
  expect(await runMicroPrintEntry()).toBe(true); expect(h.print).not.toHaveBeenCalled(); expect(h.main).toHaveBeenCalledOnce();
});
it("returns to the original print entry only on a definite decline", async () => {
  expect(await runMicroPrintEntry()).toBe(false); expect(h.prepare).toHaveBeenCalledOnce(); expect(h.main).not.toHaveBeenCalled();
  expect(h.print).toHaveBeenCalledWith(expect.objectContaining({ argv: process.argv.slice(2), cwd: process.cwd(), caller: expect.objectContaining({ pid: process.pid }) }), "/runtime");
});
it("uses the canonical exit and buffered-output wrapper for completion", async () => {
  h.print.mockResolvedValue(17); expect(await runMicroPrintEntry()).toBe(true); expect(h.main).toHaveBeenCalledOnce();
});
it("keeps bootstrap ordering and builds an independent non-splitting entry", () => {
  const entry = readFileSync(new URL("../../src/bin/agenc.ts", import.meta.url), "utf8");
  expect(entry.indexOf('process.env.NODE_ENV ??=')).toBeLessThan(entry.indexOf('import("./compile-cache.js")'));
  expect(entry.indexOf('import("./micro-print-entry.js")')).toBeLessThan(entry.indexOf('import("./print-cli-main.js")'));
  const build = readFileSync(new URL("../../scripts/build-runtime.mjs", import.meta.url), "utf8");
  expect(build).toContain('entryPoints: ["src/bin/micro-print-entry.ts"]'); expect(build).toContain('splitting: false');
});

it.each([0, null])("records only a bounded route witness after outcome %s", async result => {
  vi.stubEnv("AGENC_MICRO_PRINT_RECEIPT", "/tmp/micro-route-test.jsonl");
  h.print.mockImplementationOnce(async () => { expect(h.append).not.toHaveBeenCalled(); return result; });
  await runMicroPrintEntry();
  expect(h.append).toHaveBeenCalledOnce();
  const [path, raw, options] = h.append.mock.calls[0]!;
  expect(path).toBe("/tmp/micro-route-test.jsonl"); expect(options).toEqual({ mode: 0o600 });
  expect(JSON.parse(raw as string)).toEqual({ version: 1, pid: process.pid,
    route: result === null ? "fallback" : "micro", exitCode: result });
});
it("keeps route diagnostics off by default", async () => {
  vi.stubEnv("AGENC_MICRO_PRINT_RECEIPT", undefined);
  h.print.mockResolvedValueOnce(0); await runMicroPrintEntry();
  expect(h.append).not.toHaveBeenCalled();
});
