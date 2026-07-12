/**
 * Runtime version constant — extracted to a standalone, dependency-free
 * module so deep internal modules (e.g. durable-turns build-pin) can import
 * the version without pulling in the heavy public barrel (`index.ts`) and
 * risking an import cycle.
 *
 * @module
 */

export const VERSION = "0.6.0";
