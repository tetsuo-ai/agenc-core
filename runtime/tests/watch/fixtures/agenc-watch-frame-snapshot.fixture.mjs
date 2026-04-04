export const FRAME_SNAPSHOT_EXPECTATIONS = Object.freeze({
  widePlanner: {
    containsInOrder: [
      "AgenC",
      "RUN:delegating",
      "MODEL:grok-4 via grok",
      "phase delegating",
      "usage 3.4K total",
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
      "RUN:running",
      "MODEL:grok-4 via grok",
      "usage 1.2K total",
      "RETURN Edited runtime/src/index.ts",
      "return  ctrl+o close  ctrl+p prev hunk  ctrl+n next hunk",
      "│ /home/tetsuo/git/AgenC/runtime/src/index.ts",
      "- return oldValue;",
      "+++ after",
      "+ return newValue;",
      "4 of 11 lines  7 above  hunk 2/2  /home/tetsuo/git/AgenC/runtime/src/index.ts",
      "\n>",
    ],
    notContains: [
      "A G E N / C https://agenc.tech",
    ],
  },
  narrowReconnect: {
    containsInOrder: [
      "AgenC",
      "MODEL:routing pending",
      "STATUS:link reconnecting",
      "● Reconnecting to the daemon.",
      "\n>",
    ],
    notContains: [
      "A G E N / C https://agenc.tech",
      "RUN:idle  RUNTIME:reconnecting",
    ],
  },
});
