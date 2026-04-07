// Snapshot expectations updated for the redesigned header (Style C — Modern
// Card). The header now uses lowercase ▸-prefixed cells in a strict 2-column
// layout, brand "AgenC" in the top border, and "model <name> via <provider>"
// in the bottom border.
export const FRAME_SNAPSHOT_EXPECTATIONS = Object.freeze({
  // Order matches the actual render: brand top border → 4 left/right body
  // rows (objective/run, workspace/status, git/phase, usage/tool) → bottom
  // border with the model. Then transcript content.
  widePlanner: {
    containsInOrder: [
      "AgenC",
      "▸ run",
      "delegating",
      "▸ status",
      "▸ phase",
      "▸ usage",
      "3.4K total",
      "▸ tool",
      "system.writeFile",
      "model grok-4 via grok",
      "● Working through the planner graph.",
      "RETURN done",
      "Edited runtime/src/index.ts",
      "~/",
      "\n>",
    ],
    notContains: [
      "A G E N / C https://agenc.tech",
      "LIVE DAG",
      "/ commands  ctrl+o detail",
    ],
  },
  diffDetail: {
    containsInOrder: [
      "AgenC",
      "▸ run",
      "running",
      "▸ usage",
      "1.2K total",
      "model grok-4 via grok",
      "RETURN Edited runtime/src/index.ts",
      "return  ctrl+o close  ctrl+p prev hunk  ctrl+n next hunk",
      "│ /home/tetsuo/git/AgenC/runtime/src/index.ts",
      "+++ after",
      "+ return newValue;",
      // The exact "X of 11 lines  N above  hunk K/2" status line depends on
      // the visible body height, which shrank by one row in the redesign.
      // Match the stable suffix instead of hard-coding the cursor position.
      "of 11 lines",
      "hunk 1/2  /home/tetsuo/git/AgenC/runtime/src/index.ts",
      "\n>",
    ],
    notContains: [
      "A G E N / C https://agenc.tech",
    ],
  },
  narrowReconnect: {
    containsInOrder: [
      "AgenC",
      "▸ status",
      "link reconnecting",
      "model routing pending",
      "● Reconnecting to the daemon.",
      "\n>",
    ],
    notContains: [
      "A G E N / C https://agenc.tech",
      "RUN:idle  RUNTIME:reconnecting",
    ],
  },
});
