import { expect, vi } from "vitest";
import { holdAgentLifecycleLock } from "./held-agent-lifecycle-lock.js";

export function blockedControlHandler(
  longMethod: string, longLabel: string, controlMethod: string, controlLabel: string,
) {
  const events: string[] = [];
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  return {
    events,
    longStarted: started.promise,
    releaseLong: finished.resolve,
    onMessage: async (message: { readonly method?: unknown }) => {
      if (message.method === longMethod) {
        events.push(`${longLabel}:start`);
        started.resolve();
        await finished.promise;
        events.push(`${longLabel}:end`);
      } else if (message.method === controlMethod) {
        events.push(controlLabel);
      }
    },
  };
}

export async function assertAliasControlDispatch(
  send: (id: number, method: string, params?: object) => unknown,
  enteredTurn: Promise<void>,
  seen: string[],
  onHeldLock: (lock: Awaited<ReturnType<typeof holdAgentLifecycleLock>>) => void,
) {
  send(1, "message.stream", { sessionId: "session-a" });
  await enteredTurn;
  onHeldLock(await holdAgentLifecycleLock());
  send(2, "routine.create", { permissionAuthority: { kind: "session", sessionId: "agent-a", toolCallId: "call" } });
  send(3, "request.cancel");
  send(4, "health.ping");
  await vi.waitFor(() => {
    expect(seen).toHaveLength(4);
    expect(seen).toContain("routine.create");
    expect(seen).toContain("request.cancel");
    expect(seen).toContain("health.ping");
  });
}
