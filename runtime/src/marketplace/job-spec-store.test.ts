import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveMarketplaceJobSpecReference,
  verifyMarketplaceJobSpecEnvelope,
  type MarketplaceJobSpecEnvelope,
} from "./job-spec-store.js";

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "agenc.marketplace.jobSpec",
    title: "Remote audit task",
    shortDescription: "Remote audit task",
    fullDescription: null,
    acceptanceCriteria: [],
    deliverables: [],
    constraints: null,
    attachments: [],
    custom: null,
    context: {},
    ...overrides,
  };
}

function legacyCanonicalJson(value: unknown): string {
  return JSON.stringify(legacySort(value));
}

function legacySort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacySort);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = legacySort((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function canonicalJobSpecUri(hash: string): string {
  return `agenc://job-spec/sha256/${hash}`;
}

function makeEnvelope(payload: Record<string, unknown>): {
  envelope: MarketplaceJobSpecEnvelope;
  hash: string;
} {
  const hash = sha256Hex(legacyCanonicalJson(payload));
  return {
    hash,
    envelope: {
      schemaVersion: 1,
      kind: "agenc.marketplace.jobSpecEnvelope",
      integrity: {
        algorithm: "sha256",
        canonicalization: "json-stable-v1",
        payloadHash: hash,
        uri: canonicalJobSpecUri(hash),
      },
      payload: payload as MarketplaceJobSpecEnvelope["payload"],
    },
  };
}

function remoteResponse(envelope: MarketplaceJobSpecEnvelope) {
  const body = JSON.stringify(envelope);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-length" ? String(Buffer.byteLength(body)) : null),
    },
    text: async () => body,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("marketplace job spec integrity", () => {
  it("does not fetch remote job spec URIs unless explicitly allowed", async () => {
    const { envelope, hash } = makeEnvelope(basePayload());
    const fetchSpy = vi.fn(async () => remoteResponse(envelope));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveMarketplaceJobSpecReference({
        jobSpecHash: hash,
        jobSpecUri: "https://attacker.invalid/job-spec.json",
      }),
    ).rejects.toThrow(/allowRemote=true/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves remote job spec URIs only when allowRemote is true", async () => {
    const { envelope, hash } = makeEnvelope(basePayload());
    const fetchSpy = vi.fn(async () => remoteResponse(envelope));
    vi.stubGlobal("fetch", fetchSpy);

    const resolved = await resolveMarketplaceJobSpecReference(
      {
        jobSpecHash: hash,
        jobSpecUri: "https://trusted.example/job-spec.json",
      },
      { allowRemote: true },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(resolved.jobSpecHash).toBe(hash);
    expect(resolved.payload.title).toBe("Remote audit task");
  });

  it.each([
    ["custom.__proto__", { custom: JSON.parse('{"__proto__":{"polluted":true}}') }],
    ["context.nested.constructor", { context: { nested: { constructor: { polluted: true } } } }],
    ["constraints[0].prototype", { constraints: [{ prototype: { polluted: true } }] }],
    [
      "attachments[0].__proto__",
      { attachments: [JSON.parse('{"uri":"https://example.com/spec.md","__proto__":{"polluted":true}}')] },
    ],
  ])("rejects forbidden payload keys at %s", (_label, overrides) => {
    const { envelope } = makeEnvelope(basePayload(overrides));

    expect(verifyMarketplaceJobSpecEnvelope(envelope)).toBe(false);
  });

  it("rejects a local envelope whose canonical hash omitted a forbidden key", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-job-spec-integrity-"));
    const objectsDir = join(rootDir, "objects");
    const { envelope, hash } = makeEnvelope(
      basePayload({ custom: JSON.parse('{"__proto__":{"polluted":true}}') }),
    );

    await mkdir(objectsDir, { recursive: true });
    await writeFile(join(objectsDir, `${hash}.json`), `${JSON.stringify(envelope)}\n`, "utf8");

    await expect(
      resolveMarketplaceJobSpecReference(
        { jobSpecHash: hash, jobSpecUri: canonicalJobSpecUri(hash) },
        { rootDir },
      ),
    ).rejects.toThrow(/integrity verification/);
  });

  it("rejects a remote envelope whose canonical hash omitted a forbidden key", async () => {
    const { envelope, hash } = makeEnvelope(
      basePayload({ custom: JSON.parse('{"__proto__":{"polluted":true}}') }),
    );
    const fetchSpy = vi.fn(async () => remoteResponse(envelope));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveMarketplaceJobSpecReference(
        {
          jobSpecHash: hash,
          jobSpecUri: "https://trusted.example/job-spec.json",
        },
        { allowRemote: true },
      ),
    ).rejects.toThrow(/integrity verification/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
