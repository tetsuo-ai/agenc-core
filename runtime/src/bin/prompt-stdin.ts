import type { Readable } from "node:stream";

/** Read exact prompt bytes, including whitespace; cancellation also wakes idle input. */
export function readPromptStdin(input: Readable, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      input.pause();
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error("stdin closed before prompt EOF"));
    const onAbort = () => onError(signal.reason ?? new Error("stdin read aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    if (input.readableEnded) {
      onEnd();
      return;
    }
    if (input.destroyed) {
      onClose();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
  });
}
