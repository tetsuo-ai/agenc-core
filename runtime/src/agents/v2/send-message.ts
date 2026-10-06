import type { Tool } from "../../tools/types.js";
import {
  confirmedNoAgentEffect,
  localZeroAdmissionEstimate,
  strictArgs,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";
import {
  handleMessageStringTool,
  MAX_INTER_AGENT_MESSAGE_CHARACTERS,
} from "./message-tool.js";

export function createSendMessageTool(opts: MultiAgentV2Options): Tool {
  return {
    name: "send_message",
    description:
      "Queue a message for an existing agent. A running or starting child reads it at its next turn; the root reads it when its mailbox is next drained. The result reports delivered false because the message is lost if the child finishes first. Idle and finished children reject the message; use assign_task to start an idle worker's next turn. Does not trigger a new turn.",
    metadata: toolMetadata("agent", {
      mutating: true,
      virtualNoFsWrites: true,
      keywords: ["agent", "message", "mailbox"],
    }),
    recoveryCategory: "side-effecting",
    admissionEstimate: localZeroAdmissionEstimate,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        message: {
          type: "string",
          maxLength: MAX_INTER_AGENT_MESSAGE_CHARACTERS,
        },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
    execute: (args) => {
      const strict = strictArgs(args, {
        allowed: new Set(["target", "message"]),
        required: ["target", "message"],
      });
      if (strict) return Promise.resolve(confirmedNoAgentEffect(strict));
      return handleMessageStringTool(args, opts, "queue_only");
    },
  };
}
