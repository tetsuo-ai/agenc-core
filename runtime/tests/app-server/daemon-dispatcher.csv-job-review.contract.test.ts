import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import {
  AgenCCsvJobReviewError,
  type AgenCCsvJobReviewService,
} from "../../src/app-server/csv-job-review.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
  type CsvJobReviewDetail,
  type JsonObject,
} from "../../src/app-server/protocol/index.js";

const REVIEW_DETAIL: CsvJobReviewDetail = {
  contractVersion: 1,
  jobId: "job",
  itemId: "item",
  rowIndex: 0,
  status: "unknown_outcome",
  attemptCount: 1,
  resultAvailability: "not_produced",
  resultSizeBytes: 0,
  reviewStatus: "pending",
  createdAt: 1,
  updatedAt: 2,
};

function request(id: string, method: string, params: JsonObject): JsonObject {
  return { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

async function initializedConnection(service: AgenCCsvJobReviewService) {
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: new AgenCDaemonAgentManager(),
    csvJobReview: service,
  });
  const connection = dispatcher.createConnection();
  const initialized = await connection.dispatch(
    request("initialize", "initialize", {
      protocol: { version: "1.0.0" },
    }),
  );
  return { connection, initialized };
}

describe("CSV job review daemon dispatch", () => {
  it("advertises and routes all connected review operations", async () => {
    const service: AgenCCsvJobReviewService = {
      list: vi.fn(async () => ({
        contractVersion: 1,
        job: { jobId: "job" },
        reviews: [],
      })),
      show: vi.fn(async () => ({
        contractVersion: 1,
        review: REVIEW_DETAIL,
      })),
      resolve: vi.fn(async () => ({
        contractVersion: 1,
        outcome: "resolved",
        review: REVIEW_DETAIL,
      })),
    };
    const { connection, initialized } = await initializedConnection(service);
    expect(initialized).toMatchObject({
      result: {
        capabilities: {
          [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: {
            "csvJob.review.list": true,
            "csvJob.review.show": true,
            "csvJob.review.resolve": true,
          },
        },
      },
    });

    await expect(
      connection.dispatch(
        request("list", "csvJob.review.list", {
          cwd: process.cwd(),
          jobId: "job",
          limit: 25,
        }),
      ),
    ).resolves.toMatchObject({ result: { contractVersion: 1, reviews: [] } });
    await expect(
      connection.dispatch(
        request("show", "csvJob.review.show", {
          cwd: process.cwd(),
          jobId: "job",
          itemId: "item",
        }),
      ),
    ).resolves.toMatchObject({ result: { review: { itemId: "item" } } });
    await expect(
      connection.dispatch(
        request("resolve", "csvJob.review.resolve", {
          cwd: process.cwd(),
          jobId: "job",
          itemId: "item",
          disposition: "confirmed_no_effect",
          evidenceRef: "lookup://operation-key",
          evidenceSha256: "a".repeat(64),
          reviewer: "operator",
          reason: "authoritative lookup found no effect",
        }),
      ),
    ).resolves.toMatchObject({ result: { outcome: "resolved" } });

    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd(), jobId: "job", limit: 25 }),
      { signal: expect.any(AbortSignal) },
    );
    expect(service.show).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: process.cwd(),
        jobId: "job",
        itemId: "item",
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(service.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: process.cwd(),
        jobId: "job",
        itemId: "item",
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("does not silently create or advertise a review service", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    const initialized = await connection.dispatch(
      request("initialize", "initialize", {
        protocol: { version: "1.0.0" },
      }),
    );

    expect(initialized).toMatchObject({
      result: {
        capabilities: {
          [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: {
            "csvJob.review.list": false,
            "csvJob.review.show": false,
            "csvJob.review.resolve": false,
          },
        },
      },
    });
    await expect(
      connection.dispatch(
        request("list", "csvJob.review.list", {
          cwd: process.cwd(),
          jobId: "job",
        }),
      ),
    ).resolves.toMatchObject({
      error: { code: -32601 },
    });
  });

  it("propagates request.cancel into an in-flight resolution", async () => {
    let observedSignal: AbortSignal | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let committed = false;
    const service: AgenCCsvJobReviewService = {
      list: vi.fn(),
      show: vi.fn(),
      resolve: vi.fn(async (_params, options) => {
        observedSignal = options?.signal;
        startedResolve?.();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve();
            return;
          }
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        options?.signal?.throwIfAborted();
        committed = true;
        return {
          contractVersion: 1,
          outcome: "resolved",
          review: REVIEW_DETAIL,
        };
      }),
    };
    const { connection } = await initializedConnection(service);
    const resolution = connection.dispatch(
      request("resolve", "csvJob.review.resolve", {
        cwd: process.cwd(),
        jobId: "job",
        itemId: "item",
        disposition: "confirmed_no_effect",
        evidenceRef: "lookup://operation-key",
        evidenceSha256: "a".repeat(64),
        reviewer: "operator",
        reason: "authoritative lookup found no effect",
      }),
    );
    await started;

    await expect(
      connection.dispatch(
        request("cancel", "request.cancel", {
          requestId: "resolve",
          reason: "operator cancelled",
        }),
      ),
    ).resolves.toMatchObject({ result: { cancelled: true } });
    expect(observedSignal?.aborted).toBe(true);
    await expect(resolution).resolves.toMatchObject({
      error: {
        code: -32000,
        data: {
          code: "REQUEST_CANCELLED",
          requestId: "resolve",
          reason: "operator cancelled",
        },
      },
    });
    expect(committed).toBe(false);
  });

  it("rejects malformed evidence before service invocation", async () => {
    const resolve = vi.fn();
    const { connection } = await initializedConnection({
      list: vi.fn(),
      show: vi.fn(),
      resolve,
    } as unknown as AgenCCsvJobReviewService);

    const response = await connection.dispatch(
      request("bad", "csvJob.review.resolve", {
        cwd: process.cwd(),
        jobId: "job",
        itemId: "item",
        disposition: "confirmed_no_effect",
        evidenceRef: "lookup://operation-key",
        evidenceSha256: "NOT-A-DIGEST",
        reviewer: "operator",
        reason: "checked",
      }),
    );
    expect(response).toMatchObject({
      error: { code: -32602, data: { code: "INVALID_ARGUMENT" } },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("preserves typed service conflicts on the JSON-RPC error surface", async () => {
    const service = {
      list: vi.fn(),
      show: vi.fn(),
      resolve: vi.fn(async () => {
        throw new AgenCCsvJobReviewError(
          "CSV_REVIEW_CONFLICT",
          "different evidence already resolved this item",
        );
      }),
    } as unknown as AgenCCsvJobReviewService;
    const { connection } = await initializedConnection(service);

    const response = await connection.dispatch(
      request("conflict", "csvJob.review.resolve", {
        cwd: process.cwd(),
        jobId: "job",
        itemId: "item",
        disposition: "confirmed_no_effect",
        evidenceRef: "lookup://operation-key",
        evidenceSha256: "a".repeat(64),
        reviewer: "operator",
        reason: "checked",
      }),
    );
    expect(response).toMatchObject({
      error: { code: -32602, data: { code: "CSV_REVIEW_CONFLICT" } },
    });
  });
});
