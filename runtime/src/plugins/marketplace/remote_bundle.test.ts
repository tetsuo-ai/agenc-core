import { gzipSync } from "node:zlib";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkedTarOutputPath,
  downloadAndInstallRemotePluginBundle,
  extractPluginBundleTarGz,
  installRemotePluginBundle,
  readInstalledRemotePluginManifest,
  remotePluginInstallRoot,
  validateRemotePluginBundle,
} from "./remote_bundle.js";
import type { FetchResponse, Fetcher } from "./marketplace.js";

describe("remote plugin bundles", () => {
  it("validates remote bundle metadata and only permits secure download URLs", () => {
    const bundle = validateRemotePluginBundle(
      "linear",
      "agenc-global",
      "linear",
      "1.0.0",
      "https://agenc.tech/plugins/linear.tgz",
    );
    expect(bundle).toMatchObject({
      pluginId: "linear@agenc-global",
      marketplaceName: "agenc-global",
      pluginVersion: "1.0.0",
    });
    expect(() =>
      validateRemotePluginBundle("linear", "agenc-global", "linear", "1.0.0", "http://agenc.tech/linear.tgz"),
    ).toThrow("unsupported download URL scheme");
    expect(() =>
      validateRemotePluginBundle("linear", "agenc-global", "linear", "../1.0.0", "https://agenc.tech/linear.tgz"),
    ).toThrow("invalid remote plugin release version");
    expect(() =>
      validateRemotePluginBundle("linear", "agenc-global", "../linear", "1.0.0", "https://agenc.tech/linear.tgz"),
    ).toThrow("invalid local plugin id");
    expect(() =>
      validateRemotePluginBundle("linear", "../agenc-global", "linear", "1.0.0", "https://agenc.tech/linear.tgz"),
    ).toThrow("invalid local plugin id");
    expect(validateRemotePluginBundle(
      "linear",
      "agenc-global",
      "linear",
      "1.0.0",
      "http://127.0.0.1/linear.tgz",
      { allowLoopbackHttp: true },
    ).bundleDownloadUrl).toBe("http://127.0.0.1/linear.tgz");
  });

  it("extracts a nested plugin root into the versioned cache location", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-bundle-"));
    const bundle = validateRemotePluginBundle(
      "linear",
      "agenc-global",
      "linear",
      "1.0.0",
      "https://agenc.tech/plugins/linear.tgz",
    );
    const bytes = createTarGz({
      "linear/.agenc-plugin/plugin.json": JSON.stringify({
        name: "linear",
        version: "1.0.0",
        description: "Remote plugin",
        commands: "./commands",
      }),
      "linear/commands/hello.md": "# Hello\n",
    });

    const result = await installRemotePluginBundle(agencHome, bundle, bytes);

    expect(result).toEqual({
      pluginId: "linear@agenc-global",
      installedPath: remotePluginInstallRoot(agencHome, bundle),
      version: "1.0.0",
    });
    await expect(readFile(join(result.installedPath, "commands", "hello.md"), "utf8"))
      .resolves.toBe("# Hello\n");
    await expect(readInstalledRemotePluginManifest(result.installedPath))
      .resolves.toMatchObject({ name: "linear", version: "1.0.0" });
  });

  it("rejects hostile tar paths before writing outside extraction root", async () => {
    const destination = await mkdtemp(join(tmpdir(), "agenc-remote-extract-"));
    expect(() => checkedTarOutputPath(destination, "../escape.txt")).toThrow("escapes extraction root");
    await expect(extractPluginBundleTarGz(createTarGz({ "../escape.txt": "x" }), destination))
      .rejects.toThrow("escapes extraction root");
  });

  it("rejects bundles whose manifest identity does not match remote metadata", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-bundle-mismatch-"));
    const bundle = validateRemotePluginBundle(
      "linear",
      "agenc-global",
      "linear",
      "1.0.0",
      "https://agenc.tech/plugins/linear.tgz",
    );
    const bytes = createTarGz({
      "other/.agenc-plugin/plugin.json": JSON.stringify({
        name: "other",
        version: "1.0.0",
        description: "Remote plugin",
        commands: "./commands",
      }),
    });

    await expect(installRemotePluginBundle(agencHome, bundle, bytes))
      .rejects.toThrow("manifest name mismatch");
  });

  it("redacts signed bundle URL query strings in download errors", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-bundle-redact-"));
    const bundle = validateRemotePluginBundle(
      "linear",
      "agenc-global",
      "linear",
      "1.0.0",
      "https://agenc.tech/plugins/linear.tgz?token=secret",
    );

    await expect(downloadAndInstallRemotePluginBundle(
      agencHome,
      bundle,
      async () => ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "denied",
        arrayBuffer: async () => exactArrayBuffer(Buffer.from("denied", "utf8")),
      }),
    )).rejects.toThrow("https://agenc.tech/plugins/linear.tgz?<redacted>");
  });

  it("revalidates forged bundle download URLs at the download boundary", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-bundle-forged-"));
    const forged = {
      pluginId: "linear@agenc-global",
      marketplaceName: "agenc-global",
      pluginName: "linear",
      pluginVersion: "1.0.0",
      bundleDownloadUrl: "http://agenc.tech/plugins/linear.tgz",
    };

    await expect(downloadAndInstallRemotePluginBundle(
      agencHome,
      forged,
      async () => {
        throw new Error("fetch should not run for forged bundle URLs");
      },
    )).rejects.toThrow("must use HTTPS");
  });

  it("does not trust forged loopback bundle URLs without explicit validation state", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-bundle-forged-loopback-"));
    const forged = {
      pluginId: "linear@agenc-global",
      marketplaceName: "agenc-global",
      pluginName: "linear",
      pluginVersion: "1.0.0",
      bundleDownloadUrl: "http://127.0.0.1/linear.tgz",
    };

    await expect(downloadAndInstallRemotePluginBundle(
      agencHome,
      forged,
      async () => {
        throw new Error("fetch should not run for forged loopback bundle URLs");
      },
    )).rejects.toThrow("must use HTTPS");
  });

  it("reports invalid bundle download URL strings with remote plugin context", () => {
    expect(() =>
      validateRemotePluginBundle("linear", "agenc-global", "linear", "1.0.0", "not a url"),
    ).toThrow("invalid download URL for remote plugin 'linear'");
  });

  it("rejects oversized streamed bundle downloads before extraction", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-bundle-large-"));
    const bundle = validateRemotePluginBundle(
      "linear",
      "agenc-global",
      "linear",
      "1.0.0",
      "https://agenc.tech/plugins/linear.tgz",
    );

    await expect(downloadAndInstallRemotePluginBundle(
      agencHome,
      bundle,
      oversizedBundleFetcher(),
    )).rejects.toThrow("exceeded maximum size");
  });

  it("caps decompressed bundle size before walking tar entries", async () => {
    const destination = await mkdtemp(join(tmpdir(), "agenc-remote-extract-small-limit-"));
    await expect(extractPluginBundleTarGz(createTarGz({ "linear/file.txt": "hello" }), destination, 4))
      .rejects.toThrow(/decompressed|extracted size/u);
  });

  it("caps tar entry counts before excessive filesystem writes", async () => {
    const destination = await mkdtemp(join(tmpdir(), "agenc-remote-extract-entry-limit-"));
    await expect(extractPluginBundleTarGz(createTarGz({
      "linear/one.txt": "",
      "linear/two.txt": "",
    }), destination, undefined, 1)).rejects.toThrow("too many entries");
  });

  it("rejects truncated or corrupt tar members before writing files", async () => {
    const truncatedDestination = await mkdtemp(join(tmpdir(), "agenc-remote-extract-truncated-"));
    await expect(extractPluginBundleTarGz(createTruncatedTarGz(), truncatedDestination))
      .rejects.toThrow("is truncated");

    const corruptDestination = await mkdtemp(join(tmpdir(), "agenc-remote-extract-corrupt-"));
    await expect(extractPluginBundleTarGz(createChecksumCorruptTarGz(), corruptDestination))
      .rejects.toThrow("invalid checksum");
  });
});

function createTarGz(files: Readonly<Record<string, string>>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, "utf8");
    chunks.push(createTarHeader(name, body.length), body, Buffer.alloc(padding(body.length)));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function createTruncatedTarGz(): Buffer {
  const body = Buffer.from("hello", "utf8");
  return gzipSync(Buffer.concat([
    createTarHeader("linear/file.txt", body.length + 10),
    body,
  ]));
}

function createChecksumCorruptTarGz(): Buffer {
  const body = Buffer.from("x", "utf8");
  const header = createTarHeader("linear/file.txt", body.length);
  header[0] = "X".charCodeAt(0);
  return gzipSync(Buffer.concat([
    header,
    body,
    Buffer.alloc(padding(body.length)),
    Buffer.alloc(1024),
  ]));
}

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value.slice(0, length), offset, length, "utf8");
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeTarString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function padding(size: number): number {
  return (512 - (size % 512)) % 512;
}

function exactArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function oversizedBundleFetcher(): Fetcher {
  return async () => {
    let chunks = 0;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks += 1;
          if (chunks > 51) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    } satisfies FetchResponse;
  };
}
