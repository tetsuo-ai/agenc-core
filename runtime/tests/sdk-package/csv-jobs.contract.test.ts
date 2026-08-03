import { describe, expect, it } from "vitest";
import {
  CSV_AGENT_JOB_ITEM_STATUSES,
  CSV_AGENT_JOB_STATUSES,
  CSV_JOB_CONTRACT_VERSION,
  CSV_OUTPUT_CONTRACT_VERSION,
  CSV_RESULT_AVAILABILITIES,
} from "../../src/contracts/csv-job-contract.js";
import {
  AGENC_SDK_CSV_AGENT_JOB_ITEM_STATUSES,
  AGENC_SDK_CSV_AGENT_JOB_STATUSES,
  AGENC_SDK_CSV_JOB_CONTRACT_VERSION,
  AGENC_SDK_CSV_OUTPUT_CONTRACT_VERSION,
  AGENC_SDK_CSV_RESULT_AVAILABILITIES,
  type CsvAgentJobItemPage,
  type CsvAgentJobSummary,
  type CsvResultBlobChunk,
  type RunAgentsOnCsvResult,
} from "../../../packages/agenc-sdk/src/csv-jobs.js";
import type {
  CsvAgentJobItemPage as RuntimeCsvAgentJobItemPage,
  CsvAgentJobSummary as RuntimeCsvAgentJobSummary,
  CsvResultBlobChunk as RuntimeCsvResultBlobChunk,
} from "../../src/state/csv-agent-jobs.js";
import type { RunAgentsOnCsvResult as RuntimeRunAgentsOnCsvResult } from "../../src/agents/jobs/job-orchestrator.js";

describe("agenc-sdk CSV job contract mirror", () => {
  it("mirrors frozen versions and status vocabularies", () => {
    expect(AGENC_SDK_CSV_JOB_CONTRACT_VERSION).toBe(CSV_JOB_CONTRACT_VERSION);
    expect(AGENC_SDK_CSV_OUTPUT_CONTRACT_VERSION).toBe(
      CSV_OUTPUT_CONTRACT_VERSION,
    );
    expect(AGENC_SDK_CSV_AGENT_JOB_STATUSES).toEqual(CSV_AGENT_JOB_STATUSES);
    expect(AGENC_SDK_CSV_AGENT_JOB_ITEM_STATUSES).toEqual(
      CSV_AGENT_JOB_ITEM_STATUSES,
    );
    expect(AGENC_SDK_CSV_RESULT_AVAILABILITIES).toEqual(
      CSV_RESULT_AVAILABILITIES,
    );
  });

  it("keeps summary, page, blob, and bounded run results structurally aligned", () => {
    const summaryRuntimeToSdk: (
      value: RuntimeCsvAgentJobSummary,
    ) => CsvAgentJobSummary = (value) => value;
    const summarySdkToRuntime: (
      value: CsvAgentJobSummary,
    ) => RuntimeCsvAgentJobSummary = (value) => value;
    const pageRuntimeToSdk: (
      value: RuntimeCsvAgentJobItemPage,
    ) => CsvAgentJobItemPage = (value) => value;
    const pageSdkToRuntime: (
      value: CsvAgentJobItemPage,
    ) => RuntimeCsvAgentJobItemPage = (value) => value;
    const blobRuntimeToSdk: (
      value: RuntimeCsvResultBlobChunk,
    ) => CsvResultBlobChunk = (value) => value;
    const blobSdkToRuntime: (
      value: CsvResultBlobChunk,
    ) => RuntimeCsvResultBlobChunk = (value) => value;
    const runRuntimeToSdk: (
      value: RuntimeRunAgentsOnCsvResult,
    ) => RunAgentsOnCsvResult = (value) => value;
    const runSdkToRuntime: (
      value: RunAgentsOnCsvResult,
    ) => RuntimeRunAgentsOnCsvResult = (value) => value;

    expect([
      summaryRuntimeToSdk,
      summarySdkToRuntime,
      pageRuntimeToSdk,
      pageSdkToRuntime,
      blobRuntimeToSdk,
      blobSdkToRuntime,
      runRuntimeToSdk,
      runSdkToRuntime,
    ]).toHaveLength(8);
  });
});
