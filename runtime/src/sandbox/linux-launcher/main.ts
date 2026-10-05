#!/usr/bin/env node
/**
 * Order-proof process entry for the Linux sandbox launcher. No static
 * imports allowed — see `src/bin/agenc.ts` for the full rationale (NODE_ENV
 * must be set before any shared chunk can load an external dev/prod
 * dual-build package).
 */
// Keep this capture inline and import-free: bundle chunks may load React before
// a static bootstrap import. Share it with subprocesses via runtimeEnvironment.ts.
const originalEnvironmentKey = Symbol.for("agenc.originalRuntimeEnvironment");
if (!Object.prototype.hasOwnProperty.call(globalThis, originalEnvironmentKey)) {
  Object.defineProperty(globalThis, originalEnvironmentKey, {
    value: Object.freeze({ NODE_ENV: process.env.NODE_ENV }),
    configurable: true,
  });
}
process.env.NODE_ENV ??= "production";

await import("./main-impl.js");
