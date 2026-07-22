import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeRoot = join(__dirname, "..", "..");

describe("bootstrap/node-env", () => {
  const original = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  it("defaults NODE_ENV to production when unset", async () => {
    delete process.env.NODE_ENV;
    await import("../../src/bootstrap/node-env.js");
    expect(process.env.NODE_ENV).toBe("production");
  });

  it("never overrides an explicitly set NODE_ENV", async () => {
    process.env.NODE_ENV = "test";
    await import("../../src/bootstrap/node-env.js");
    expect(process.env.NODE_ENV).toBe("test");
  });
});

describe("process entries are order-proof NODE_ENV wrappers", () => {
  // react-reconciler is external (React singleton constraint) and picks its
  // dev/prod build from process.env.NODE_ENV at require time — and esbuild
  // code splitting does NOT preserve source import order across chunks, so a
  // static bootstrap import can lose the race against a shared chunk that
  // reaches the reconciler. Production installs then run the DEVELOPMENT
  // reconciler, whose scheduling profiler leaks PerformanceMeasure entries
  // until the TUI dies at the V8 heap limit (the 0.8.2 swarm-session OOM).
  //
  // The only order-proof shape is a wrapper entry with ZERO static imports:
  // assign NODE_ENV, then dynamically import the implementation graph.
  const wrapperEntries: ReadonlyArray<readonly [string, string]> = [
    ["src/bin/agenc.ts", "./agenc-main.js"],
    ["src/sandbox/linux-launcher/main.ts", "./main-impl.js"],
  ];

  it.each(wrapperEntries)("%s has no static imports and assigns before importing", (entry, impl) => {
    const source = readFileSync(join(runtimeRoot, entry), "utf8");
    expect(source, `${entry} must not contain static imports`).not.toMatch(
      /^(?:import |export .* from )/m,
    );
    const assign = source.indexOf('process.env.NODE_ENV ??= "production";');
    const dynImport = source.indexOf(`await import("${impl}");`);
    expect(assign, `${entry} missing NODE_ENV assignment`).toBeGreaterThanOrEqual(0);
    expect(dynImport, `${entry} missing dynamic import of ${impl}`).toBeGreaterThan(assign);
  });

  // Non-process entries (library barrel, in-process dynamic-import targets)
  // keep a best-effort static bootstrap import: it cannot beat esbuild chunk
  // ordering, but it covers source-run paths (tsx/vitest) and direct imports.
  const staticEntries: ReadonlyArray<readonly [string, string]> = [
    ["src/index.ts", "./bootstrap/node-env.js"],
    ["src/bin/tui-trust-prompt.tsx", "../bootstrap/node-env.js"],
    ["src/tui/main.tsx", "../bootstrap/node-env.js"],
  ];

  it.each(staticEntries)("%s imports the bootstrap before all other imports", (entry, spec) => {
    const source = readFileSync(join(runtimeRoot, entry), "utf8");
    const firstImportOrExport = source.match(/^(?:import |export \{|export \*)/m);
    expect(firstImportOrExport, `${entry} has no imports`).not.toBeNull();
    const firstLine = source
      .slice(firstImportOrExport!.index!)
      .split("\n", 1)[0];
    expect(firstLine).toBe(`import "${spec}";`);
  });
});
