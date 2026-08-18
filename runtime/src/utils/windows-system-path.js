// Native Node source entrypoints do not remap a `.js` import to its TypeScript
// source counterpart. Keep this explicit bridge beside the implementation so
// standalone maintenance scripts and bundled/runtime consumers resolve the
// same hardened Windows path code.
export * from "./windows-system-path.ts";
