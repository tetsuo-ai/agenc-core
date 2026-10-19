import { describe, expect, test } from "vitest";
import { completionGate } from "../../src/phases/completion-gate.js";
import { syntheticGate, syntheticResult } from "./completion-gate-synthetic.js";

const STOCK = "Use the inventory MCP server to look up product MC-421, then get stock for its warehouse. Return JSON with sku, warehouse, available, reserved, inventory_stamp, stock_stamp. Use MCP tools only; do not use shell or filesystem tools.";
const INVOICE = "Use the inventory MCP server to get invoice INV-731 and the EUR to USD exchange rate dated 2026-10-18. Compute the invoice net cents after discount, then convert the total to USD cents rounding to the nearest cent. Return JSON with net_eur_cents, usd_cents, invoice_stamp, rate_stamp. Use MCP tools only; do not use shell or filesystem tools.";
const SHIPPING = "Use the inventory MCP server to look up product MC-421, then quote express shipping for one item to postal code 75011 from its warehouse using its weight. Return JSON with price_cents, currency, inventory_stamp, shipping_stamp. Use MCP tools only; do not use shell or filesystem tools.";

function firstAnswer(task: string, text = '{"available":137}') {
  const gate = syntheticGate(task, text);
  gate.state.completionGateRound = 0;
  gate.state.completionGateToolLedgerMark = 0;
  gate.state.completedToolResults = [
    syntheticResult("product", { toolName: "mcp.inventory.lookup_product", content: '{"warehouse":"WH-NORTH"}' }),
    syntheticResult("stock", { toolName: "mcp.inventory.get_stock", content: '{"available":137}' }),
  ];
  return gate;
}

async function judge(gate: ReturnType<typeof firstAnswer>) {
  await completionGate(gate.state, gate.context, gate.session);
  return gate;
}

describe("completion gate for answers without workspace deliverables", () => {
  test.each([STOCK, INVOICE, SHIPPING, "Explain the data flow in src/main.js.", "What does the inventory service return?", "Calculate the net amount using the invoice results."])(
    "finishes an information request using already observed results: %s", async task => {
      const gate = await judge(firstAnswer(task));
      expect(gate.state.transition).toBeUndefined();
      expect(gate.state.completionGateRound).toBe(0);
      expect(gate.state.messages).toHaveLength(1);
      expect(gate.last()).toMatchObject({ outcome: "skipped", reason: "answer_only" });
    },
  );

  test.each([
    "The checkout test is failing. Please fix the calculation and cover the edge cases described in the README with tests.",
    "Add an optional --pending flag to the list command so it only shows unfinished tasks. The normal list must keep working. Add pytest tests for this, including an empty list.",
    `${STOCK} Save the JSON to stock.json.`,
    "Look up the product and write inventory.json, then return JSON only.",
    "Explain the data flow and fix its bug.",
    "Return a CSV file with the inventory results.",
    "Return the results in /app/stock.json.",
    "Return the results in reports/stock.json.",
    String.raw`Return the results in C:\reports\stock.json.`,
    "Create the report. Reply with exactly READY.",
    "Make the endpoint return JSON only.",
    "Run the tests and report the results.",
    "Do the requested work.",
    "Extend the service to support pending tasks. Return JSON only.",
    "Integrate the inventory endpoint. Return JSON with its URL.",
    `${STOCK} Store the answer in stock.json.`,
    "Look up inventory.\n[task text truncated]",
  ])("keeps verification for artifact, coding or ambiguous work: %s", async task => {
    const gate = await judge(firstAnswer(task));
    expect(gate.state.transition).toEqual({ reason: "completion_gate" });
    expect(gate.last()).toMatchObject({ outcome: "injected", reason: "initial" });
  });

  test.each([
    { toolName: "Write" },
    { toolName: "apply_patch" },
    { toolName: "mcp.filesystem.write_file" },
    { metadata: { ui: { kind: "file_mutation" } } },
    { metadata: { fileMutations: [{ filePath: "out.json" }] } },
    { toolName: "exec_command", metadata: { exitCode: 0 } },
    { toolName: "Bash" },
    { toolName: "write_stdin", metadata: { exitCode: null } },
  ])("does not overlook workspace activity: %j", async result => {
    const gate = firstAnswer(STOCK);
    gate.state.completedToolResults.push(syntheticResult("effect", result));
    await judge(gate);
    expect(gate.state.transition).toEqual({ reason: "completion_gate" });
  });

  test("does not treat all-failed lookups as observed answer evidence", async () => {
    const gate = firstAnswer(STOCK);
    gate.state.completedToolResults = gate.state.completedToolResults.map(r => ({ ...r, isError: true }));
    await judge(gate);
    expect(gate.state.transition).toEqual({ reason: "completion_gate" });
  });

  test.each(["- [ ] Look up stock", "- [?] Stock was checked", "- [x] Stock tests passed"])(
    "preserves checklist verification when an answer declares checks: %s", async text => {
      const gate = await judge(firstAnswer(STOCK, text));
      expect(gate.state.transition).toEqual({ reason: "completion_gate" });
    },
  );

  test("does not drop a durable verification round on resume", async () => {
    const gate = firstAnswer(STOCK);
    gate.state.completionGateRound = 1;
    await judge(gate);
    expect(gate.state.transition).toEqual({ reason: "completion_gate" });
  });
});
