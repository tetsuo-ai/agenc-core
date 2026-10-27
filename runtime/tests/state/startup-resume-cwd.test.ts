import childProcess, { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { closeSync, fstatSync, mkdirSync, renameSync } from "node:fs";
import fsPromises, { mkdtemp, rm, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openStartupResumeCwd } from "../../src/state/startup-resume-cwd.js";

let root: string;
beforeEach(async () => {
  root = await fsPromises.realpath(await mkdtemp(join(tmpdir(), "agenc-startup-cwd-")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
});

describe("startup workspace pinning", () => {
  it("pins the exact directory identity", async () => {
    const proof = await openStartupResumeCwd(root);
    try {
      const stats = fstatSync(proof.fd, { bigint: true });
      expect(proof.identity).toEqual({ dev: String(stats.dev), ino: String(stats.ino) });
      expect(stats.isDirectory()).toBe(true);
    } finally {
      closeSync(proof.fd);
    }
  });

  it("rejects missing paths and symlinks", async () => {
    await expect(openStartupResumeCwd(join(root, "missing"), { platformForTestingOnly: "linux" })).rejects.toMatchObject({ code: "ENOENT" });
    const link = join(root, "link");
    await symlink(root, link);
    await expect(openStartupResumeCwd(link)).rejects.toThrow("non-symlink directory");
  });

  it("rejects replacement during pinning and closes the directory fd", async () => {
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    let openedFd: number | undefined;
    await expect(openStartupResumeCwd(cwd, {
      afterOpenForTestingOnly: (_cwd, fd) => {
        openedFd = fd;
        renameSync(cwd, join(root, "old-workspace"));
        mkdirSync(cwd);
      },
    })).rejects.toThrow("changed while pinned");
    expect(() => fstatSync(openedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("bounds a filesystem operation that never resolves", async () => {
    vi.spyOn(fsPromises, "lstat").mockImplementation(() => new Promise(() => {}));
    syncBuiltinESMExports();
    await expect(openStartupResumeCwd(root, { platformForTestingOnly: "linux", timeoutMs: 20 })).rejects.toThrow("timed out after 20ms");
  });

  it("closes an opened fd when a timed out operation returns late", async () => {
    const originalLstat = fsPromises.lstat;
    let releaseStat: (() => void) | undefined;
    let calls = 0;
    vi.spyOn(fsPromises, "lstat").mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) {
        return new Promise((resolve, reject) => {
          releaseStat = () => Reflect.apply(originalLstat, fsPromises, args).then(resolve, reject);
        });
      }
      return Reflect.apply(originalLstat, fsPromises, args);
    });
    syncBuiltinESMExports();
    let openedFd: number | undefined;
    await expect(openStartupResumeCwd(root, {
      platformForTestingOnly: "linux", timeoutMs: 100,
      afterOpenForTestingOnly: (_cwd, fd) => { openedFd = fd; },
    })).rejects.toThrow("timed out");
    expect(releaseStat).toBeTypeOf("function");
    releaseStat!();
    await vi.waitFor(() => {
      expect(() => fstatSync(openedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    });
  });

  it("aborts a blocked workspace without waiting for its deadline", async () => {
    const controller = new AbortController();
    const blocked = vi.spyOn(fsPromises, "lstat").mockImplementation(() => new Promise(() => {}));
    syncBuiltinESMExports();
    const pin = openStartupResumeCwd(root, { platformForTestingOnly: "linux", signal: controller.signal });
    expect(blocked).toHaveBeenCalledOnce();
    controller.abort(new Error("daemon shutdown"));
    await expect(pin).rejects.toThrow("daemon shutdown");
    await expect(openStartupResumeCwd(root, { platformForTestingOnly: "linux", signal: controller.signal })).rejects.toThrow("daemon shutdown");
    expect(blocked).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.platform === "win32")("macOS startup workspace consent probe", () => {
  it("kills a blocked directory-open probe before any in-process workspace access", async () => {
    const fifo = join(root, "consent-prompt");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const children: ReturnType<typeof spawn>[] = [];
    const originalSpawn = childProcess.spawn;
    vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawn>) => {
      const child = Reflect.apply(originalSpawn, childProcess, args);
      children.push(child);
      return child;
    });
    const lstat = vi.spyOn(fsPromises, "lstat");
    const realpath = vi.spyOn(fsPromises, "realpath");
    const open = vi.spyOn(fs, "open");
    syncBuiltinESMExports();
    await expect(openStartupResumeCwd(fifo, {
      platformForTestingOnly: "darwin", timeoutMs: 100,
    })).rejects.toThrow("macOS is asking for permission to open the folder; answer the dialog, then resume the session");
    expect(children).toHaveLength(1);
    await vi.waitFor(() => expect(children[0]!.signalCode).toBe("SIGKILL"));
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("kills the probe on shutdown cancellation without touching the workspace", async () => {
    const fifo = join(root, "abort-probe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    let probe: ReturnType<typeof spawn> | undefined;
    const originalSpawn = childProcess.spawn;
    vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawn>) => {
      probe = Reflect.apply(originalSpawn, childProcess, args);
      return probe;
    });
    const lstat = vi.spyOn(fsPromises, "lstat");
    syncBuiltinESMExports();
    const controller = new AbortController();
    const pin = openStartupResumeCwd(fifo, { platformForTestingOnly: "darwin", signal: controller.signal });
    controller.abort(new Error("daemon shutdown"));
    await expect(pin).rejects.toThrow("daemon shutdown");
    await vi.waitFor(() => expect(probe?.signalCode).toBe("SIGKILL"));
    expect(lstat).not.toHaveBeenCalled();
  });

  it("never pins a workspace after the probe fails", async () => {
    const lstat = vi.spyOn(fsPromises, "lstat");
    syncBuiltinESMExports();
    await expect(openStartupResumeCwd(join(root, "missing"), {
      platformForTestingOnly: "darwin",
    })).rejects.toThrow("startup workspace open probe failed");
    expect(lstat).not.toHaveBeenCalled();
  });

  it("keeps directory identity pinning after a successful consent probe", async () => {
    const cwd = join(root, "folder with 'quotes' and $(literal)");
    mkdirSync(cwd);
    const probe = vi.spyOn(childProcess, "spawn");
    syncBuiltinESMExports();
    const proof = await openStartupResumeCwd(cwd, { platformForTestingOnly: "darwin" });
    try {
      expect(probe).toHaveBeenCalledWith("/bin/sh", ["-c", 'exec 3< "$1"', "sh", cwd], expect.objectContaining({ cwd: "/" }));
      expect(proof.identity.ino).toBe(String(fstatSync(proof.fd, { bigint: true }).ino));
    } finally { closeSync(proof.fd); }
  });
});
