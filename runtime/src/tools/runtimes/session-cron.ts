import type { Tool } from "../types.js";
import type { ToolRuntimeAttemptContext } from "./context.js";

type SessionCronMutation = {
  readonly name: "CronCreate" | "CronDelete";
  readonly conversationId: () => string | undefined;
};

// Authority belongs to the audited executable, never a model-provided name or
// metadata flag. Wrappers that replace execute must obtain their own audit.
const sessionCronMutations = new WeakMap<Tool["execute"], SessionCronMutation>();

export function registerSessionCronMutation(
  tool: Tool,
  conversationId: () => string | undefined,
): Tool {
  if (tool.name !== "CronCreate" && tool.name !== "CronDelete") return tool;
  sessionCronMutations.set(tool.execute, { name: tool.name, conversationId });
  return tool;
}

export function isSessionCronMemoryMutation(
  tool: Tool,
  args: Readonly<Record<string, unknown>>,
  context: ToolRuntimeAttemptContext,
): boolean {
  if (context.sandboxMode !== "workspace_write") return false;
  const registration = sessionCronMutations.get(tool.execute);
  if (registration === undefined || registration.name !== tool.name) return false;
  const owner = registration.conversationId();
  if (!owner || owner !== context.invocation.session.conversationId) return false;
  // The matching execute branch uses only the owner's in-memory store, even
  // for a missing/foreign id or a collision with a durable task id.
  if (registration.name === "CronDelete") return true;
  return (args.durable === undefined || args.durable === false) &&
    args.announceChannel === undefined && args.announceTo === undefined &&
    args.webhook === undefined;
}
