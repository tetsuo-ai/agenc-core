import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { runtimeRootPath } from "../helpers/source-path.ts";

const scriptPath = resolve(runtimeRootPath, "scripts", "refresh-eval-pilot-source.mjs");

type RefreshModule = {
  readonly DATASET_REVISION: string;
  fetchJson(url: string, options?: Record<string, unknown>): Promise<unknown>;
  loadFrozenSplits(options?: Record<string, unknown>): Promise<Map<string, Map<string, unknown>>>;
  loadSplit(split: string, options?: Record<string, unknown>): Promise<Map<string, unknown>>;
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

describe("evaluation pilot source refresh trust boundary", () => {
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
