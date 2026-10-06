import { serializeProcessBrokerV2Payload } from "./process-broker-protocol-v2.js";

export const PROCESS_BROKER_V3_CAPABILITY = "AGB3 owner-pid sealed-static-init-ro-artifact-v1";

/** Same bounded invocation and one-role seccomp map as V2. The native broker
 * creates the init's private report/reference/source descriptors itself. */
export function serializeProcessBrokerV3Payload(
  input: Parameters<typeof serializeProcessBrokerV2Payload>[0],
): Buffer {
  const payload = serializeProcessBrokerV2Payload(input);
  payload.write("AGB3", 0, "ascii");
  return payload;
}

/** AGB3 containment completion is independent of the command outcome.
 * This decoder is intentionally separate from the legacy S/[R]/C protocol.
 * Nothing is authoritative until the unique status writer closes its pipe. */
export type ProcessBrokerV3Outcome =
  | {
    readonly kind: "reported";
    readonly result:
      | { readonly kind: "exit"; readonly code: number }
      | { readonly kind: "signal"; readonly signal: number };
    readonly residual: "none" | "observed";
  }
  | { readonly kind: "aborted" | "unavailable"; readonly residual: "unknown" };

export interface ProcessBrokerV3Completion {
  readonly cleanupProven: true;
  readonly outcome: ProcessBrokerV3Outcome;
}

const STATUS_LENGTH = 13; // S followed by one fixed twelve-byte AGC3 frame.
const STATUS_MAGIC = Buffer.from("AGC3", "ascii");

export class ProcessBrokerV3StatusDecoder {
  private readonly bytes = Buffer.alloc(STATUS_LENGTH);
  private length = 0;
  private finished = false;
  private failed = false;

  /** True exactly once, when this chunk supplies the first valid S byte.
   * Callers may release pending control signals then, but must still wait
   * for finish() at EOF before using any completion or result information. */
  push(chunk: Uint8Array): boolean {
    this.assertOpen();
    const wasReady = this.length !== 0;
    if (chunk.length > STATUS_LENGTH - this.length) {
      return this.reject("extra status bytes");
    }
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
    if (this.length !== 0 && this.bytes[0] !== 0x53) {
      return this.reject("missing readiness");
    }
    return !wasReady && this.length !== 0;
  }

  /** Invoke only on EOF, never merely on receipt of twelve terminal bytes. */
  finish(): ProcessBrokerV3Completion {
    this.assertOpen();
    if (this.length !== STATUS_LENGTH) return this.reject("truncated status");
    if (!this.bytes.subarray(1, 5).equals(STATUS_MAGIC) ||
        this.bytes.subarray(9).some(byte => byte !== 0)) {
      return this.reject("invalid version or reserved fields");
    }
    const state = this.bytes[5]!;
    const residual = this.bytes[6]!;
    const kind = this.bytes[7]!;
    const code = this.bytes[8]!;
    let outcome: ProcessBrokerV3Outcome;
    if (state === 0) {
      if (residual > 1 || kind > 1 || (kind === 1 && (code < 1 || code > 64))) {
        return this.reject("invalid authenticated outcome");
      }
      outcome = {
        kind: "reported",
        result: kind === 0 ? { kind: "exit", code } : { kind: "signal", signal: code },
        residual: residual === 0 ? "none" : "observed",
      };
    } else {
      if ((state !== 1 && state !== 2) || residual !== 2 || kind !== 2 || code !== 0) {
        return this.reject("invalid unknown outcome");
      }
      outcome = { kind: state === 1 ? "aborted" : "unavailable", residual: "unknown" };
    }
    this.finished = true;
    return { cleanupProven: true, outcome };
  }

  private assertOpen(): void {
    if (this.failed || this.finished) throw new Error("AGB3 status decoder is already terminal");
  }

  private reject(message: string): never {
    this.failed = true;
    throw new Error(`Invalid AGB3 containment status: ${message}`);
  }
}
