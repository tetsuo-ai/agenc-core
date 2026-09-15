import { setTimeout as delay } from "node:timers/promises";
import type { FileHandle } from "node:fs/promises";
import type { WorkspaceBoundReadCapability, WorkspaceBoundRipgrepResult, WorkspaceBoundProcessStopReason } from "../workspace/file-mutation-transaction.js";
import { createStructuredRipgrepLimiter } from "../workspace/structured-ripgrep-limiter.js";
import { prepareAdmittedExecutionOperation } from "./call-context.js";
import { openControllerOutputSpool } from "./controller-output-spool.js";
import type { DockerExecutionProcesses, DockerTaskFileBindings } from "./docker-process.js";
import { ExecutionEnvironmentError, type ExecutionProcess } from "./types.js";

export type BoundRipgrepInput = Parameters<WorkspaceBoundReadCapability["runRipgrep"]>[0];
const CHUNK_BYTES = 65536;
function invalid(message: string): never {
  throw new ExecutionEnvironmentError("invalid_request", message, false);
}

/** Task programs run in a managed command scope; only deterministic parsing runs here. */
export async function runDockerBoundRipgrep(owner: DockerExecutionProcesses, cwd: string,
  bindings: DockerTaskFileBindings, input: BoundRipgrepInput): Promise<WorkspaceBoundRipgrepResult> {
  if (!bindings.cwd || typeof input.program !== "string" || !input.program || input.program.includes("\0") ||
      !Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string" || arg.includes("\0") ||
        arg === "--follow" || (/^-[^-]/.test(arg) && arg.includes("L"))) ||
      !input.env || typeof input.env !== "object" || Array.isArray(input.env) ||
      Object.entries(input.env).some(([name, value]) => !name || name.includes("=") || name.includes("\0") ||
        typeof value !== "string" || value.includes("\0")) ||
      (input.argv0 !== undefined && (typeof input.argv0 !== "string" || !input.argv0 || input.argv0.includes("\0")))) {
    invalid("Invalid bound ripgrep command");
  }
  for (const value of [input.timeoutMs, input.maxOutputBytes, input.lineLimit ?? 1]) {
    if (!Number.isSafeInteger(value) || value < 1) invalid("Invalid bound ripgrep limit");
  }
  if (input.timeoutMs > 2147483647) invalid("Ripgrep timeout exceeds the timer bound");
  if (input.stdin !== undefined && typeof input.stdin !== "string" && !Buffer.isBuffer(input.stdin)) invalid("Invalid ripgrep input bytes");
  if (bindings.stdin && input.stdin !== undefined) invalid("Bound file input and supplied input bytes are mutually exclusive");
  const limiter = createStructuredRipgrepLimiter(input.structuredLineLimit, "linux");
  if (input.stdoutSpoolPath !== undefined && (limiter !== null || input.lineLimit !== undefined ||
      !Number.isSafeInteger(input.maxSpoolBytes) || input.maxSpoolBytes! < 1)) invalid("Invalid private stdout spool limits");
  input = { ...input };
  bindings = { cwd: { ...bindings.cwd }, ...(bindings.stdin === undefined ? {} : { stdin: { ...bindings.stdin } }) };

  // Snapshot mutable inputs before the first asynchronous boundary. Neither
  // control data nor the controller environment enters the task input stream.
  const bytes = input.stdin === undefined ? Buffer.alloc(0) : Buffer.from(input.stdin);
  const specification = { program: input.program, argv: [...input.args], environment: { ...input.env },
    cwd, terminal: false, lifetime: "operation" as const,
    ...(input.argv0 === undefined ? {} : { argv0: input.argv0 }) };
  const dispatch = prepareAdmittedExecutionOperation();
  const signal = input.signal === undefined ? dispatch.signal : AbortSignal.any([input.signal, dispatch.signal]);
  if (signal.aborted) throw new ExecutionEnvironmentError("aborted", "Bound search was cancelled before dispatch", false);
  let process: ExecutionProcess | undefined;
  let spool: FileHandle | undefined;
  let stop: Promise<void> | undefined;
  let stopError: unknown;
  let stopReason: WorkspaceBoundProcessStopReason | undefined;
  let inputError: unknown;
  let inputDone = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let spawnError: Error | undefined;
  let killedAfterLimit = false;
  let capturedBytes = 0, totalOutputBytes = 0, stdoutLines = 0, spooledBytes = 0;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const requestStop = (reason?: WorkspaceBoundProcessStopReason): void => {
    if (stop !== undefined) return;
    stopReason = reason;
    stop = process!.terminate().then(() => {}, (error: unknown) => { stopError = error; });
  };
  const abort = (): void => { requestStop("aborted"); };
  const capture = (parts: Buffer[], chunk: Buffer): void => {
    const retained = chunk.subarray(0, Math.max(0, input.maxOutputBytes - capturedBytes));
    if (retained.length) { parts.push(retained); capturedBytes += retained.length; }
  };
  const began = Date.now();
  try {
    if (input.stdoutSpoolPath !== undefined) spool = await openControllerOutputSpool(input.stdoutSpoolPath);
    process = await owner.launch(specification, dispatch.identity, { ...dispatch, signal }, bindings);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(() => requestStop("timeout"), Math.max(1, input.timeoutMs - (Date.now() - began)));
    if (!bindings.stdin && stop === undefined) {
      inputDone = (async () => {
        // Input and output progress independently so a program can write before
        // it reads. Every chunk/EOF has its own original acknowledgement key.
        for (let offset = 0;; offset += CHUNK_BYTES) {
          if (stop !== undefined) return;
          const part = bytes.subarray(offset, offset + CHUNK_BYTES);
          const eof = offset + part.length === bytes.length;
          const inputDispatch = prepareAdmittedExecutionOperation();
          try { await process!.write(inputDispatch.identity, part, eof, { ...inputDispatch, signal }); }
          catch (error) {
            // An acknowledged closed input has no uncertain send to repeat.
            if (error instanceof ExecutionEnvironmentError && error.code === "stdin_closed") return;
            throw error;
          }
          if (eof) return;
        }
      })().catch((error: unknown) => { inputError = error; requestStop(); });
    }

    let cursor = 0;
    for (;;) {
      if (stopError !== undefined) throw stopError;
      const receipt = await process.inspect();
      const chunk = await process.output(cursor, CHUNK_BYTES);
      cursor = chunk.nextOffset;
      if (stop === undefined) {
        totalOutputBytes += chunk.stderr.length + (spool === undefined ? chunk.stdout.length : 0);
        capture(stderr, chunk.stderr);
        if (totalOutputBytes > input.maxOutputBytes) requestStop("output_limit");
        else if (spool !== undefined) {
          if (spooledBytes + chunk.stdout.length > input.maxSpoolBytes!) requestStop("output_limit");
          else {
            let offset = 0;
            while (offset < chunk.stdout.length) {
              const written = await spool.write(chunk.stdout, offset, chunk.stdout.length - offset, spooledBytes + offset);
              if (written.bytesWritten < 1) throw new Error("Private search output spool made no progress");
              offset += written.bytesWritten;
            }
            spooledBytes += offset;
          }
        } else if (chunk.stdout.length) {
          try {
            const structured = limiter?.consume(chunk.stdout) ?? { captureParts: [chunk.stdout], reached: false };
            for (const part of structured.captureParts) capture(stdout, part);
            if (input.lineLimit !== undefined) for (const byte of chunk.stdout) if (byte === 10) stdoutLines++;
            if (structured.reached || (input.lineLimit !== undefined && stdoutLines >= input.lineLimit)) {
              killedAfterLimit = true; requestStop();
            }
          } catch (error) {
            spawnError = error instanceof Error ? error : new Error(String(error));
            requestStop();
          }
        }
      }
      if (receipt.cleanupProven && receipt.failure && !receipt.outputComplete) {
        throw new ExecutionEnvironmentError("output_incomplete", receipt.failure, true);
      }
      // Observe final output only after the completion receipt, then drain the
      // retained stream to EOF. Leader exit alone cannot settle this operation.
      if (receipt.cleanupProven && receipt.outputComplete && chunk.stdout.length + chunk.stderr.length === 0) {
        await inputDone;
        await stop;
        if (stopError !== undefined) throw stopError;
        if (inputError !== undefined) throw inputError;
        if (spawnError === undefined) {
          try { limiter?.finish({ allowPartial: stop !== undefined || (receipt.exitCode !== 0 && receipt.exitCode !== 1) }); }
          catch (error) { spawnError = error instanceof Error ? error : new Error(String(error)); }
        }
        return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: receipt.exitCode,
          signal: null, killedAfterLimit, processedLines: limiter?.processedLines ?? 0, workUnits: limiter?.workUnits ?? 0,
          spooledBytes, aborted: stopReason === "aborted", ...(stopReason === undefined ? {} : { stopReason }),
          ...(spawnError === undefined ? {} : { spawnError }) };
      }
      if (chunk.stdout.length + chunk.stderr.length === 0) await delay(20);
    }
  } catch (error) {
    if (process !== undefined) {
      requestStop();
      await stop;
      await inputDone;
      if (stopError !== undefined) throw new AggregateError([error, stopError], "Bound search failed and cleanup was not proved");
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await spool?.close();
  }
}
