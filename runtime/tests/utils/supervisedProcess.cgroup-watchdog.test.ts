import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFailedSpawnChild,
  type FailedSpawnChild,
} from "../helpers/failed-spawn-child.js";

// Linux delegates contained processes to one cgroup owner watchdog per
// daemon. That singleton was published before its setup ran, and the setup
// touched the watchdog's stdio before any error listener existed. With EMFILE
// the setup threw a TypeError, the spawn error became an uncaught exception,
// and every contained command started in the same tick reused the broken
// watchdog. This runs the Linux path on any host: the platform, the cgroup
// files and every child are stand-ins. Nothing is signalled or written under
// /sys.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    rmdirSync: vi.fn(actual.rmdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const { spawnContainedProcess } = await import(
  "../../src/utils/supervisedProcess.js"
);
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const inCgroupTree = (path: unknown): boolean =>
  String(path).startsWith("/sys/fs/cgroup/");

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.mocked(fs.readFileSync).mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
    path === "/proc/self/cgroup"
      ? "0::/agenc-test.slice\n"
      : (actualFs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.readFileSync);
  vi.mocked(fs.mkdirSync).mockImplementation(((path: fs.PathLike, ...rest: unknown[]) =>
    inCgroupTree(path)
      ? undefined
      : (actualFs.mkdirSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.mkdirSync);
  vi.mocked(fs.existsSync).mockImplementation((path) =>
    inCgroupTree(path) ? true : actualFs.existsSync(path));
  vi.mocked(fs.writeFileSync).mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
    inCgroupTree(path)
      ? undefined
      : (actualFs.writeFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.writeFileSync);
  vi.mocked(fs.rmdirSync).mockImplementation(((path: fs.PathLike, ...rest: unknown[]) =>
    inCgroupTree(path)
      ? undefined
      : (actualFs.rmdirSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.rmdirSync);
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  for (const mock of [
    fs.existsSync,
    fs.mkdirSync,
    fs.readFileSync,
    fs.rmdirSync,
    fs.writeFileSync,
  ]) {
    vi.mocked(mock).mockReset();
  }
  vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync);
  vi.mocked(fs.mkdirSync).mockImplementation(actualFs.mkdirSync);
  vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync);
  vi.mocked(fs.rmdirSync).mockImplementation(actualFs.rmdirSync);
  vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
});

/** A gate child whose spawn succeeded; kill() is a spy that signals nothing. */
function startedGate() {
  const stdio = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  return Object.assign(new EventEmitter(), {
    pid: 424_242,
    exitCode: null,
    signalCode: null,
    stdio,
    stdin: stdio[0],
    stdout: stdio[1],
    stderr: stdio[2],
    kill: vi.fn(() => true),
    ref() {},
    unref() {},
  });
}

describe("Linux cgroup owner watchdog", () => {
  it("a watchdog spawn that left no stdio is not reused and raises no uncaught error", async () => {
    const gates = [startedGate(), startedGate()];
    const watchdogs: FailedSpawnChild[] = [];
    spawnMock.mockImplementation(((command: string) => {
      if (command === "/bin/bash") {
        const watchdog = createFailedSpawnChild({ code: "EMFILE", command });
        watchdogs.push(watchdog);
        return watchdog;
      }
      const gate = gates.shift();
      if (gate === undefined) throw new Error("unexpected spawn");
      return gate;
    }) as never);
    const launch = () =>
      spawnContainedProcess(process.execPath, ["-e", "0"], {
        cwd: tmpdir(),
        env: {},
      });

    // Two contained commands in the same tick, before Node reports the
    // first watchdog's failure.
    expect(launch).toThrow("contained process watchdog could not be started");
    expect(launch).toThrow("contained process watchdog could not be started");
    await Promise.all(watchdogs.map((watchdog) => watchdog.reported));

    expect(watchdogs).toHaveLength(2);
    expect(watchdogs.flatMap((watchdog) => watchdog.uncaught)).toEqual([]);
    expect(watchdogs.flatMap((watchdog) => watchdog.groupSignals)).toEqual([]);
  });
});
