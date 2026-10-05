import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeRoot = join(__dirname, "..", "..");

describe("bootstrap/node-env", () => {
  const original = process.env.NODE_ENV;
  const snapshotKey = Symbol.for("agenc.originalRuntimeEnvironment");
  const savedSnapshot = Object.getOwnPropertyDescriptor(globalThis, snapshotKey);

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, snapshotKey);
    vi.resetModules();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, snapshotKey);
    if (savedSnapshot) Object.defineProperty(globalThis, snapshotKey, savedSnapshot);
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

  it.each([undefined, "development", "production", "test", ""])(
    "passes the original NODE_ENV (%s) through both child environment paths",
    async (value) => {
      if (value === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = value;
      await import("../../src/bootstrap/node-env.js");
      const { subprocessEnv } = await import("../../src/utils/subprocessEnv.js");
      const { scrubEnvForChildProcess, buildScrubbedSpawnEnv } = await import("../../src/unified-exec/scrub-env.js");
      const base = { ...process.env };
      expect(process.env.NODE_ENV).toBe(value ?? "production");
      for (const child of [
        subprocessEnv(base),
        subprocessEnv({ ...base, AGENC_SUBPROCESS_ENV_NO_SCRUB: "1" }),
        scrubEnvForChildProcess(base),
        buildScrubbedSpawnEnv(undefined, base),
      ]) {
        expect(child.NODE_ENV).toBe(value);
        expect(Object.hasOwn(child, "NODE_ENV")).toBe(value !== undefined);
      }
      expect(base.NODE_ENV).toBe(value ?? "production");
      expect(buildScrubbedSpawnEnv({ NODE_ENV: "production" }, base).NODE_ENV).toBe("production");
      expect(subprocessEnv({ NODE_ENV: "development" }).NODE_ENV).toBe("development");
      expect(subprocessEnv({})).not.toHaveProperty("NODE_ENV");
    },
  );

  it.each(["AGENC_ONBOARDING", "AGENC_DAEMON_AUTOSTART_FAILURE"] as const)(
    "restores CLI-only %s without changing Core state", async key => {
      const saved = process.env[key];
      const { setCoreOnlyEnvironmentVariable } = await import("../../src/utils/runtimeEnvironment.js");
      const { subprocessEnv } = await import("../../src/utils/subprocessEnv.js");
      const { scrubEnvForChildProcess } = await import("../../src/unified-exec/scrub-env.js");
      try {
        delete process.env[key];
        setCoreOnlyEnvironmentVariable(key, "core-first");
        setCoreOnlyEnvironmentVariable(key, "core-second");
        expect(subprocessEnv()).not.toHaveProperty(key);
        expect(scrubEnvForChildProcess(process.env)).not.toHaveProperty(key);
        expect(process.env[key]).toBe("core-second");
        vi.resetModules();
        process.env[key] = "user-value";
        const { setCoreOnlyEnvironmentVariable: setAgain, userRuntimeEnvironment } = await import("../../src/utils/runtimeEnvironment.js");
        setAgain(key, "core-value");
        expect(userRuntimeEnvironment(process.env)[key]).toBe("user-value");
        expect(process.env[key]).toBe("core-value");
      } finally {
        if (saved === undefined) delete process.env[key];
        else process.env[key] = saved;
      }
    },
  );

  it("leaves environments unchanged when Core has not defaulted NODE_ENV", async () => {
    const { subprocessEnv } = await import("../../src/utils/subprocessEnv.js");
    expect(subprocessEnv({})).not.toHaveProperty("NODE_ENV");
    expect(subprocessEnv({ NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });

  it.each(["src/bin/agenc.ts", "src/sandbox/linux-launcher/main.ts"])(
    "%s captures before defaulting and a second bootstrap preserves it",
    async (entry) => {
      delete process.env.NODE_ENV;
      const source = readFileSync(join(runtimeRoot, entry), "utf8");
      new Function(source.replace(/^#!.*\n/, "").split("await import(")[0])();
      expect(process.env.NODE_ENV).toBe("production");
      await import("../../src/bootstrap/node-env.js");
      const { subprocessEnv } = await import("../../src/utils/subprocessEnv.js");
      expect(subprocessEnv()).not.toHaveProperty("NODE_ENV");
    },
  );
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
    ["src/bin/agenc-main.ts", "../bootstrap/node-env.js"],
    ["src/mcp/server/start.ts", "../../bootstrap/node-env.js"],
    ["src/mcp/server/configured-start.ts", "../../bootstrap/node-env.js"],
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
