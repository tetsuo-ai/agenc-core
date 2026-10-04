import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  compileAndLoadAgenCNativePeerCredentialBinding,
  loadAgenCNativePeerCredentialBinding,
} from "./transport/peer-credentials.js";

describe.skipIf(process.platform !== "linux")("bundled peer credentials", () => {
  const directories: string[] = [];
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-peer-bundle-"));
    directories.push(dir);
    return dir;
  };
  let template: string;
  beforeAll(() => {
    template = temp();
    compileAndLoadAgenCNativePeerCredentialBinding({ cacheDir: template });
  });
  afterAll(() => {
    for (const dir of directories) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  function fixture() {
    const dir = temp();
    cpSync(template, dir, { recursive: true });
    return { dir, addon: join(dir, "agenc-peer-credentials.node"), manifest: join(dir, "manifest.json") };
  }

  it("loads a read-only bundle without a compiler or cache write and proves the socket UID", async () => {
    const { dir, addon, manifest } = fixture();
    chmodSync(addon, 0o444);
    chmodSync(manifest, 0o444);
    chmodSync(dir, 0o555);
    const cacheDir = join(temp(), "unused");
    const compiler = vi.fn(() => { throw new Error("compiler forbidden"); });
    const result = loadAgenCNativePeerCredentialBinding({
      bundledDirectory: dir, cacheDir, execFileSync: compiler as never,
      allowRuntimeNativeBuild: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.binding?.getPeerUid(-1)).toBeNull();
    expect(compiler).not.toHaveBeenCalled();
    expect(existsSync(cacheDir)).toBe(false);
    const socketPath = join(temp(), "test.sock");
    const server = createServer();
    server.listen(socketPath);
    await once(server, "listening");
    const accepted = once(server, "connection");
    const client = createConnection(socketPath);
    try {
      const [socket] = await accepted;
      try {
        expect(result.binding?.getPeerUid(socket._handle.fd)).toBe(process.getuid?.());
      } finally { socket.destroy(); }
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["sourceHash", "platform", "arch", "modules", "artifactHash"])(
    "rejects a mismatching %s before loading", (field) => {
      const { dir, manifest } = fixture();
      const record = JSON.parse(readFileSync(manifest, "utf8"));
      record[field] = "mismatch";
      writeFileSync(manifest, JSON.stringify(record));
      expect(loadAgenCNativePeerCredentialBinding({
        bundledDirectory: dir, allowRuntimeNativeBuild: false,
      }).binding).toBeNull();
    },
  );

  it.each(["addon", "manifest", "directory"])("rejects a writable %s", (entry) => {
    const fixturePaths = fixture();
    chmodSync(entry === "directory" ? fixturePaths.dir : fixturePaths[entry], 0o777);
    expect(loadAgenCNativePeerCredentialBinding({
      bundledDirectory: fixturePaths.dir, allowRuntimeNativeBuild: false,
    }).binding).toBeNull();
  });

  it.each(["addon", "manifest", "directory"])("rejects a symlink %s", (entry) => {
    const fixturePaths = fixture();
    let dir = fixturePaths.dir;
    if (entry === "directory") {
      dir = join(temp(), "linked");
      symlinkSync(fixturePaths.dir, dir);
    } else {
      rmSync(fixturePaths[entry]);
      symlinkSync(join(template, entry === "addon" ? "agenc-peer-credentials.node" : "manifest.json"), fixturePaths[entry]);
    }
    expect(loadAgenCNativePeerCredentialBinding({ bundledDirectory: dir, allowRuntimeNativeBuild: false }).binding).toBeNull();
  });

  it("uses the existing private compiler fallback for an unloadable package artifact", () => {
    const { dir, addon, manifest } = fixture();
    writeFileSync(addon, "invalid ELF");
    const record = JSON.parse(readFileSync(manifest, "utf8"));
    record.artifactHash = createHash("sha256").update(readFileSync(addon)).digest("hex");
    writeFileSync(manifest, JSON.stringify(record));
    const compiler = vi.fn(execFileSync);
    const result = loadAgenCNativePeerCredentialBinding({ bundledDirectory: dir, cacheDir: temp(), execFileSync: compiler });
    expect(result.binding?.getPeerUid(-1)).toBeNull();
    expect(result.error).toBeUndefined();
    expect(compiler).toHaveBeenCalledOnce();
  });

  it("never falls back from an explicit system addon failure", () => {
    const compiler = vi.fn(execFileSync);
    const result = loadAgenCNativePeerCredentialBinding({
      nativeAddonPath: join(temp(), "missing.node"), requireRootOwnedNativeAddon: true,
      bundledDirectory: template, cacheDir: temp(), execFileSync: compiler,
    });
    expect(result.binding).toBeNull();
    expect(result.error).toBeDefined();
    expect(compiler).not.toHaveBeenCalled();
  });

  it("skips native loading on unsupported platforms", () => {
    const compiler = vi.fn(execFileSync);
    expect(loadAgenCNativePeerCredentialBinding({
      platform: "darwin", bundledDirectory: template, execFileSync: compiler,
    })).toEqual({ binding: null });
    expect(compiler).not.toHaveBeenCalled();
  });
});
