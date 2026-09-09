import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { sha256Digest } from "../../src/eval-contract/index.js";
import { computeOverlayManifestDigest, OverlayManifestSchema, readOverlayManifest } from "../../src/eval-executor/overlay-manifest.js";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";

const workspaces = createTempWorkspaceFixture("agenc-overlay-manifest-");
const COMPONENTS = [
  "node/bin/node", "node/compat/libatomic.so.1", "mock/serve.mjs",
  "runtime/node_modules/@tetsuo-ai/runtime/dist/bin/agenc.js",
  "runtime/node_modules/@tetsuo-ai/runtime/dist/VERSION",
  "proxy/allowlist-proxy.mjs", "proxy/eval-egress-probe.mjs",
];
afterEach(async () => { await workspaces.cleanup(); });

async function fixture(reverse = false) {
  const hostDir = await workspaces.create();
  for (const name of reverse ? [...COMPONENTS].reverse() : COMPONENTS) {
    const filePath = path.join(hostDir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${name}\n`, { mode: 0o644 });
  }
  return { hostDir };
}

describe("versioned overlay manifest", () => {
  test("records every raw file digest and is stable across locations and creation order", async () => {
    const firstOverlay = await fixture();
    const first = await readOverlayManifest(firstOverlay, { egress: true });
    const second = await readOverlayManifest(await fixture(true), { egress: true });
    expect(first).toEqual(second);
    expect(computeOverlayManifestDigest(first)).toBe(computeOverlayManifestDigest(second));
    expect(first).toMatchObject({ kind: "agenc.eval.executor-overlay-manifest", version: "1.0.0", mode: "real-provider", links: [] });
    expect(first.files).toEqual(await Promise.all([...COMPONENTS].sort().map(async (name) => ({
      path: name, digest: sha256Digest(`${name}\n`), sizeBytes: Buffer.byteLength(`${name}\n`),
      mode: (await stat(path.join(firstOverlay.hostDir, name))).mode & 0o7777,
    }))));
    const offline = await readOverlayManifest(await fixture());
    expect(offline.mode).toBe("offline");
    expect(computeOverlayManifestDigest(offline)).not.toBe(computeOverlayManifestDigest(first));
  });

  test.each(COMPONENTS)("rejects missing required file %s", async (name) => {
    const overlay = await fixture();
    await rm(path.join(overlay.hostDir, name));
    await expect(readOverlayManifest(overlay, { egress: true })).rejects.toThrow(name);
  });

  test("rejects an empty VERSION instead of fabricating a version", async () => {
    const overlay = await fixture();
    await writeFile(path.join(overlay.hostDir, "runtime/node_modules/@tetsuo-ai/runtime/dist/VERSION"), "");
    await expect(readOverlayManifest(overlay)).rejects.toThrow(/VERSION is empty/u);
  });

  test("rejects unexpected roots and non-directory root entries", async () => {
    const overlay = await fixture();
    await writeFile(path.join(overlay.hostDir, "unlisted-helper.mjs"), "unexpected");
    await expect(readOverlayManifest(overlay)).rejects.toThrow(/unexpected agent overlay/u);
    await rm(path.join(overlay.hostDir, "unlisted-helper.mjs"));
    await rm(path.join(overlay.hostDir, "proxy"), { recursive: true });
    await writeFile(path.join(overlay.hostDir, "proxy"), "not a directory");
    await expect(readOverlayManifest(overlay)).rejects.toThrow(/must be a directory/u);
  });

  test("schema rejects duplicate entries, unsafe paths, unsupported versions, and missing components", async () => {
    const manifest = await readOverlayManifest(await fixture(), { egress: true });
    for (const changed of [
      { ...manifest, files: [...manifest.files, manifest.files[0]] },
      { ...manifest, files: manifest.files.slice(1) },
      { ...manifest, version: "0.0.0" },
      { ...manifest, files: [{ ...manifest.files[0], path: "../outside" }, ...manifest.files.slice(1)] },
      { ...manifest, links: [{ path: "node/bin/extra", target: "../../../outside" }] },
    ]) expect(OverlayManifestSchema.safeParse(changed).success).toBe(false);
  });
});

describe.runIf(process.platform !== "win32")("overlay filesystem identity", () => {
  test("binds executable mode changes", async () => {
    const overlay = await fixture();
    const first = await readOverlayManifest(overlay);
    await chmod(path.join(overlay.hostDir, "node/bin/node"), 0o755);
    const changed = await readOverlayManifest(overlay);
    expect(computeOverlayManifestDigest(changed)).not.toBe(computeOverlayManifestDigest(first));
  });

  test("records internal symlinks without traversing directory aliases", async () => {
    const overlay = await fixture();
    await symlink("node", path.join(overlay.hostDir, "node/bin/node-alias"));
    await symlink("bin", path.join(overlay.hostDir, "node/bin-alias"));
    const manifest = await readOverlayManifest(overlay);
    expect(manifest.links).toEqual([
      { path: "node/bin-alias", target: "bin" }, { path: "node/bin/node-alias", target: "node" },
    ]);
    expect(manifest.files).toHaveLength(COMPONENTS.length);
    await rm(path.join(overlay.hostDir, "node/bin/node-alias"));
    await symlink("../compat/libatomic.so.1", path.join(overlay.hostDir, "node/bin/node-alias"));
    expect(computeOverlayManifestDigest(await readOverlayManifest(overlay))).not.toBe(computeOverlayManifestDigest(manifest));
  });

  test.each(["outside", "broken", "loop"])("rejects %s symlinks", async (kind) => {
    const overlay = await fixture();
    const outside = await workspaces.create();
    await writeFile(path.join(outside, "helper"), "outside");
    const linkPath = path.join(overlay.hostDir, "node/bin/extra");
    const targets = {
      outside: path.relative(path.dirname(linkPath), path.join(outside, "helper")),
      broken: "missing", loop: "extra",
    };
    await symlink(targets[kind as keyof typeof targets], linkPath);
    await expect(readOverlayManifest(overlay)).rejects.toThrow(/overlay/u);
  });

  test("rejects special files without opening a blocking FIFO", async () => {
    const overlay = await fixture();
    execFileSync("mkfifo", [path.join(overlay.hostDir, "node/bin/extra")]);
    await expect(readOverlayManifest(overlay)).rejects.toThrow(/unsupported agent overlay entry/u);
  });
});
