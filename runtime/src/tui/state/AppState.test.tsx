import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { PermissionMode } from "../../permissions/types.js";
import {
  AgenCAppStateProvider,
  useAgenCAppState,
  type ConfigStoreLike,
  type SessionLike,
} from "./AppState.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(
  element: React.ReactElement,
): Promise<{ unmount: () => void }> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

function createFakeSession(
  initialMode: PermissionMode = "default",
): SessionLike {
  const listeners = new Set<
    (next: PermissionMode, previous: PermissionMode) => void
  >();
  let mode = initialMode;
  return {
    services: {
      permissionModeRegistry: {
        current: () => ({ mode }),
        subscribeToModeChange: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    },
  };
}

const FAKE_CONFIG_STORE: ConfigStoreLike = { snapshot: {} };

describe("AgenCAppStateProvider", () => {
  test("keeps the full queue while surfacing only the active request", async () => {
    const rawSnapshots: number[] = [];
    const activeSnapshots: number[] = [];
    const activeIds: Array<string | null> = [];

    function Consumer(): null {
      const {
        permissionQueue,
        pendingRequests,
        activePermissionRequestId,
        permissionQueueOps,
      } = useAgenCAppState();
      rawSnapshots.push(permissionQueue.length);
      activeSnapshots.push(pendingRequests.length);
      activeIds.push(activePermissionRequestId);
      React.useEffect(() => {
        permissionQueueOps.push({
          requestId: "req-1",
          toolName: "Bash",
          toolInput: { command: "git status" },
          turnId: "turn-1",
          message: "first",
          submittedAt: Date.now(),
        });
        permissionQueueOps.push({
          requestId: "req-2",
          toolName: "system.writeFile",
          toolInput: { path: "/tmp/out.txt", content: "hello" },
          turnId: "turn-1",
          message: "second",
          submittedAt: Date.now(),
        });
      }, [permissionQueueOps]);
      return null;
    }

    const { unmount } = await mount(
      <AgenCAppStateProvider
        session={createFakeSession()}
        configStore={FAKE_CONFIG_STORE}
      >
        <Consumer />
      </AgenCAppStateProvider>,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(rawSnapshots).toContain(2);
    expect(activeSnapshots).toContain(1);
    expect(activeIds).toContain("req-1");
    unmount();
  });
});
