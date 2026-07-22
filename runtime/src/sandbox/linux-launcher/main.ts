#!/usr/bin/env node
/**
 * Order-proof process entry for the Linux sandbox launcher. No static
 * imports allowed — see `src/bin/agenc.ts` for the full rationale (NODE_ENV
 * must be set before any shared chunk can load an external dev/prod
 * dual-build package).
 */
process.env.NODE_ENV ??= "production";

await import("./main-impl.js");
