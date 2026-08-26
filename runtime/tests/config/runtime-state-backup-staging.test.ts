import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const injected = vi.hoisted(() => ({
  armed: false,
  stageDescriptor: undefined as number | undefined,
  stageCloseCount: 0,
  fchmodFailure: new Error("injected backup-stage fchmod failure"),
  closeFailure: new Error("injected backup-stage close failure"),
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    openSync: (path: import("node:fs").PathLike, ...args: unknown[]) => {
      const descriptor = Reflect.apply(original.openSync, original, [path, ...args]);
      if (
        injected.armed &&
        typeof path === "string" &&
        path.includes(".backup.") &&
        path.includes(".stage-")
      ) {
        injected.stageDescriptor = descriptor;
      }
      return descriptor;
    },
    fchmodSync: (descriptor: number, mode: number) => {
      if (injected.armed && descriptor === injected.stageDescriptor) {
        throw injected.fchmodFailure;
      }
      return original.fchmodSync(descriptor, mode);
    },
    closeSync: (descriptor: number) => {
      if (injected.armed && descriptor === injected.stageDescriptor) {
        injected.stageCloseCount += 1;
        original.closeSync(descriptor);
        throw injected.closeFailure;
      }
      return original.closeSync(descriptor);
    },
  };
});

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";

const roots: string[] = [];
const repositories: Array<{ close(): void }> = [];

afterEach(() => {
  injected.armed = false;
  injected.stageDescriptor = undefined;
  injected.stageCloseCount = 0;
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runtime-state backup staging", () => {
  test("keeps fchmod primary, attaches close diagnostics, and removes the partial stage", async () => {
    vi.resetModules();
    const { resolveHomeContext } = await import("../../src/config/home.js");
    const { RuntimeStateRepository } = await import(
      "../../src/config/runtime-state-repository.js"
    );
    const {
      createCanonicalStateDocument,
      writeCanonicalStateAtomicSync,
    } = await import("../../src/config/state.js");
    const root = mkdtempSync(join(tmpdir(), "agenc-backup-stage-"));
    roots.push(root);
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const original = createCanonicalStateDocument({
      global: { hasSeenTasksHint: false },
    });
    writeCanonicalStateAtomicSync(home.statePath, original);
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    injected.armed = true;
    let caught: unknown;
    try {
      repository.update((current) => ({
        ...current,
        hasSeenTasksHint: true,
      }));
    } catch (error) {
      caught = error;
    }
    injected.armed = false;

    expect(caught).toBe(injected.fchmodFailure);
    expect(
      (caught as Error & { cleanupErrors?: readonly Error[] }).cleanupErrors,
    ).toEqual([injected.closeFailure]);
    expect(injected.stageCloseCount).toBe(1);
    expect(JSON.parse(readFileSync(home.statePath, "utf8"))).toEqual(original);
    expect(
      readdirSync(join(home.path, "backups"))
        .filter((entry) => entry.includes(".stage-")),
    ).toEqual([]);
  });
});
