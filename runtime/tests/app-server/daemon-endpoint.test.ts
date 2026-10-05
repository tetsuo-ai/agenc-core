import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agenCDaemonLocalEndpoint, assertAgenCUnixSocketPathLength } from "../../../packages/agenc-sdk/lib/local-endpoint.mjs";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, mkdirSync: vi.fn(fs.mkdirSync), lstatSync: vi.fn(fs.lstatSync) };
});

const itUnix = process.platform === "win32" ? it.skip : it;

describe("daemon endpoint length and private fallback", () => {
  let root: string;
  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agenc-endpoint-"));
    // Keep security failure cases isolated from the real per-user directory.
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(lstatSync).mockReturnValue({
      uid: process.getuid?.() ?? 0, mode: 0o40700,
      isDirectory: () => true, isSymbolicLink: () => false,
    } as ReturnType<typeof lstatSync>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  itUnix.each([ ["linux", 107], ["darwin", 103] ] as const)(
    "%s preserves the exact byte boundary (%s) and falls back above it",
    (platform, limit) => {
      const home = "/" + "a".repeat(limit - "/daemon.sock".length - 1);
      expect(agenCDaemonLocalEndpoint(home, platform)).toBe(join(home, "daemon.sock"));
      expect(mkdirSync).not.toHaveBeenCalled();
      const fallback = agenCDaemonLocalEndpoint(home + "a", platform);
      expect(fallback).toMatch(/^\/tmp\/agenc-\d+\/[a-f0-9]{64}\.sock$/);
      expect(Buffer.byteLength(fallback)).toBeLessThanOrEqual(limit);
      expect(fallback).toBe(agenCDaemonLocalEndpoint(home + "a", platform));
      expect(mkdirSync).toHaveBeenCalledWith(`/tmp/agenc-${process.getuid!()}`, { mode: 0o700 });
    },
  );

  itUnix("counts UTF-8 bytes, not JavaScript characters", () => {
    const home = "/" + "é".repeat(49);
    expect(join(home, "daemon.sock").length).toBeLessThan(103);
    expect(Buffer.byteLength(join(home, "daemon.sock"))).toBeGreaterThan(107);
    expect(agenCDaemonLocalEndpoint(home, "linux")).not.toBe(join(home, "daemon.sock"));
  });

  itUnix("hashes the canonical home before and after it is created", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const alias = join(root, "alias");
    symlinkSync(root, alias, "dir");
    const home = join(root, "long-home".repeat(16));
    const endpoint = agenCDaemonLocalEndpoint(home);
    expect(agenCDaemonLocalEndpoint(join(alias, "long-home".repeat(16)))).toBe(endpoint);
    fs.mkdirSync(home);
    expect(agenCDaemonLocalEndpoint(home)).toBe(endpoint);
    expect(agenCDaemonLocalEndpoint(home + "other")).not.toBe(endpoint);
  });

  itUnix.each(["symlink", "foreign owner", "public permissions", "regular file"])(
    "refuses a fallback directory with %s",
    (kind) => {
      vi.mocked(mkdirSync).mockImplementation(() => { throw Object.assign(new Error(), { code: "EEXIST" }); });
      vi.mocked(lstatSync).mockReturnValue({
        uid: process.getuid!() + (kind === "foreign owner" ? 1 : 0),
        mode: kind === "public permissions" ? 0o40755 : 0o40700,
        isDirectory: () => kind !== "regular file",
        isSymbolicLink: () => kind === "symlink",
      } as ReturnType<typeof lstatSync>);
      expect(() => agenCDaemonLocalEndpoint(join(root, "a".repeat(120))))
        .toThrow(/Refusing .*AgenC daemon socket directory/);
    },
  );

  itUnix("reports an explicit error if the fallback itself cannot fit", () => {
    // A deliberately impossible uid exercises the final guard before filesystem I/O.
    vi.spyOn(process, "getuid").mockReturnValue("1".repeat(110) as unknown as number);
    expect(() => agenCDaemonLocalEndpoint(join(root, "a".repeat(120))))
      .toThrow(/socket fallback cannot fit the platform path limit/);
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it("reports platform and byte counts for oversized explicit socket paths", () => {
    expect(() => assertAgenCUnixSocketPathLength("a".repeat(108), "linux"))
      .toThrow(/108 bytes; linux limit 107/);
    expect(() => assertAgenCUnixSocketPathLength("a".repeat(104), "darwin"))
      .toThrow(/104 bytes; darwin limit 103/);
  });
});
