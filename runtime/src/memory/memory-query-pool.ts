import { basename, dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";
import { runSupervisedProcess } from "../utils/supervisedProcess.js";
import {
  MAX_MEMORY_QUERY_MS,
  MAX_MEMORY_QUERY_PROCESSES,
  MAX_MEMORY_QUERY_QUEUE,
  MAX_MEMORY_QUERY_RESULT_BYTES,
  MemoryIndexQueryResourceLimitedError,
  type MemoryRankCandidate,
} from "./full-corpus-contract.js";
import {
  decodeMemoryQueryResponseFrame,
  encodeMemoryQueryFrame,
  MEMORY_QUERY_FRAME_HEADER_BYTES,
  MEMORY_QUERY_HELPER_PROTOCOL_VERSION,
  type MemoryQueryHelperRequest,
} from "./full-corpus-protocol.js";

interface WaitingQuerySlot {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

const waitingQuerySlots: WaitingQuerySlot[] = [];
let activeQueryProcesses = 0;

export interface MemoryQueryProcessPoolOptions {
  readonly helperEntrypoint?: string;
  readonly timeoutMs?: number;
}

export class MemoryQueryProcessPool {
  readonly #helperEntrypoint: string;
  readonly #timeoutMs: number;

  constructor(options: MemoryQueryProcessPoolOptions = {}) {
    this.#helperEntrypoint =
      options.helperEntrypoint ?? resolveDefaultMemoryQueryHelperEntrypoint();
    this.#timeoutMs = options.timeoutMs ?? MAX_MEMORY_QUERY_MS;
  }

  async query(
    request: Omit<MemoryQueryHelperRequest, "protocolVersion">,
    signal: AbortSignal,
  ): Promise<readonly MemoryRankCandidate[]> {
    throwIfAborted(signal);
    const release = await acquireQuerySlot(signal);
    try {
      return await this.#runQuery(request, signal);
    } finally {
      release();
    }
  }

  async #runQuery(
    request: Omit<MemoryQueryHelperRequest, "protocolVersion">,
    signal: AbortSignal,
  ): Promise<readonly MemoryRankCandidate[]> {
    const frame = encodeMemoryQueryFrame({
      ...request,
      protocolVersion: MEMORY_QUERY_HELPER_PROTOCOL_VERSION,
    });
    const result = await runSupervisedProcess(
      {
        program: process.execPath,
        args: [this.#helperEntrypoint],
        cwd: dirname(this.#helperEntrypoint),
        env: scrubEnvForChildProcess(process.env),
      },
      {
        stdin: frame,
        signal,
        timeoutMs: this.#timeoutMs,
        maxOutputBytes:
          MAX_MEMORY_QUERY_RESULT_BYTES + MEMORY_QUERY_FRAME_HEADER_BYTES,
        terminateGraceMs: 100,
        settleBackstopMs: 1_000,
      },
    );
    throwIfAborted(signal);
    if (
      result.stopReason === "timeout" ||
      result.stopReason === "output_limit" ||
      result.stopReason === "consumer_limit" ||
      result.backstopExpired
    ) {
      throw new MemoryIndexQueryResourceLimitedError(
        `memory query helper crossed ${result.stopReason ?? "settlement"} limit`,
      );
    }
    if (result.error !== undefined) throw result.error;
    let response;
    try {
      response = decodeMemoryQueryResponseFrame(result.stdout);
    } catch (error) {
      throw new MemoryIndexQueryResourceLimitedError(
        `memory query helper returned an invalid bounded frame: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (response.kind === "error") {
      if (response.code === "query_resource_limited") {
        throw new MemoryIndexQueryResourceLimitedError(response.message);
      }
      throw new Error(`${response.code}: ${response.message}`);
    }
    if (
      response.candidates.some(
        (candidate) =>
          candidate.rootId !== request.rootId ||
          candidate.generationId !== request.generationId ||
          candidate.rootRole !== request.rootRole,
      )
    ) {
      throw new MemoryIndexQueryResourceLimitedError(
        "memory query helper returned a candidate outside its bound generation",
      );
    }
    return response.candidates;
  }
}

export function resolveDefaultMemoryQueryHelperEntrypoint(
  moduleUrl: string = import.meta.url,
): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  if (basename(moduleDirectory) === "dist") {
    return join(moduleDirectory, "memory", "memory-query-helper.js");
  }
  if (basename(dirname(moduleDirectory)) === "dist") {
    return join(dirname(moduleDirectory), "memory", "memory-query-helper.js");
  }
  const candidates = [
    join(moduleDirectory, "memory-query-helper.js"),
    join(moduleDirectory, "memory-query-helper.mjs"),
    join(moduleDirectory, "memory", "memory-query-helper.js"),
    resolve(moduleDirectory, "../memory/memory-query-helper.js"),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

async function acquireQuerySlot(signal: AbortSignal): Promise<() => void> {
  throwIfAborted(signal);
  if (activeQueryProcesses < MAX_MEMORY_QUERY_PROCESSES) {
    activeQueryProcesses += 1;
    return releaseQuerySlot;
  }
  if (waitingQuerySlots.length >= MAX_MEMORY_QUERY_QUEUE) {
    throw new MemoryIndexQueryResourceLimitedError(
      "memory query helper queue is full",
    );
  }
  return await new Promise<() => void>((resolve, reject) => {
    const waiter: WaitingQuerySlot = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = waitingQuerySlots.indexOf(waiter);
        if (index >= 0) waitingQuerySlots.splice(index, 1);
        reject(abortReason(signal));
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    waitingQuerySlots.push(waiter);
    if (signal.aborted) waiter.onAbort();
  });
}

function releaseQuerySlot(): void {
  activeQueryProcesses -= 1;
  while (waitingQuerySlots.length > 0) {
    const waiter = waitingQuerySlots.shift()!;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal.aborted) {
      waiter.reject(abortReason(waiter.signal));
      continue;
    }
    activeQueryProcesses += 1;
    waiter.resolve(releaseQuerySlot);
    return;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("Memory query aborted", "AbortError")
  );
}
