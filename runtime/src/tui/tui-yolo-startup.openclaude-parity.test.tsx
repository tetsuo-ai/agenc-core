import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";

import { bootTUI, type StdinLossSession } from "./main.js";
import instances from "./ink/instances.js";
import type { ConfigStoreLike } from "./state/AppState.js";
import type { PermissionMode } from "../permissions/types.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function streams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn(() => undefined);
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 32;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

function session(mode: PermissionMode): StdinLossSession {
  return {
    services: {
      permissionModeRegistry: {
        current: () => ({ mode }),
        subscribeToModeChange: () => () => undefined,
      },
    },
    submit: vi.fn(async () => undefined),
    abortTerminal: vi.fn(),
    emit: vi.fn(),
    nextInternalSubId: () => "sub-test",
  };
}

const configStore: ConfigStoreLike = { snapshot: {} };

describe("bootTUI normal and yolo shell parity", () => {
  test.each(["default", "bypassPermissions"] as const)(
    "%s mode mounts the same App shell and submits initial prompts",
    async (mode) => {
      const { stdout, stdin } = streams();
      const s = session(mode);

      const handle = await bootTUI({
        session: s,
        configStore,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        initialPrompt: "start here",
      });

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(s.submit).toHaveBeenCalledWith("start here");
      expect(stdin.setRawMode).toHaveBeenCalledWith(true);

      handle.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  );
});
