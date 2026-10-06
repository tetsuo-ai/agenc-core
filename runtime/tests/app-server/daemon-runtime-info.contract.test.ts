import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENC_DAEMON_RUNTIME_INFO_MAX_BYTES,
  readDaemonRuntimeInfo,
  removeDaemonRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
  writeDaemonRuntimeInfo,
} from "../../src/app-server/daemon-runtime-info.js";

const BASE_INFO = {
  pid: 4242,
  instanceId: "instance-4242",
  processStart: "test-process:4242:start",
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

  it("round-trips the bound local endpoint and websocket url", () => {
    const path = resolveAgenCDaemonRuntimeInfoPath(home);
    writeDaemonRuntimeInfo(path, {
      ...BASE_INFO,
      webSocketUrl: "ws://127.0.0.1:40117/",
      socketPath: "/tmp/agenc-1000/fallback.sock",
    });

    expect(readDaemonRuntimeInfo(path)).toEqual({
      ...BASE_INFO,
      webSocketUrl: "ws://127.0.0.1:40117/",
      socketPath: "/tmp/agenc-1000/fallback.sock",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((entry) => entry.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("does not remove a sidecar claimed by another daemon instance", () => {
    const path = resolveAgenCDaemonRuntimeInfoPath(home);
    writeDaemonRuntimeInfo(path, BASE_INFO);

    removeDaemonRuntimeInfo(path, "different-instance");
    expect(readDaemonRuntimeInfo(path)).toEqual(BASE_INFO);

    removeDaemonRuntimeInfo(path, BASE_INFO.instanceId);
    expect(readDaemonRuntimeInfo(path)).toBeNull();
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

  it.each([1, 1.5, -42, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a non-canonical daemon pid %s",
    (pid) => {
      const path = resolveAgenCDaemonRuntimeInfoPath(home);
      writeFileSync(path, `${JSON.stringify({ ...BASE_INFO, pid })}\n`);
      expect(readDaemonRuntimeInfo(path)).toBeNull();
    },
  );

  it("rejects an oversized identity sidecar without parsing its prefix", () => {
    const path = resolveAgenCDaemonRuntimeInfoPath(home);
    writeFileSync(path, "{".repeat(AGENC_DAEMON_RUNTIME_INFO_MAX_BYTES + 1));
    expect(readDaemonRuntimeInfo(path)).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked identity sidecar",
    () => {
      const target = join(home, "sidecar-target.json");
      const path = resolveAgenCDaemonRuntimeInfoPath(home);
      writeFileSync(target, `${JSON.stringify(BASE_INFO)}\n`);
      symlinkSync(target, path);
      expect(readDaemonRuntimeInfo(path)).toBeNull();
    },
  );
});
