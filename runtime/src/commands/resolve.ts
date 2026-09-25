/**
 * /resolve — operator review of unknown-outcome tool effects (the M4 gate).
 *
 * A tool call that dies mid-dispatch (timeout, crash) leaves an "unknown
 * outcome" effect, and the M4 gate then blocks every later side-effecting
 * call in the session until an operator reviews it. The CLI path
 * (`agenc state resolve-tool-call`) cannot run while the daemon holds the
 * session lock — this command resolves through the live daemon instead.
 *
 * Usage: /resolve <call-id> <disposition> [<evidence-ref> <evidence-sha256>]
 *
 * With only the call id and a disposition, the user attests the outcome from
 * their own knowledge and Core records that attestation as the evidence.
 */

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandResult,
} from "./types.js";

type Disposition =
  | "confirmed_committed"
  | "confirmed_no_effect"
  | "remains_unknown";

export type ResolveDaemonToolCallParams =
  | {
      readonly toolCallId: string;
      readonly disposition: Disposition;
      readonly evidenceRef: string;
      readonly evidenceSha256: string;
      readonly reviewer?: string;
    }
  | {
      readonly toolCallId: string;
      readonly disposition: Disposition;
      readonly attestation: "operator";
      readonly reviewer?: string;
    };

const USAGE =
  "Usage: /resolve <call-id> <confirmed_committed|confirmed_no_effect|remains_unknown> [<evidence-ref> <evidence-sha256>]";

type ResolvableSession = {
  readonly resolveDaemonToolCall?: (params: ResolveDaemonToolCallParams) => Promise<{
    readonly sessionId: string;
    readonly resolved: readonly {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly eventId?: string;
    }[];
    readonly remaining: number;
  }>;
};

export const resolveCommand: SlashCommand = {
  name: "resolve",
  aliases: ["resolve-effects"],
  description: "Resolve blocked tool effects (M4 gate)",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const session = ctx.session as unknown as ResolvableSession;
      if (typeof session.resolveDaemonToolCall !== "function") {
        return {
          kind: "error",
          message:
            "This session cannot resolve effects here — close the session and run `agenc state resolve-tool-call <session-id> <tool-call-id> <disposition> <evidence-ref> <evidence-sha256>` from the project directory.",
        };
      }
      const [toolCallId, disposition, evidenceRef, evidenceSha256, extra] =
        ctx.argsRaw.trim().split(/\s+/u);
      if (
        toolCallId === undefined ||
        toolCallId.length === 0 ||
        extra !== undefined ||
        (disposition !== "confirmed_committed" &&
          disposition !== "confirmed_no_effect" &&
          disposition !== "remains_unknown") ||
        (evidenceRef === undefined) !== (evidenceSha256 === undefined) ||
        (evidenceSha256 !== undefined &&
          !/^[0-9a-f]{64}$/u.test(evidenceSha256))
      ) {
        return { kind: "error", message: USAGE };
      }
      // The daemon records the reviewer from this client's attachment.
      const result = await session.resolveDaemonToolCall(
        evidenceRef === undefined || evidenceSha256 === undefined
          ? { toolCallId, disposition, attestation: "operator" }
          : { toolCallId, disposition, evidenceRef, evidenceSha256 },
      );
      if (result.resolved.length === 0) {
        return {
          kind: "text",
          text: `No pending unknown-outcome effect '${toolCallId}' in this session (nothing blocked).`,
        };
      }
      const lines = result.resolved.map(
        (effect) =>
          `  ✔ ${effect.toolCallId}${effect.toolName ? ` (${effect.toolName})` : ""}`,
      );
      lines.push(
        result.remaining === 0
          ? "Mutation gate lifted — side-effecting tools are unblocked."
          : `${result.remaining} unknown-outcome effect(s) still pending.`,
      );
      return { kind: "text", text: lines.join("\n") };
    }),
};
