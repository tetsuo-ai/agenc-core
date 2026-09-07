import { execFileSync } from "node:child_process";
import {
  appendFile, chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readConfinedFile, scanConfinedFile, withConfinedDirectory, withRegularChild,
  type ConfinedIoHooks, type ConfinedIoPolicy,
} from "../../src/fs/descriptor-confined-io.js";
import { loadNamedWorkflowManifest } from "../../src/agents/workflow-manifest.js";
import { WorkflowHandoffArtifactStore } from "../../src/agents/workflow-handoff-store.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

const controls = vi.hoisted(() => ({
  hideAliases: false,
  beforeOpen: undefined as ((path: string) => Promise<void>) | undefined,
  beforeRealpath: undefined as ((path: string) => Promise<void>) | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
  maximumReadBytes: undefined as number | undefined,
  handles: [] as FileHandle[],
  requestedBytes: [] as number[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(async (...args: Parameters<typeof actual.realpath>) => {
      await controls.beforeRealpath?.(String(args[0]));
      if (controls.hideAliases && /^\/(?:proc\/self\/fd|dev\/fd)\//u.test(String(args[0]))) {
        throw Object.assign(new Error("descriptor aliases unavailable"), { code: "ENOENT" });
      }
      return actual.realpath(...args);
    }),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      await controls.beforeOpen?.(String(args[0]));
      const handle = await actual.open(...args);
      controls.handles.push(handle);
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          controls.requestedBytes.push(length);
          const result = await read(buffer, offset, Math.min(length, controls.maximumReadBytes ?? length), position);
          const afterRead = controls.afterRead;
          controls.afterRead = undefined;
          await afterRead?.();
          return result;
        },
      });
      return handle;
    }),
  };
});

const sharedPolicy: ConfinedIoPolicy = Object.freeze({
  hardLinks: "allow",
  privateDirectory: false,
  privateFile: false,
  unavailableAlias: "identity-checked-path",
});
const privatePolicy: ConfinedIoPolicy = Object.freeze({
  hardLinks: "reject",
  privateDirectory: true,
  privateFile: true,
  unavailableAlias: "reject",
});
let temporaryDirectory: string;
let root: string;
let candidate: string;

beforeEach(async () => {
  controls.hideAliases = false;
  controls.beforeOpen = undefined;
  controls.beforeRealpath = undefined;
  controls.afterRead = undefined;
  controls.maximumReadBytes = undefined;
  controls.handles = [];
  controls.requestedBytes = [];
  temporaryDirectory = await mkdtemp(join(tmpdir(), "agenc-confined-io-"));
  root = join(temporaryDirectory, "root");
  candidate = join(root, "candidate");
  await mkdir(root, { mode: 0o700 });
  await writeFile(candidate, "safe", { mode: 0o600 });
});

afterEach(async () => {
  controls.beforeOpen = undefined;
  controls.beforeRealpath = undefined;
  controls.afterRead = undefined;
  for (const handle of controls.handles) {
    if (handle.fd !== -1) await handle.close();
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function readCandidate(
  policy: ConfinedIoPolicy = sharedPolicy,
  hooks: ConfinedIoHooks = {},
  maximumBytes = 4,
): Promise<Buffer | undefined> {
  return withConfinedDirectory(root, policy, (directory) => withRegularChild(
    directory, "candidate", { maximumBytes }, readConfinedFile, hooks,
  ), hooks);
}

describe("descriptor-confined I/O", () => {
  it("preserves an operational failure during post-read verification", async () => {
    const failure = Object.assign(new Error("temporary verification failure"), { code: "EIO" });
    controls.afterRead = async () => {
      controls.beforeRealpath = async (path) => {
        if (path.endsWith("candidate")) throw failure;
      };
    };
    await expect(readCandidate()).rejects.toBe(failure);
    expect(controls.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("reports a child removed between inspection and opening as missing", async () => {
    controls.beforeOpen = async (path) => {
      if (!path.endsWith("candidate")) return;
      controls.beforeOpen = undefined;
      await unlink(candidate);
    };
    expect(await readCandidate()).toBeUndefined();
    expect(controls.requestedBytes).toEqual([]);
  });

  it("reads the exact cap, handles short reads, and closes both descriptors", async () => {
    controls.maximumReadBytes = 1;
    expect(await readCandidate()).toEqual(Buffer.from("safe"));
    expect(controls.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("rejects an oversized child before opening or reading it", async () => {
    await expect(readCandidate(sharedPolicy, {}, 3)).rejects.toMatchObject({ code: "CHILD_TOO_LARGE" });
    expect(controls.requestedBytes).toEqual([]);
    expect(controls.handles).toHaveLength(process.platform === "win32" ? 0 : 1);
    expect(controls.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("accepts an empty file at a zero-byte cap and distinguishes a missing child", async () => {
    await writeFile(candidate, "");
    expect(await readCandidate(sharedPolicy, {}, 0)).toEqual(Buffer.alloc(0));
    await unlink(candidate);
    expect(await readCandidate()).toBeUndefined();
  });

  it.each(["root", "child"])("rejects a %s symlink without reading outside bytes", async (role) => {
    const outside = join(temporaryDirectory, "outside");
    if (role === "root") {
      await rename(root, outside);
      await symlink(outside, root, "junction");
    } else {
      await writeFile(outside, "secret");
      await unlink(candidate);
      await symlink(outside, candidate);
    }
    await expect(readCandidate()).rejects.toMatchObject({
      code: role === "root" ? "ROOT_UNSAFE" : "CHILD_UNSAFE",
    });
    expect(controls.requestedBytes).toEqual([]);
  });

  it.each([false, true])("detects root replacement before child I/O with path fallback=%s", async (fallback) => {
    controls.hideAliases = fallback;
    await expect(readCandidate(sharedPolicy, {
      async afterRootOpen() {
        await rename(root, `${root}.old`);
        await mkdir(root);
        await writeFile(candidate, "evil");
      },
    })).rejects.toMatchObject({ code: "ROOT_CHANGED" });
    expect(controls.requestedBytes).toEqual([]);
  });

  it("detects root replacement between inspection and descriptor opening", async () => {
    if (process.platform === "win32") {
      expect(sharedPolicy.unavailableAlias).toBe("identity-checked-path");
      return;
    }
    controls.beforeOpen = async (path) => {
      if (path !== root) return;
      controls.beforeOpen = undefined;
      await rename(root, `${root}.old`);
      await mkdir(root);
    };
    await expect(readCandidate()).rejects.toMatchObject({ code: "ROOT_CHANGED" });
    expect(controls.requestedBytes).toEqual([]);
  });

  it.each(["regular", "symlink", "fifo"])("rejects a %s replacement between child inspection and open", async (replacement) => {
    if (process.platform === "win32" && replacement === "fifo") {
      expect(process.platform).toBe("win32");
      return;
    }
    controls.beforeOpen = async (path) => {
      if (!path.endsWith("candidate")) return;
      controls.beforeOpen = undefined;
      await rename(candidate, `${candidate}.old`);
      if (replacement === "regular") await writeFile(candidate, "evil");
      if (replacement === "symlink") await symlink(`${candidate}.old`, candidate);
      if (replacement === "fifo") execFileSync("mkfifo", [candidate]);
    };
    await expect(readCandidate()).rejects.toMatchObject({
      code: replacement === "fifo" ? "CHILD_UNSAFE" : "CHILD_CHANGED",
    });
    expect(controls.requestedBytes).toEqual([]);
    expect(controls.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("detects a replaced child before consuming the opened bytes", async () => {
    await expect(readCandidate(sharedPolicy, {
      async afterCandidateOpen() {
        await rename(candidate, `${candidate}.old`);
        await writeFile(candidate, "evil");
      },
    })).rejects.toMatchObject({ code: "CHILD_CHANGED" });
    expect(controls.requestedBytes).toEqual([]);
  });

  it.each(["grow", "shrink", "replace"])("rejects a %s during reading without an unbounded read", async (mutation) => {
    controls.maximumReadBytes = 1;
    controls.afterRead = async () => {
      if (mutation === "grow") await appendFile(candidate, "-oversized");
      if (mutation === "shrink") await writeFile(candidate, "s");
      if (mutation === "replace") {
        await rename(candidate, `${candidate}.old`);
        await writeFile(candidate, "evil");
      }
    };
    await expect(readCandidate()).rejects.toMatchObject({ code: "CHILD_CHANGED" });
    expect(controls.requestedBytes.every((length) => length <= 5)).toBe(true);
    expect(controls.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("allows sibling churn while retaining root and child identity", async () => {
    expect(await readCandidate(sharedPolicy, {
      async afterCandidateOpen() {
        await writeFile(join(root, "sibling"), "unrelated");
      },
    })).toEqual(Buffer.from("safe"));
  });

  it("names hard-link policy without changing shared-manifest semantics", async () => {
    await link(candidate, join(temporaryDirectory, "hard-link"));
    expect(await readCandidate(sharedPolicy)).toEqual(Buffer.from("safe"));
    await expect(readCandidate({ ...sharedPolicy, hardLinks: "reject" }))
      .rejects.toMatchObject({ code: "CHILD_UNSAFE" });
  });

  it.each(["directory", "file"])("enforces the named private-%s policy", async (role) => {
    if (process.platform === "win32") {
      await expect(readCandidate(privatePolicy)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
      return;
    }
    await chmod(role === "directory" ? root : candidate, 0o755);
    expect(await readCandidate(sharedPolicy)).toEqual(Buffer.from("safe"));
    await expect(readCandidate(privatePolicy)).rejects.toMatchObject({
      code: role === "directory" ? "ROOT_UNSAFE" : "CHILD_UNSAFE",
    });
  });

  it("names the descriptor-alias fallback and fail-closed policies", async () => {
    controls.hideAliases = true;
    expect(await readCandidate(sharedPolicy)).toEqual(Buffer.from("safe"));
    await expect(readCandidate({ ...sharedPolicy, unavailableAlias: "reject" }))
      .rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
  });

  it("streams bounded chunks without accumulating a whole-file result", async () => {
    const bytes = Buffer.alloc(131_072, 97);
    await writeFile(candidate, bytes);
    const chunks: number[] = [];
    await withConfinedDirectory(root, sharedPolicy, (directory) => withRegularChild(
      directory, "candidate", { maximumBytes: bytes.byteLength },
      (file) => scanConfinedFile(file, (chunk) => { chunks.push(chunk.byteLength); }),
    ));
    expect(chunks).toEqual([65_536, 65_536]);
    expect(controls.requestedBytes.at(-1)).toBe(1);
  });

  it.each(["../outside", "..\\outside", "C:\\outside", ".", ""])(
    "rejects a non-child name %j before filesystem reads", async (name) => {
      await expect(withConfinedDirectory(root, sharedPolicy, (directory) => withRegularChild(
        directory, name, { maximumBytes: 4 }, readConfinedFile,
      ))).rejects.toBeInstanceOf(TypeError);
      expect(controls.requestedBytes).toEqual([]);
    },
  );
});

describe("workflow consumer filesystem policies", () => {
  it.each([
    ["read", "EMFILE"], ["read", "EACCES"], ["read", "EIO"],
    ["cleanup", "EMFILE"], ["cleanup", "EACCES"], ["cleanup", "EIO"],
    ["recovery", "EMFILE"], ["recovery", "EACCES"], ["recovery", "EIO"],
  ])("keeps %s retryable after a child open returns %s", async (operation, code) => {
    const driver = openStateDatabases({
      cwd: temporaryDirectory, agencHome: join(temporaryDirectory, "home"),
    });
    try {
      let now = 1_000_000;
      let artifactId = "";
      const store = new WorkflowHandoffArtifactStore({
        driver, trustedRoot: join(temporaryDirectory, "handoffs"),
        retentionMs: 100, intentRecoveryGraceMs: 0, now: () => now,
        hooks: {
          afterArtifactInstalled(installedId) {
            artifactId = installedId;
            if (operation === "recovery") throw new Error("reserved for recovery");
          },
        },
      });
      const publication = store.publish({
        owner: { run_id: "run", workflow_id: "workflow", producer_step_id: "step" },
        idempotencyKey: "retryable", bytes: Buffer.from("safe"), tokenCount: 1,
      });
      if (operation === "recovery") {
        await expect(publication).rejects.toThrow("reserved for recovery");
      } else {
        await publication;
      }
      const failure = Object.assign(new Error("temporary open failure"), { code });
      controls.beforeOpen = async (path) => {
        if (path.endsWith(`${artifactId}.handoff`)) throw failure;
      };
      now += 101;
      const attempt = () => operation === "read"
        ? store.read(artifactId)
        : operation === "cleanup" ? store.cleanupExpired() : store.recoverIntents();
      await expect(attempt()).rejects.toBe(failure);
      expect(store.inspectForOperator(artifactId).status).toBe(
        operation === "read" ? "committed" : operation === "cleanup" ? "deleting" : "intent",
      );
      controls.beforeOpen = undefined;
      await expect(attempt()).resolves.toBeDefined();
    } finally {
      driver.close();
    }
  });

  it("maps a rejected Windows child ACL to a child conflict", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await expect(readCandidate({
        ...privatePolicy,
        unavailableAlias: "windows-private-path",
        verifyWindowsPrivatePath(_path, role) {
          if (role === "file") throw new Error("child ACL is inherited");
        },
      })).rejects.toMatchObject({ code: "CHILD_UNSAFE" });
      expect(controls.requestedBytes).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("rejects an oversized handoff cleanup candidate before opening it", async () => {
    const driver = openStateDatabases({
      cwd: temporaryDirectory,
      agencHome: join(temporaryDirectory, "home"),
    });
    try {
      let now = 1_000_000;
      const store = new WorkflowHandoffArtifactStore({
        driver,
        trustedRoot: join(temporaryDirectory, "handoffs"),
        retentionMs: 100,
        now: () => now,
      });
      const artifact = await store.publish({
        owner: { run_id: "run", workflow_id: "workflow", producer_step_id: "step" },
        idempotencyKey: "cleanup", bytes: Buffer.from("safe"), tokenCount: 1,
      });
      const path = join(store.trustedRoot, `${artifact.artifact_id}.handoff`);
      await appendFile(path, "-oversized");
      let childOpened = false;
      controls.beforeOpen = async (openedPath) => {
        if (openedPath.endsWith(`${artifact.artifact_id}.handoff`)) childOpened = true;
      };
      controls.requestedBytes = [];
      now += 101;
      expect(await store.cleanupExpired()).toMatchObject({ removed: 0, conflicts: 1 });
      expect(childOpened).toBe(false);
      expect(controls.requestedBytes).toEqual([]);
      expect(await readFile(path, "utf8")).toBe("safe-oversized");
    } finally {
      driver.close();
    }
  });

  it("loads a shared hard-linked manifest when descriptor aliases are unavailable", async () => {
    const manifest = '{"format_version":2,"kind":"agent_dag","steps":[{"id":"step","message":"work"}]}';
    await writeFile(candidate, manifest);
    await link(candidate, join(root, "example.json"));
    controls.hideAliases = true;
    const loaded = await loadNamedWorkflowManifest({ name: "example", roots: [root] });
    expect(loaded.document.manifest.steps[0]?.id).toBe("step");
  });

  it("keeps handoff reads fail-closed without POSIX descriptor aliases", async () => {
    if (process.platform === "win32") {
      expect(process.platform).toBe("win32");
      return;
    }
    const driver = openStateDatabases({ cwd: temporaryDirectory, agencHome: join(temporaryDirectory, "home") });
    try {
      const store = new WorkflowHandoffArtifactStore({ driver, trustedRoot: join(temporaryDirectory, "handoffs") });
      const artifact = await store.publish({
        owner: { run_id: "run", workflow_id: "workflow", producer_step_id: "step" },
        idempotencyKey: "item", bytes: Buffer.from("safe"), tokenCount: 1,
      });
      controls.hideAliases = true;
      await expect(store.read(artifact.artifact_id)).rejects.toMatchObject({ code: "WORKFLOW_HANDOFF_SAFE_IO_UNSUPPORTED" });
      expect(await readFile(join(store.trustedRoot, `${artifact.artifact_id}.handoff`), "utf8")).toBe("safe");
    } finally {
      driver.close();
    }
  });
});
