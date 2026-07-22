#!/usr/bin/env node
/**
 * Order-proof process entry for the `agenc` CLI.
 *
 * This wrapper MUST NOT contain a single static import. `react-reconciler`,
 * `react`, and `scheduler` stay external (React singleton constraint) and
 * pick their dev/prod builds from `process.env.NODE_ENV` at load time —
 * and esbuild code splitting does not preserve source import order across
 * chunks, so a static-import bootstrap can lose the race against a shared
 * chunk that reaches the reconciler (this is exactly how production
 * installs ran the DEVELOPMENT reconciler, whose scheduling profiler leaks
 * PerformanceMeasure entries until the TUI dies at the V8 heap limit).
 *
 * A dynamic import defers evaluation of the entire implementation graph
 * until after the assignment below has run. Keep this file import-free;
 * `tests/bootstrap/node-env.test.ts` pins that contract.
 *
 * `??=` so an explicitly-set NODE_ENV (tests, deliberate dev-React
 * debugging) still wins. The CLI implementation, including the
 * direct-invocation guard keyed on `process.argv[1]`, lives unchanged in
 * `./agenc-main.ts`.
 */
process.env.NODE_ENV ??= "production";

await import("./agenc-main.js");
