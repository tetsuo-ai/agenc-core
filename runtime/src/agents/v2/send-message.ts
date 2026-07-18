import type { Tool } from "../../tools/types.js";
import {
  localZeroAdmissionEstimate,
  strictArgs,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";
import { handleMessageStringTool } from "./message-tool.js";

export function createSendMessageTool(opts: MultiAgentV2Options): Tool {
  return {
    name: "send_message",
    description:
      "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
    metadata: toolMetadata("agent", {
      mutating: true,
      keywords: ["agent", "message", "mailbox"],
    }),
    recoveryCategory: "side-effecting",
    admissionEstimate: localZeroAdmissionEstimate,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        message: { type: "string" },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
    execute: (args) => {
      const strict = strictArgs(args, {
        allowed: new Set(["target", "message"]),
        required: ["target", "message"],
      });
      if (strict) return Promise.resolve(strict);
      return handleMessageStringTool(args, opts, "queue_only");
    },
  };
}
