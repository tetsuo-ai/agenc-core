import { describe, expect, it } from "vitest";

import {
  readPersistedUserStopState,
  sessionStateUpdateAddressesSlot,
  type RolloutItem,
} from "../../src/session/rollout-item.js";

function sessionState(payload: unknown): RolloutItem {
  return { type: "session_state", payload } as RolloutItem;
}

describe("readPersistedUserStopState", () => {
  it("returns a valid slot and ignores items that do not address it", () => {
    expect(
      readPersistedUserStopState(
        sessionState({ userStop: { stopped: true, generation: 2 } }),
      ),
    ).toEqual({ stopped: true, generation: 2 });
    expect(
      readPersistedUserStopState({
        type: "event_msg",
        payload: { userStop: { stopped: true, generation: 1 } },
      } as RolloutItem),
    ).toBeUndefined();
    expect(readPersistedUserStopState(sessionState({}))).toBeUndefined();
    expect(
      readPersistedUserStopState(sessionState({ agentTask: undefined })),
    ).toBeUndefined();
  });

  it("fails closed on a malformed or extra-keyed stop slot", () => {
    const invalid = [
      null,
      { stopped: true },
      { stopped: "true", generation: 1 },
      { stopped: true, generation: -1 },
      { stopped: false, generation: 1.5 },
      { stopped: false, generation: Number.MAX_SAFE_INTEGER + 1 },
      { stopped: true, generation: 1, extra: true },
    ];
    for (const userStop of invalid) {
      expect(() =>
        readPersistedUserStopState(sessionState({ userStop })),
      ).toThrow(/Invalid persisted user-stop state/);
    }
  });
});

describe("sessionStateUpdateAddressesSlot", () => {
  it("treats a present key as addressing that slot only", () => {
    const payload = { userStop: { stopped: false, generation: 0 } };
    expect(sessionStateUpdateAddressesSlot(payload, "userStop")).toBe(true);
    expect(sessionStateUpdateAddressesSlot(payload, "agentTask")).toBe(false);
    expect(sessionStateUpdateAddressesSlot(payload, "memoryExtraction")).toBe(
      false,
    );
  });

  it("reads an empty payload as the legacy agent-task clear", () => {
    expect(sessionStateUpdateAddressesSlot({}, "agentTask")).toBe(true);
    expect(sessionStateUpdateAddressesSlot({}, "userStop")).toBe(false);
    expect(sessionStateUpdateAddressesSlot({}, "memoryExtraction")).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(
      sessionStateUpdateAddressesSlot(
        null as never,
        "agentTask",
      ),
    ).toBe(false);
  });
});
