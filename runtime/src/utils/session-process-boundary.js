// Bridge for native Node source entrypoints, which load supervisedProcess.ts
// directly without remapping its .js imports to TypeScript source files.
export * from "./session-process-boundary.ts";
