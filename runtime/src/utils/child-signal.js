// Bridge for native Node source entrypoints, which import supervisedProcess.ts
// directly and do not remap a `.js` import to its TypeScript source.
export * from "./child-signal.ts";
