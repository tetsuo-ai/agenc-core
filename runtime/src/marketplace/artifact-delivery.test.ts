import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeMarketplaceArtifactSha256FromResultData,
  encodeMarketplaceArtifactResultData,
  prepareMarketplaceArtifactDelivery,
  readMarketplaceArtifactReference,
} from "./artifact-delivery.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agenc-artifact-delivery-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("marketplace artifact delivery", () => {
  it("stores a file artifact reference and commits a compact SHA-256 resultData marker", async () => {
    const rootDir = await makeTempDir();
    const artifactFile = path.join(rootDir, "delivery.md");
    const content = "# Delivery\n\nBuyer-facing report.\n";
    await writeFile(artifactFile, content, "utf8");

    const prepared = await prepareMarketplaceArtifactDelivery({
      artifactFile,
      artifactStoreDir: path.join(rootDir, "store"),
      now: new Date("2026-04-28T00:00:00.000Z"),
    });

    const sha256 = createHash("sha256").update(content).digest("hex");
    expect(prepared.reference).toMatchObject({
      uri: `agenc://artifact/sha256/${sha256}/delivery.md`,
      sha256,
      source: "file",
      fileName: "delivery.md",
      mediaType: "text/markdown; charset=utf-8",
    });
    expect(Buffer.from(prepared.proofHash).toString("hex")).toBe(sha256);
    expect(prepared.resultData).toHaveLength(64);
    expect(decodeMarketplaceArtifactSha256FromResultData(prepared.resultData)).toBe(sha256);

    const copied = await readFile(prepared.reference.localPath as string, "utf8");
    expect(copied).toBe(content);
    await expect(
      readMarketplaceArtifactReference(sha256, {
        artifactStoreDir: path.join(rootDir, "store"),
      }),
    ).resolves.toMatchObject({
      sha256,
      uri: `agenc://artifact/sha256/${sha256}/delivery.md`,
    });
  });

  it("stores a URI artifact reference when the caller supplies a digest", async () => {
    const rootDir = await makeTempDir();
    const sha256 = "ab".repeat(32);

    const prepared = await prepareMarketplaceArtifactDelivery({
      artifactUri: "ipfs://bafybeigenericdeliveryartifact",
      artifactSha256: sha256,
      artifactMediaType: "application/pdf",
      artifactStoreDir: rootDir,
    });

    expect(prepared.reference).toMatchObject({
      uri: "ipfs://bafybeigenericdeliveryartifact",
      sha256,
      source: "uri",
      mediaType: "application/pdf",
    });
    expect(decodeMarketplaceArtifactSha256FromResultData(prepared.resultData)).toBe(sha256);
  });

  it("rejects ambiguous, unsupported, and malformed artifact inputs", async () => {
    const rootDir = await makeTempDir();
    const artifactFile = path.join(rootDir, "delivery.txt");
    await writeFile(artifactFile, "delivery", "utf8");

    await expect(
      prepareMarketplaceArtifactDelivery({
        artifactFile,
        artifactUri: "ipfs://cid",
        artifactSha256: "ab".repeat(32),
      }),
    ).rejects.toThrow("exactly one");

    await expect(
      prepareMarketplaceArtifactDelivery({
        artifactUri: "file:///etc/passwd",
        artifactSha256: "ab".repeat(32),
      }),
    ).rejects.toThrow("ipfs://");

    await expect(
      prepareMarketplaceArtifactDelivery({
        artifactUri: "https://example.com/delivery.md",
      }),
    ).rejects.toThrow("artifactSha256");
  });

  it("only decodes explicit artifact resultData markers", () => {
    const sha256 = "cd".repeat(32);
    expect(
      decodeMarketplaceArtifactSha256FromResultData(
        encodeMarketplaceArtifactResultData(sha256),
      ),
    ).toBe(sha256);

    const legacyText = new Uint8Array(64);
    legacyText.set(new TextEncoder().encode("completed via cli"));
    expect(decodeMarketplaceArtifactSha256FromResultData(legacyText)).toBeNull();
  });
});
