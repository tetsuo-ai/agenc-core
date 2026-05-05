export type ThreadSpawnEdgeStatus = "open" | "closed";

const THREAD_SPAWN_EDGE_STATUSES = new Set<string>([
  "open",
  "closed",
]);

export function isThreadSpawnEdgeStatus(
  value: unknown,
): value is ThreadSpawnEdgeStatus {
  return typeof value === "string" && THREAD_SPAWN_EDGE_STATUSES.has(value);
}
