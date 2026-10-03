import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeModule = vi.hoisted(() => ({
  enableCompileCache: vi.fn(),
  getCompileCacheDir: vi.fn<() => string | undefined>(),
  flushCompileCache: vi.fn(),
  registerHooks: vi.fn(),
}));
const osTemp = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:module", () => ({ default: nodeModule }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => osTemp.dir };
});

const {
  beginProgressiveAgenCCompileCachePublication,
  compileCacheDirectory,
  enableAgenCCompileCache,
  flushAgenCCompileCache,
  preparePrivateDirectory,
  scheduleDaemonCompileCacheFlush,
} = await import("../../src/bin/compile-cache.js");

const posix = process.platform !== "win32";
const realTemp = (await vi.importActual<typeof import("node:os")>("node:os")).tmpdir();
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(realTemp, "agenc-compile-cache-test-"));
  osTemp.dir = scratch;
  nodeModule.enableCompileCache.mockReset();
  nodeModule.getCompileCacheDir.mockReset();
  nodeModule.flushCompileCache.mockReset();
  nodeModule.registerHooks.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(scratch, { recursive: true, force: true });
});

describe("compile cache location", () => {
  it("uses the per-user temp directory, keyed by uid where temp is shared", () => {
    expect(compileCacheDirectory("darwin", 501, "/t")).toBe(join("/t", "agenc-compile-cache-501"));
    expect(compileCacheDirectory("linux", 1000, "/tmp")).toBe(join("/tmp", "agenc-compile-cache-1000"));
    expect(compileCacheDirectory("win32", undefined, "C:\\T")).toBe(join("C:\\T", "agenc-compile-cache"));
    expect(compileCacheDirectory("linux", undefined, "/tmp")).toBeNull();
  });

  it.skipIf(!posix)("creates a private directory and accepts it again", () => {
    const dir = join(scratch, "cache");
    expect(preparePrivateDirectory(dir, process.platform, process.getuid!())).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(preparePrivateDirectory(dir, process.platform, process.getuid!())).toBe(true);
  });

  it.skipIf(!posix)("refuses a link, a directory others can write, and another user's directory", () => {
    const target = join(scratch, "target");
    mkdirSync(target, { mode: 0o700 });
    const link = join(scratch, "link");
    symlinkSync(target, link);
    expect(preparePrivateDirectory(link, process.platform, process.getuid!())).toBe(false);

    const shared = join(scratch, "shared");
    mkdirSync(shared, { mode: 0o700 });
    chmodSync(shared, 0o777);
    expect(preparePrivateDirectory(shared, process.platform, process.getuid!())).toBe(false);

    const mine = join(scratch, "mine");
    expect(preparePrivateDirectory(mine, process.platform, process.getuid!() + 1)).toBe(false);
  });
});

describe("enabling the compile cache", () => {
  it.skipIf(!posix)("enables Node's cache in the private directory", () => {
    nodeModule.getCompileCacheDir.mockReturnValue(undefined);
    nodeModule.enableCompileCache.mockImplementation((directory: string) => ({ status: 0, directory }));
    const directory = enableAgenCCompileCache({});
    expect(directory).toBe(join(scratch, `agenc-compile-cache-${process.getuid!()}`));
    expect(nodeModule.enableCompileCache).toHaveBeenCalledWith(directory);
  });

  it("stays off when AGENC_COMPILE_CACHE=0", () => {
    nodeModule.getCompileCacheDir.mockReturnValue(undefined);
    expect(enableAgenCCompileCache({ AGENC_COMPILE_CACHE: "0" })).toBeNull();
    expect(nodeModule.enableCompileCache).not.toHaveBeenCalled();
  });

  it("leaves a cache Node already enabled from NODE_COMPILE_CACHE alone", () => {
    nodeModule.getCompileCacheDir.mockReturnValue("/operator/cache");
    expect(enableAgenCCompileCache({})).toBe("/operator/cache");
    expect(nodeModule.enableCompileCache).not.toHaveBeenCalled();
  });

  it.skipIf(!posix)("stays off when the directory is not private", () => {
    nodeModule.getCompileCacheDir.mockReturnValue(undefined);
    const dir = join(scratch, `agenc-compile-cache-${process.getuid!()}`);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o777);
    expect(enableAgenCCompileCache({})).toBeNull();
    expect(nodeModule.enableCompileCache).not.toHaveBeenCalled();
  });
});

describe("daemon flush", () => {
  it("publishes only an already enabled cache without selecting a new directory", () => {
    flushAgenCCompileCache();
    expect(nodeModule.flushCompileCache).not.toHaveBeenCalled();
    nodeModule.getCompileCacheDir.mockReturnValue("/operator/cache");
    flushAgenCCompileCache();
    expect(nodeModule.flushCompileCache).toHaveBeenCalledTimes(1);
    expect(nodeModule.enableCompileCache).not.toHaveBeenCalled();
  });

  it("keeps cache inspection and publication failures best effort", () => {
    nodeModule.getCompileCacheDir.mockImplementation(() => { throw new Error("unavailable"); });
    expect(() => flushAgenCCompileCache()).not.toThrow();
    nodeModule.getCompileCacheDir.mockReturnValue("/cache");
    nodeModule.flushCompileCache.mockImplementation(() => { throw new Error("disk full"); });
    expect(() => flushAgenCCompileCache()).not.toThrow();
  });

  it("supports Node versions without cache publication APIs", () => {
    const original = nodeModule.flushCompileCache;
    try {
      Reflect.deleteProperty(nodeModule, "flushCompileCache");
      expect(() => flushAgenCCompileCache()).not.toThrow();
      expect(nodeModule.getCompileCacheDir).not.toHaveBeenCalled();
    } finally {
      nodeModule.flushCompileCache = original;
    }
  });

  it("saves the cache 5 s and 60 s after start, only when it is on", () => {
    vi.useFakeTimers();
    nodeModule.getCompileCacheDir.mockReturnValue(undefined);
    scheduleDaemonCompileCacheFlush();
    vi.advanceTimersByTime(120_000);
    expect(nodeModule.flushCompileCache).not.toHaveBeenCalled();

    nodeModule.getCompileCacheDir.mockReturnValue("/cache");
    scheduleDaemonCompileCacheFlush();
    vi.advanceTimersByTime(4_999);
    expect(nodeModule.flushCompileCache).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(nodeModule.flushCompileCache).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(55_000);
    expect(nodeModule.flushCompileCache).toHaveBeenCalledTimes(2);
  });
});

describe("process entry", () => {
  it("enables the cache after NODE_ENV and before the implementation graph", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "bin", "agenc.ts"), "utf8");
    const assign = source.indexOf('process.env.NODE_ENV ??= "production";');
    const cache = source.indexOf('await import("./compile-cache.js").then((cache) => cache.enableAgenCCompileCache());');
    const main = source.indexOf('await import("./agenc-main.js");');
    expect(assign).toBeGreaterThanOrEqual(0);
    expect(cache).toBeGreaterThan(assign);
    expect(main).toBeGreaterThan(cache);
  });
});

describe("progressive publication", () => {
  it("leaves module sources and loader errors unchanged and cleans up", () => {
    nodeModule.getCompileCacheDir.mockReturnValue("/private/cache");
    const deregister = vi.fn();
    nodeModule.registerHooks.mockReturnValue({ deregister });
    const stop = beginProgressiveAgenCCompileCachePublication();
    const { load } = nodeModule.registerHooks.mock.calls[0]![0];
    const context = { format: "module" };
    const original = { format: "module", source: "export const content = 7;" };
    const next = vi.fn(() => original);
    // Cache I/O failure must never replace a successful source load.
    nodeModule.flushCompileCache.mockImplementation(() => { throw new Error("disk full"); });
    for (let i = 0; i < 32; ++i) expect(load("file:///same.js", context, next)).toBe(original);
    expect(next).toHaveBeenLastCalledWith("file:///same.js", context);
    expect(nodeModule.flushCompileCache).toHaveBeenCalled();
    const error = new Error("canonical load failure");
    expect(() => load("file:///missing.js", context, () => { throw error; })).toThrow(error);
    stop();
    expect(deregister).toHaveBeenCalledOnce();
    expect(nodeModule.enableCompileCache).not.toHaveBeenCalled();
  });

  it("keeps missing cache and failed cache inspection inert", () => {
    beginProgressiveAgenCCompileCachePublication()();
    expect(nodeModule.registerHooks).not.toHaveBeenCalled();
    nodeModule.getCompileCacheDir.mockImplementation(() => { throw new Error("unavailable"); });
    expect(() => beginProgressiveAgenCCompileCachePublication()()).not.toThrow();
    expect(nodeModule.registerHooks).not.toHaveBeenCalled();
  });
});
