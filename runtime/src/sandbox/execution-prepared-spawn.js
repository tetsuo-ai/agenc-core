// Native Node source entrypoints do not remap a `.js` import to its TypeScript
// source counterpart. This bridge exposes the single prepared-spawn contract
// to maintenance scripts without loading the full sandbox broker graph.
export * from "./execution-prepared-spawn.ts";
