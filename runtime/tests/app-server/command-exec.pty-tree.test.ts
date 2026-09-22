import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/app-server/protocol/index.js";
import {
  settlesWithin,
  spawnShellBackedPty,
  waitUntilProcessGone,
  type ShellBackedPty,
} from "../helpers/shell-backed-pty.js";

// commandExec.terminate stopped a PTY session through tree-kill, which spawns
// pgrep (darwin) or ps (linux) through PATH with no error listener. Without
// them the daemon got an uncaught exception and the session kept running.

const { ptyFactory } = vi.hoisted(() => ({
  ptyFactory: { current: undefined as (() => unknown) | undefined },
}));

vi.mock("../../src/pty/loadPty.js", () => ({
  loadPty: () => ({
    spawn: () => {
      if (ptyFactory.current === undefined) {
        throw new Error("test PTY factory is not installed");
      }
      return ptyFactory.current();
    },
  }),
}));

const { AgenCCommandExecService } = await import(
  "../../src/app-server/command-exec.js"
);

const posixOnly = process.platform === "win32" ? it.skip : it;
const trees: ShellBackedPty[] = [];

afterEach(() => {
  ptyFactory.current = undefined;
  for (const tree of trees.splice(0)) tree.cleanup();
});

describe("commandExec PTY termination", () => {
  posixOnly(
    "terminate stops the PTY's whole tree when pgrep and ps are not on PATH",
    async () => {
      let backed: ShellBackedPty | undefined;
      ptyFactory.current = () => {
        backed = spawnShellBackedPty();
        trees.push(backed);
        return backed.pty;
      };
      const service = new AgenCCommandExecService();
      const notifications: JsonObject[] = [];
      const context = {
        connectionId: "pty-tree",
        sendNotification: (message: JsonObject) => notifications.push(message),
      };
      const started = service.start(
        {
          command: ["/bin/sh", "-c", "sleep 30"],
          processId: "pty-tree-1",
          tty: true,
          disableTimeout: true,
          permissionProfile: ":danger-full-access",
        },
        context,
      );
      void started.catch(() => undefined);
      await vi.waitFor(() => expect(backed).toBeDefined());
      const descendant = await backed!.descendantPid;

      const originalPath = process.env.PATH;
      process.env.PATH = "/nonexistent-agenc-test-bin";
      try {
        await service.terminate({ processId: "pty-tree-1" }, context);
        expect(await settlesWithin(backed!.exited, 3_000)).toBe(true);
        expect(await settlesWithin(started, 3_000)).toBe(true);
        expect(await waitUntilProcessGone(descendant, 3_000)).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    },
    15_000,
  );
});
