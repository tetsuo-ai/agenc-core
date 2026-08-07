import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readDaemonRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
  writeDaemonRuntimeInfo,
} from "../../src/app-server/daemon-runtime-info.js";

const BASE_INFO = {
  pid: 4242,
  runtimeVersion: "0.14.2",
  commit: "abc123",
  buildTime: "2026-08-07T00:00:00.000Z",
  startedAt: "2026-08-07T00:00:01.000Z",
} as const;

describe("daemon runtime info sidecar", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-runtime-info-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips the bound websocket url", () => {
    const path = resolveAgenCDaemonRuntimeInfoPath(home);
    writeDaemonRuntimeInfo(path, {
      ...BASE_INFO,
      webSocketUrl: "ws://127.0.0.1:40117/",
    });

    expect(readDaemonRuntimeInfo(path)).toEqual({
      ...BASE_INFO,
      webSocketUrl: "ws://127.0.0.1:40117/",
    });
  });

  it("reads sidecars written by daemons that recorded no websocket url", () => {
    // Older daemons wrote no webSocketUrl at all; a reader that required it
    // would treat every pre-upgrade daemon as unreadable and force a respawn.
    const path = resolveAgenCDaemonRuntimeInfoPath(home);
    writeFileSync(path, `${JSON.stringify(BASE_INFO, null, 2)}\n`);

    const info = readDaemonRuntimeInfo(path);
    expect(info).toEqual(BASE_INFO);
    expect(info?.webSocketUrl).toBeUndefined();
  });

  it("drops a malformed websocket url instead of failing the whole read", () => {
    const path = resolveAgenCDaemonRuntimeInfoPath(home);
    writeFileSync(
      path,
      `${JSON.stringify({ ...BASE_INFO, webSocketUrl: 7766 }, null, 2)}\n`,
    );

    const info = readDaemonRuntimeInfo(path);
    expect(info).toEqual(BASE_INFO);
    expect(info?.webSocketUrl).toBeUndefined();
  });

  it("returns null when required skew fields are missing", () => {
    const path = resolveAgenCDaemonRuntimeInfoPath(home);
    writeFileSync(path, `${JSON.stringify({ pid: 1 }, null, 2)}\n`);

    expect(readDaemonRuntimeInfo(path)).toBeNull();
  });
});
