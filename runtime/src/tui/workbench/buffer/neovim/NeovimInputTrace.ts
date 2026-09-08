import { appendFileSync } from "node:fs";

export type NeovimInputTraceState = {
  readonly sessionId: string | null;
  readonly focusOwner: "buffer" | "other";
  readonly providerStatus: string;
  readonly providerMode: string;
};

export type NeovimInputTraceToken = {
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: "escape" | "colon" | "paste" | "enter" | "other";
  rpcCompleted: boolean;
};

export type NeovimInputTraceRecord =
  | (NeovimInputTraceState & { readonly type: "state" })
  | (NeovimInputTraceToken & {
      readonly type: "input";
      readonly phase:
        | "queued"
        | "running"
        | "rpc-complete"
        | "mode"
        | "complete"
        | "failed"
        | "retired"
        | "skipped";
      readonly mode: string | null;
      readonly pendingRpc: "input" | "mode" | null;
    });

export class NeovimInputTrace {
  #sequence = 0;
  #state = "";

  constructor(readonly write: (record: NeovimInputTraceRecord) => void) {}

  state(state: NeovimInputTraceState): void {
    const serialized = JSON.stringify(state);
    if (serialized === this.#state) return;
    this.#state = serialized;
    this.write({ type: "state", ...state });
  }

  begin(
    sessionId: string,
    kind: NeovimInputTraceToken["kind"],
  ): NeovimInputTraceToken {
    const token = {
      sessionId,
      kind,
      sequence: ++this.#sequence,
      rpcCompleted: false,
    };
    this.progress(token, "queued");
    return token;
  }

  progress(
    token: NeovimInputTraceToken,
    phase: Extract<NeovimInputTraceRecord, { type: "input" }>["phase"],
    mode: string | null = null,
  ): void {
    if (phase === "rpc-complete") token.rpcCompleted = true;
    let pendingRpc: "input" | "mode" | null = null;
    if (phase === "running") pendingRpc = "input";
    if (phase === "mode" || phase === "rpc-complete") pendingRpc = "mode";
    this.write({ type: "input", ...token, phase, mode, pendingRpc });
  }
}

export function neovimInputTraceForTesting(
  env: NodeJS.ProcessEnv = process.env,
): NeovimInputTrace | null {
  const path = env.AGENC_TEST_NEOVIM_INPUT_TRACE;
  if (!path) return null;
  return new NeovimInputTrace((record) => {
    try {
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      return;
    }
  });
}
