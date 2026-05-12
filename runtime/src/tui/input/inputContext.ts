import type { LocalJSXCommandContext } from "../../commands.js";
import type { ToolUseContext } from "../../tools/Tool.js";

export type PromptInputContext = ToolUseContext & LocalJSXCommandContext;
