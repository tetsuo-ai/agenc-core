import { describe, expect, it } from "vitest";
import {
  createAgencClient,
  type AgencDaemonMethod,
  type AgencDaemonRequest,
  type AgencDaemonResponse,
  type AgencTransport,
  type CsvJobReviewDetail,
} from "../../../packages/agenc-sdk/src/index.js";

const REVIEW: CsvJobReviewDetail = {
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

class CsvReviewTransport implements AgencTransport {
  readonly requests: AgencDaemonRequest[] = [];

  async request<Method extends AgencDaemonMethod>(
    request: AgencDaemonRequest<Method>,
  ): Promise<AgencDaemonResponse<Method>> {
    this.requests.push(request as AgencDaemonRequest);
    const result =
      request.method === "csvJob.review.list"
        ? {
            contractVersion: 1,
            job: {
              contractVersion: 1,
              jobId: "job",
              status: "needs_review",
              totalItems: 1,
              pendingItems: 0,
              runningItems: 0,
              completedItems: 0,
              failedItems: 0,
              cancelledItems: 0,
              unknownOutcomeItems: 1,
              reviewPendingItems: 1,
              resultBytes: 0,
              availableResults: 0,
              unavailableAfterReviewResults: 0,
              notProducedResults: 1,
            },
            reviews: [],
          }
        : request.method === "csvJob.review.show"
          ? { contractVersion: 1, review: REVIEW }
          : {
              contractVersion: 1,
              outcome: "resolved",
              review: { ...REVIEW, reviewStatus: "resolved" },
            };
    return {
      jsonrpc: "2.0",
      id: request.id,
      result,
    } as AgencDaemonResponse<Method>;
  }
}

describe("AgencClient CSV review operations", () => {
  it("sends all three connected methods with an absolute workspace cwd", async () => {
    const transport = new CsvReviewTransport();
    const client = createAgencClient({
      transport,
      createRequestId: (() => {
        let id = 0;
        return () => ++id;
      })(),
    });

    await client.listCsvJobReviews({ jobId: "job", limit: 10 });
    await client.showCsvJobReview({ jobId: "job", itemId: "item" });
    await client.resolveCsvJobReview({
      jobId: "job",
      itemId: "item",
      disposition: "confirmed_no_effect",
      evidenceRef: "lookup://operation-key",
      evidenceSha256: "a".repeat(64),
      reviewer: "operator",
      reason: "authoritative lookup found no effect",
    });

    expect(transport.requests.map((request) => request.method)).toEqual([
      "csvJob.review.list",
      "csvJob.review.show",
      "csvJob.review.resolve",
    ]);
    for (const request of transport.requests) {
      expect(request.params).toMatchObject({ cwd: process.cwd(), jobId: "job" });
    }
    expect(transport.requests[2]?.params).toMatchObject({
      disposition: "confirmed_no_effect",
      evidenceRef: "lookup://operation-key",
      evidenceSha256: "a".repeat(64),
      reviewer: "operator",
    });
  });
});
