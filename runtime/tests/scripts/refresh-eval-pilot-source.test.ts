import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { runtimeRootPath } from "../helpers/source-path.ts";

const scriptPath = resolve(runtimeRootPath, "scripts", "refresh-eval-pilot-source.mjs");

type RefreshModule = {
  readonly DATASET_REVISION: string;
  assertFrozenSourceRowDigest(instanceId: string, digest: string): void;
  fetchJson(url: string, options?: Record<string, unknown>): Promise<unknown>;
  loadFrozenSplits(options?: Record<string, unknown>): Promise<Map<string, Map<string, unknown>>>;
  loadSplit(split: string, options?: Record<string, unknown>): Promise<Map<string, unknown>>;
  putCas(casRoot: string, bytes: Uint8Array, mediaType: string): Promise<{
    readonly digest: string;
    readonly sizeBytes: number;
  }>;
  resolveImageDigest(image: string, options?: Record<string, unknown>): Promise<string>;
};

async function loadRefreshModule(): Promise<RefreshModule> {
  return await import(pathToFileURL(scriptPath).href) as RefreshModule;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function rowsPage(instanceIds: string[], total: number, offset = 0): Response {
  return jsonResponse({
    num_rows_total: total,
    rows: instanceIds.map((instanceId, index) => ({
      row_idx: offset + index,
      row: { instance_id: instanceId },
    })),
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("evaluation pilot source refresh trust boundary", () => {
  test("accepts an idempotent matching regular CAS entry", async () => {
    const refresh = await loadRefreshModule();
    const root = await mkdtemp(join(tmpdir(), "agenc-eval-cas-match-"));
    const expected = Buffer.from("expected artifact bytes");
    try {
      const created = await refresh.putCas(root, expected, "application/octet-stream");
      const existing = await refresh.putCas(root, expected, "application/octet-stream");

      expect(existing).toEqual(created);
      expect(existing).toMatchObject({
        digest: `sha256:${sha256Hex(expected)}`,
        sizeBytes: expected.byteLength,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a same-size tampered CAS entry instead of trusting EEXIST", async () => {
    const refresh = await loadRefreshModule();
    const root = await mkdtemp(join(tmpdir(), "agenc-eval-cas-tamper-"));
    const expected = Buffer.from("expected artifact bytes");
    const tampered = Buffer.from("tampered artifact bytes");
    const digest = sha256Hex(expected);
    try {
      await mkdir(root, { recursive: true });
      expect(tampered.byteLength).toBe(expected.byteLength);
      await writeFile(join(root, digest), tampered);

      await expect(refresh.putCas(root, expected, "application/octet-stream")).rejects.toThrow(
        /existing CAS entry.*SHA-256/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a preexisting CAS directory", async () => {
    const refresh = await loadRefreshModule();
    const root = await mkdtemp(join(tmpdir(), "agenc-eval-cas-directory-"));
    const expected = Buffer.from("expected artifact bytes");
    try {
      await mkdir(join(root, sha256Hex(expected)));

      await expect(refresh.putCas(root, expected, "application/octet-stream")).rejects.toThrow(
        /existing CAS entry.*not a regular file/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects a preexisting CAS symlink even when its target has the expected bytes",
    async () => {
      const refresh = await loadRefreshModule();
      const parent = await mkdtemp(join(tmpdir(), "agenc-eval-cas-symlink-"));
      const root = join(parent, "cas");
      const target = join(parent, "target");
      const expected = Buffer.from("expected artifact bytes");
      const digest = sha256Hex(expected);
      try {
        await mkdir(root, { recursive: true });
        await writeFile(target, expected);
        await symlink(target, join(root, digest));

        await expect(refresh.putCas(root, expected, "application/octet-stream")).rejects.toThrow(
          /existing CAS entry.*symlink|too many levels of symbolic links/i,
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  test("rejects current-head rows when the canonical head is not the frozen revision", async () => {
    const refresh = await loadRefreshModule();
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse({ sha: "0".repeat(40), private: false, gated: false });
    };

    await expect(refresh.loadFrozenSplits({ fetchImpl, splitNames: ["c"] })).rejects.toThrow(
      /head does not match the frozen revision/i,
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("https://huggingface.co/api/datasets/SWE-bench-Live/MultiLang");
    expect(urls[0]).not.toContain("/revision/");
  });

  test("rejects rows when the canonical dataset head drifts during pagination", async () => {
    const refresh = await loadRefreshModule();
    let headRead = 0;
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://huggingface.co/api/datasets/")) {
        headRead += 1;
        return jsonResponse({
          sha: headRead === 1 ? refresh.DATASET_REVISION : "f".repeat(40),
          private: false,
          gated: false,
        });
      }
      return rowsPage(["task-1"], 1);
    };

    await expect(refresh.loadFrozenSplits({ fetchImpl, splitNames: ["c"] })).rejects.toThrow(
      /head does not match the frozen revision/i,
    );
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain("datasets-server.huggingface.co/rows?");
  });

  test("rejects stale viewer row bytes even while the canonical head is frozen", async () => {
    const refresh = await loadRefreshModule();
    expect(() => refresh.assertFrozenSourceRowDigest(
      "DynamoRIO__dynamorio-7561",
      `sha256:${"0".repeat(64)}`,
    )).toThrow(/row bytes do not match the frozen revision/i);
  });

  test("bounds streamed JSON bodies even without Content-Length", async () => {
    const refresh = await loadRefreshModule();
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(17));
        controller.close();
      },
    }));

    await expect(refresh.fetchJson("https://example.test/oversized", {
      fetchImpl,
      maxBodyBytes: 16,
      timeoutMs: 100,
    })).rejects.toThrow(/exceeds 16 bytes/i);
  });

  test("times out a response whose body stalls", async () => {
    const refresh = await loadRefreshModule();
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
      start() {
        // Intentionally never enqueue or close: fetchJson must abort the body read.
      },
    }));

    await expect(refresh.fetchJson("https://example.test/stalled", {
      fetchImpl,
      maxBodyBytes: 16,
      timeoutMs: 20,
    })).rejects.toThrow(/timed out after 20ms/i);
  });

  test("rejects row-count and page-count pagination amplification before another page", async () => {
    const refresh = await loadRefreshModule();
    let fetchCount = 0;
    const rowAmplificationFetch = async () => {
      fetchCount += 1;
      return rowsPage([], 10_001);
    };
    await expect(refresh.loadSplit("c", {
      fetchImpl: rowAmplificationFetch,
      maxRowsPerSplit: 10_000,
    })).rejects.toThrow(/row count exceeds/i);
    expect(fetchCount).toBe(1);

    fetchCount = 0;
    const pageAmplificationFetch = async () => {
      fetchCount += 1;
      return rowsPage(["one"], 2);
    };
    await expect(refresh.loadSplit("c", {
      fetchImpl: pageAmplificationFetch,
      rowsPerPage: 1,
      maxPagesPerSplit: 1,
    })).rejects.toThrow(/page count exceeds/i);
    expect(fetchCount).toBe(1);
  });

  test("revalidates page totals and row shape across pagination", async () => {
    const refresh = await loadRefreshModule();
    let fetchCount = 0;
    const changingTotalFetch = async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? rowsPage(["task-1"], 2)
        : rowsPage(["task-2"], 3, 1);
    };
    await expect(refresh.loadSplit("c", {
      fetchImpl: changingTotalFetch,
      rowsPerPage: 1,
    })).rejects.toThrow(/row count changed during pagination/i);

    const malformedRowFetch = async () => jsonResponse({
      num_rows_total: 1,
      rows: [{ row_idx: 7, row: { instance_id: "task-1" } }],
    });
    await expect(refresh.loadSplit("c", {
      fetchImpl: malformedRowFetch,
    })).rejects.toThrow(/invalid shape/i);
  });

  test("rejects duplicate instance IDs instead of silently overwriting them", async () => {
    const refresh = await loadRefreshModule();
    const fetchImpl = async () => rowsPage(["duplicate", "duplicate"], 2);

    await expect(refresh.loadSplit("c", { fetchImpl })).rejects.toThrow(
      /duplicate instance_id duplicate/i,
    );
  });

  test("makes docker manifest timeouts and output limits fail closed", async () => {
    const refresh = await loadRefreshModule();
    let observedOptions: Record<string, unknown> | undefined;
    const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true });
    const execFileImpl = async (
      _file: string,
      _arguments: string[],
      options: Record<string, unknown>,
    ) => {
      observedOptions = options;
      throw timeout;
    };

    await expect(refresh.resolveImageDigest("registry.example/image:tag", {
      execFileImpl,
      maxBuffer: 1_024,
      timeoutMs: 17,
    })).rejects.toThrow(/docker manifest lookup timed out after 17ms/i);
    expect(observedOptions).toMatchObject({
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 1_024,
      timeout: 17,
    });
  });
});
