import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const injected = vi.hoisted(() => ({
  targetPath: "",
  syncDescriptor: undefined as number | undefined,
  asyncReadFailure: new Error("injected asynchronous state read failure"),
  asyncCloseFailure: new Error("injected asynchronous state close failure"),
  syncReadFailure: new Error("injected synchronous state read failure"),
  syncCloseFailure: new Error("injected synchronous state close failure"),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]) !== injected.targetPath) return handle;
      return {
        stat: handle.stat.bind(handle),
        readFile: async () => {
          throw injected.asyncReadFailure;
        },
        close: async () => {
          await handle.close();
          throw injected.asyncCloseFailure;
        },
      };
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    openSync: (...args: Parameters<typeof original.openSync>) => {
      const descriptor = original.openSync(...args);
      if (String(args[0]) === injected.targetPath) {
        injected.syncDescriptor = descriptor;
      }
      return descriptor;
    },
    readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
      if (args[0] === injected.syncDescriptor) {
        throw injected.syncReadFailure;
      }
      return original.readFileSync(...args);
    },
    closeSync: (descriptor: number) => {
      if (descriptor === injected.syncDescriptor) {
        original.closeSync(descriptor);
        injected.syncDescriptor = undefined;
        throw injected.syncCloseFailure;
      }
      return original.closeSync(descriptor);
    },
  };
});

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
const roots: string[] = [];

afterEach(() => {
  injected.targetPath = "";
  injected.syncDescriptor = undefined;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-state-close-errors-"));
  roots.push(root);
  const path = join(root, "state.json");
  writeFileSync(path, '{"state_version":1,"state":{}}\n', { mode: 0o600 });
  injected.targetPath = path;
  return path;
}

describe("canonical state read cleanup errors", () => {
  test("keeps an asynchronous read failure primary when close also fails", async () => {
    vi.resetModules();
    const { readCanonicalState } = await import("../../src/config/state.js");
    let caught: unknown;
    try {
      await readCanonicalState(statePath());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(injected.asyncReadFailure);
    expect(
      (caught as Error & { cleanupErrors?: readonly Error[] }).cleanupErrors,
    ).toEqual([injected.asyncCloseFailure]);
  });

  test("keeps a synchronous read failure primary when close also fails", async () => {
    vi.resetModules();
    const { readCanonicalStateSync } = await import("../../src/config/state.js");
    let caught: unknown;
    try {
      readCanonicalStateSync(statePath());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(injected.syncReadFailure);
    expect(
      (caught as Error & { cleanupErrors?: readonly Error[] }).cleanupErrors,
    ).toEqual([injected.syncCloseFailure]);
  });
});
