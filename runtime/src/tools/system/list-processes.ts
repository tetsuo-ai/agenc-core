import type { Tool } from "../types.js";
import { safeStringify } from "../types.js";
import { validationErrorToolResult } from "../results.js";
import type { UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs } from "../../unified-exec/process-ownership.js";

export function createListProcessesTool(config: {
  readonly unifiedExecManager: UnifiedExecProcessManagerLike;
}): Tool {
  return {
    name: "list_processes",
    description:
      "List your live managed exec_command sessions, with session_id, bounded command and cwd, tty, and start time. Does not consume output. Use write_stdin to poll output and kill_process to stop a session. Detached services are not managed session handles.",
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["process", "background", "session", "list"],
      preferredProfiles: ["coding", "validation", "operator"],
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
    },
    requiresApproval: false,
    isReadOnly: true,
    recoveryCategory: "idempotent",
    supportsParallelToolCalls: true,
    isConcurrencySafe: () => true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(args) {
      // Runtime-injected context is private; the model schema accepts no input.
      const unknown = Object.keys(args).find((key) => !key.startsWith("__"));
      if (unknown !== undefined) {
        return validationErrorToolResult("tool:system.list-processes:validation", `unknown field \`${unknown}\``);
      }
      const manager = config.unifiedExecManager;
      if (manager.listProcesses === undefined) {
        return validationErrorToolResult("tool:system.list-processes:unsupported", "process listing is not supported by this runtime");
      }
      return {
        content: safeStringify({ processes: manager.listProcesses(processOwnerIdFromToolArgs(args)) }),
      };
    },
  };
}
