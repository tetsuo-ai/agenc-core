import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pluginSignaturePayloadBytes,
  resolvePluginSource,
  verifyResolvedPluginSignature,
} from "../../src/plugins/resolution.js";
import * as publisherTrust from "../../src/plugins/publisher-trust.js";

const publisher = "tetsuo-ai";
const oldKey = generateKeyPairSync("ed25519");
const newKey = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const encode = (key: KeyObject) => key.export({ format: "der", type: "spki" }).toString("base64");
const oldPublic = encode(oldKey.publicKey);
const newPublic = encode(newKey.publicKey);
const payload = "# Signed fixture\n";
let root: string;

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

async function writeSignedPlugin(path: string, key: KeyObject, identity = publisher): Promise<void> {
  await mkdir(join(path, ".agenc-plugin"), { recursive: true });
  await mkdir(join(path, "commands"), { recursive: true });
  const manifest = Buffer.from(JSON.stringify({ name: "signed-fixture", version: "1.0.0" }));
  await writeFile(join(path, ".agenc-plugin", "plugin.json"), manifest);
  await writeFile(join(path, "commands", "hello.md"), payload);
  const files = { "commands/hello.md": `sha256:${createHash("sha256").update(payload).digest("hex")}` };
  await writeJson(join(path, ".agenc-plugin", "signature.json"), {
    publisher: identity,
    signature: sign(null, pluginSignaturePayloadBytes(manifest, files), key).toString("base64"),
    files,
  });
}

async function writeEntry(entry: unknown): Promise<void> {
  await writeJson(join(root, "plugin-publishers.json"), { publishers: { [publisher]: entry } });
}

function verify(name = "old", publishersPath?: string) {
  return verifyResolvedPluginSignature(join(root, name), {
    agencHome: root, requireSignature: true,
    ...(publishersPath === undefined ? {} : { publishersPath }),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-publisher-rollover-"));
  await writeSignedPlugin(join(root, "old"), oldKey.privateKey);
  await writeSignedPlugin(join(root, "new"), newKey.privateKey);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("publisher key rollover", () => {
  it.each(["string", "object"])("keeps the legacy %s pin old-only", async (shape) => {
    await writeEntry(shape === "string" ? oldPublic : { publicKey: oldPublic });
    await expect(verify("old")).resolves.toMatchObject({ verified: true });
    await expect(verify("new")).rejects.toThrow(/signature verification failed/u);
  });

  it("accepts real old and new signatures under a deduplicated overlap entry", async () => {
    await writeEntry({ publicKey: oldPublic, publicKeys: [oldPublic, newPublic, newPublic] });
    await expect(verify("old")).resolves.toMatchObject({ verified: true });
    await expect(verify("new")).resolves.toMatchObject({ verified: true });
    await writeSignedPlugin(join(root, "unknown"), otherKey.privateKey);
    await expect(verify("unknown")).rejects.toThrow(/signature verification failed/u);
  });

  it("unions a legacy key with a new-only list and supports list-only entries", async () => {
    await writeEntry({ publicKey: oldPublic, publicKeys: [newPublic] });
    await expect(verify("old")).resolves.toMatchObject({ verified: true });
    await expect(verify("new")).resolves.toMatchObject({ verified: true });
    await writeEntry({ publicKeys: [oldPublic, newPublic] });
    await expect(verify("old")).resolves.toMatchObject({ verified: true });
    await expect(verify("new")).resolves.toMatchObject({ verified: true });
  });

  it("uses overlapping built-ins only when no explicit operator entry exists", async () => {
    const builtIns = vi.spyOn(publisherTrust, "builtInPluginPublisherPublicKeys")
      .mockImplementation((name) => name === publisher ? [oldPublic, newPublic] : undefined);
    await expect(verify("old")).resolves.toMatchObject({ verified: true });
    await expect(verify("new")).resolves.toMatchObject({ verified: true });
    await writeJson(join(root, "plugin-publishers.json"), { publishers: { unrelated: oldPublic } });
    await expect(verify("new")).resolves.toMatchObject({ verified: true });
    await writeEntry({ publicKey: oldPublic });
    await expect(verify("new")).rejects.toThrow(/signature verification failed/u);
    await expect(verify("old")).resolves.toMatchObject({ verified: true });
    builtIns.mockClear();
    await expect(verify("new", join(root, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(builtIns).not.toHaveBeenCalled();
    await writeJson(join(root, "explicit.json"), { publishers: {} });
    await expect(verify("new", join(root, "explicit.json"))).rejects.toThrow(/not trusted/u);
  });

  const malformedEntries: Array<[string, unknown]> = [
    ["null", null], ["empty string", ""], ["empty object", {}], ["array entry", []],
    ["empty list", { publicKeys: [] }], ["non-array list", { publicKeys: oldPublic }],
    ["null list", { publicKey: oldPublic, publicKeys: null }],
    ["invalid legacy key alongside valid list", { publicKey: "invalid", publicKeys: [oldPublic] }],
    ["invalid list member after valid key", { publicKeys: [oldPublic, "invalid"] }],
    ["numeric member", { publicKeys: [oldPublic, 1] }],
    ["null member", { publicKeys: [oldPublic, null] }],
    ["oversized list", { publicKeys: Array(17).fill(oldPublic) }],
    ["noncanonical base64", { publicKey: `${oldPublic.slice(0, -1)} ` }],
    ["X25519 key", { publicKeys: [oldPublic, encode(generateKeyPairSync("x25519").publicKey)] }],
  ];
  it.each(malformedEntries)("rejects %s without falling back or partially trusting", async (_label, entry) => {
    vi.spyOn(publisherTrust, "builtInPluginPublisherPublicKeys").mockReturnValue([oldPublic, newPublic]);
    await writeEntry(entry);
    await expect(verify()).rejects.toThrow(/plugin publisher is not trusted/u);
  });

  it("limits the union to sixteen distinct keys", async () => {
    const keys = Array.from({ length: 15 }, () => encode(generateKeyPairSync("ed25519").publicKey));
    await writeEntry({ publicKey: oldPublic, publicKeys: [oldPublic, ...keys] });
    await expect(verify()).resolves.toMatchObject({ verified: true });
    await writeEntry({ publicKey: oldPublic, publicKeys: [newPublic, ...keys] });
    await expect(verify()).rejects.toThrow(/not trusted/u);
  });

  it.each([null, [], { publishers: null }, { publishers: [] }])(
    "rejects malformed keyring structure without built-in fallback: %j",
    async (keyring) => {
      vi.spyOn(publisherTrust, "builtInPluginPublisherPublicKeys").mockReturnValue([oldPublic, newPublic]);
      await writeJson(join(root, "plugin-publishers.json"), keyring);
      await expect(verify()).rejects.toThrow(/keyring must contain a publishers object/u);
    },
  );

  it("does not grant an unrelated publisher the official trust set", async () => {
    await writeSignedPlugin(join(root, "other-publisher"), oldKey.privateKey, "unrelated");
    await writeEntry({ publicKeys: [oldPublic, newPublic] });
    await expect(verify("other-publisher")).rejects.toThrow(/not trusted/u);
    await writeJson(join(root, "plugin-publishers.json"), {
      publishers: { unrelated: { publicKeys: [oldPublic] } },
    });
    await expect(verify("other-publisher")).resolves.toMatchObject({ verified: true });
  });

  it("rechecks old cached signatures after rollover and rejects cached payload tampering", async () => {
    await writeEntry({ publicKey: oldPublic });
    const runProcess = vi.fn(async (_command: string, args: readonly string[]) => {
      await writeSignedPlugin(String(args.at(-1)), oldKey.privateKey);
      return { stdout: "", stderr: "" };
    });
    const options = {
      agencHome: root, workspaceRoot: root,
      pluginStorageRoot: join(root, "plugins"), sessionTempRoot: join(root, "tmp"),
      runProcess,
    };
    const source = "git@github.com:tetsuo-ai/key-rollover-fixture.git";
    const original = await resolvePluginSource(source, options);
    await original.cleanup();
    await writeEntry({ publicKey: oldPublic, publicKeys: [oldPublic, newPublic] });
    const cached = await resolvePluginSource(source, options);
    expect(cached.signature?.verified).toBe(true);
    expect(cached.pluginRoot).toBe(original.pluginRoot);
    expect(runProcess).toHaveBeenCalledTimes(1);
    await cached.cleanup();
    // Removing a key is also an explicit trust decision. The cache must not
    // retain the earlier successful verification as permanent authority.
    await writeEntry({ publicKeys: [newPublic] });
    await expect(resolvePluginSource(source, options)).rejects.toThrow(/signature verification failed/u);
    expect(runProcess).toHaveBeenCalledTimes(1);
    await writeEntry({ publicKeys: [oldPublic, newPublic] });
    await writeFile(join(cached.pluginRoot, "commands", "hello.md"), "tampered");
    await expect(resolvePluginSource(source, options)).rejects.toThrow(/digest mismatch/u);
    expect(runProcess).toHaveBeenCalledTimes(1);
    await writeSignedPlugin(cached.pluginRoot, oldKey.privateKey);
    const signaturePath = join(cached.pluginRoot, ".agenc-plugin", "signature.json");
    const signature = JSON.parse(await readFile(signaturePath, "utf8"));
    signature.signature = Buffer.alloc(64).toString("base64");
    await writeJson(signaturePath, signature);
    await expect(resolvePluginSource(source, options)).rejects.toThrow(/signature verification failed/u);
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it("rejects current payload and manifest tampering with overlapping trust", async () => {
    await writeEntry({ publicKeys: [oldPublic, newPublic] });
    await writeFile(join(root, "new", "commands", "hello.md"), "tampered");
    await expect(verify("new")).rejects.toThrow(/digest mismatch/u);
    await writeSignedPlugin(join(root, "new"), newKey.privateKey);
    await writeJson(join(root, "new", ".agenc-plugin", "plugin.json"), { name: "tampered" });
    await expect(verify("new")).rejects.toThrow(/signature verification failed/u);
  });
});
