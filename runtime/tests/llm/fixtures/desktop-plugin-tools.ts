import type { LLMTool } from "../../../src/llm/types.js";

// Snapshot of the model-facing names and input contracts registered by
// Desktop's desktopRoutineTools.ts / desktopTools.ts. The nested routine
// create/update fields follow Desktop's daemon/routines.ts Zod schemas.
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" };
const tabId = { type: "string", minLength: 1, maxLength: 256 };
const revision = { type: "string", format: "date-time" };
const schedule = { anyOf: [
  { type: "object", properties: { kind: { const: "manual" } }, required: ["kind"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "cron" }, expression: { type: "string", minLength: 1, maxLength: 256 } }, required: ["kind", "expression"], additionalProperties: false },
] };
const definition = {
  name: { type: "string", minLength: 1, maxLength: 128 },
  description: { type: "string", maxLength: 2048 },
  instructions: { type: "string", minLength: 1, maxLength: 16384 },
  cwd: { type: "string", maxLength: 4096 }, schedule,
  provider: { type: "string", maxLength: 256 }, model: { type: "string", maxLength: 256 },
  permissionMode: { enum: ["default", "plan"] },
  enabled: { type: "boolean" }, notifyOnCompletion: { type: "boolean" },
};
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false });
const desktop = (name: string, parameters: Record<string, unknown>): LLMTool => ({
  type: "function", function: { name: `mcp.agenc-desktop-control.${name}`, description: `AgenC Desktop ${name}`, parameters },
});
const plugin = (name: string, parameters: Record<string, unknown>): LLMTool => ({
  type: "function", function: {
    name: `mcp.plugin:stonks-copilot:stonks-data.${name}`,
    description: `Stonks Copilot ${name}`,
    parameters,
  },
});

export const DESKTOP_PLUGIN_TOOLS: readonly LLMTool[] = [
  desktop("desktop_routine_list", object({})),
  desktop("desktop_routine_get", object({ id }, ["id"])),
  desktop("desktop_routine_create", object(definition, ["name", "instructions", "schedule"])),
  desktop("desktop_routine_update", object({ id, patch: object(definition), expectedUpdatedAt: revision }, ["id", "patch", "expectedUpdatedAt"])),
  desktop("desktop_routine_delete", object({ id, expectedUpdatedAt: revision }, ["id", "expectedUpdatedAt"])),
  desktop("desktop_routine_run", object({ id }, ["id"])),
  desktop("desktop_routine_runs", object({ id, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["id"])),
  desktop("desktop_routine_cancel", object({ id, runId: id }, ["id", "runId"])),
  desktop("desktop_routines_open", object({})),
  desktop("desktop_state", object({})),
  desktop("browser_navigate", object({ tabId, url: { type: "string", minLength: 1, maxLength: 8192 } }, ["tabId", "url"])),
  plugin("ohlcv", object({
    symbol: { type: "string", description: "Ticker, e.g. AAPL or VOO" },
    months: { type: "number", description: "Lookback window in months (default 24)" },
  }, ["symbol"])),
  plugin("indicators", object({
    symbol: { type: "string" },
    months: { type: "number", description: "History window in months (default 24; needs 10+ for SMA200)" },
  }, ["symbol"])),
  plugin("fundamentals", object({
    symbol: { type: "string" },
    price: { type: "number", description: "Latest close; enables P/E, P/S, FCF and dividend yields" },
  }, ["symbol"])),
  {
    type: "function",
    function: {
      name: "mcp.plugin:institutional-equities-research-and-portfolio-attribution-with-global-market-data-and-filing-analysis:research-and-compliance.fundamentals",
      description: "Long but valid plugin-scoped MCP server identifier",
      parameters: object({ symbol: { type: "string" } }, ["symbol"]),
    },
  },
];
