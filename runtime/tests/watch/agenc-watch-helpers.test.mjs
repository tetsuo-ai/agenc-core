import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import {
  buildWatchCommands,
  createOperatorInputBatcher,
  findWatchCommandDefinition,
  matchWatchCommands,
  parseWatchSlashCommand,
  shouldAutoInspectRun,
  WATCH_COMMANDS,
} from "../../src/watch/agenc-watch-helpers.mjs";

test("createOperatorInputBatcher coalesces rapid pasted lines into one turn", async () => {
  const dispatched = [];
  const batcher = createOperatorInputBatcher({
    delayMs: 5,
    onDispatch: (value) => dispatched.push(value),
  });

  batcher.push("Requirements:");
  await sleep(1);
  batcher.push("- Use npm and TypeScript only.");
  await sleep(1);
  batcher.push("- Add tests.");
  await sleep(15);

  assert.deepEqual(dispatched, [
    "Requirements:\n- Use npm and TypeScript only.\n- Add tests.",
  ]);
});

test("createOperatorInputBatcher keeps separate turns separate when they are not paste bursts", async () => {
  const dispatched = [];
  const batcher = createOperatorInputBatcher({
    delayMs: 5,
    onDispatch: (value) => dispatched.push(value),
  });

  batcher.push("first turn");
  await sleep(15);
  batcher.push("second turn");
  await sleep(15);

  assert.deepEqual(dispatched, ["first turn", "second turn"]);
});

test("createOperatorInputBatcher ignores empty lines", async () => {
  const dispatched = [];
  const batcher = createOperatorInputBatcher({
    delayMs: 5,
    onDispatch: (value) => dispatched.push(value),
  });

  batcher.push("   ");
  batcher.push("");
  batcher.push("real turn");
  await sleep(15);

  assert.deepEqual(dispatched, ["real turn"]);
});

test("shouldAutoInspectRun only enables auto inspect for background-run state", () => {
  assert.equal(shouldAutoInspectRun(null, "idle"), false);
  assert.equal(shouldAutoInspectRun(null, "queued"), false);
  assert.equal(shouldAutoInspectRun(null, "working"), true);
  assert.equal(shouldAutoInspectRun(null, "needs_verification"), true);
  assert.equal(shouldAutoInspectRun(null, "partial"), true);
  assert.equal(shouldAutoInspectRun({ state: "completed" }, "idle"), true);
});

test("matchWatchCommands returns the full command palette for slash-only input", () => {
  const matches = matchWatchCommands("/");
  assert.deepEqual(
    matches.map((command) => command.name),
    WATCH_COMMANDS.map((command) => command.name).sort((left, right) =>
      left.localeCompare(right),
    ),
  );
});

test("matchWatchCommands filters by prefix and aliases", () => {
  assert.deepEqual(
    matchWatchCommands("/se").map((command) => command.name),
    ["/session", "/sessions"],
  );
  assert.equal(findWatchCommandDefinition("/init")?.name, "/init");
  assert.equal(findWatchCommandDefinition("/commands")?.name, "/help");
  assert.equal(findWatchCommandDefinition("/copy")?.name, "/export");
  assert.equal(findWatchCommandDefinition("/models")?.name, "/model");
});

test("parseWatchSlashCommand resolves canonical command metadata and args", () => {
  assert.deepEqual(parseWatchSlashCommand("/logs 200"), {
    raw: "/logs 200",
    commandToken: "/logs",
    args: ["200"],
    command: findWatchCommandDefinition("/logs"),
  });
  assert.deepEqual(parseWatchSlashCommand("/copy"), {
    raw: "/copy",
    commandToken: "/copy",
    args: [],
    command: findWatchCommandDefinition("/copy"),
  });
  assert.deepEqual(parseWatchSlashCommand("/model grok-4"), {
    raw: "/model grok-4",
    commandToken: "/model",
    args: ["grok-4"],
    command: findWatchCommandDefinition("/model"),
  });
  assert.equal(parseWatchSlashCommand("ship it"), null);
  assert.equal(parseWatchSlashCommand("/unknown")?.command, null);
});

test("buildWatchCommands adds review mode commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const reviewCommands = buildWatchCommands({
    featureFlags: {
      reviewModes: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/review"),
    false,
  );
  assert.deepEqual(
    reviewCommands
      .filter((command) => ["/review", "/security-review", "/pr-comments"].includes(command.name))
      .map((command) => command.name),
    ["/review", "/security-review", "/pr-comments"],
  );
  assert.equal(
    matchWatchCommands("/rev", { commands: reviewCommands }).at(0)?.name,
    "/review",
  );
  assert.equal(
    parseWatchSlashCommand("/security-review auth middleware", { commands: reviewCommands })?.command?.name,
    "/security-review",
  );
});

test("buildWatchCommands adds checkpoint commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const checkpointCommands = buildWatchCommands({
    featureFlags: {
      checkpoints: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/checkpoint"),
    false,
  );
  assert.deepEqual(
    checkpointCommands
      .filter((command) => ["/checkpoint", "/checkpoints", "/rewind"].includes(command.name))
      .map((command) => command.name),
    ["/checkpoint", "/checkpoints", "/rewind"],
  );
  assert.equal(
    matchWatchCommands("/rew", { commands: checkpointCommands }).at(0)?.name,
    "/rewind",
  );
  assert.equal(
    parseWatchSlashCommand("/checkpoint before-fix", { commands: checkpointCommands })?.command?.name,
    "/checkpoint",
  );
  assert.equal(
    parseWatchSlashCommand("/rollback latest", { commands: checkpointCommands })?.command?.name,
    "/rewind",
  );
});

test("buildWatchCommands adds diff review commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const diffCommands = buildWatchCommands({
    featureFlags: {
      diffReview: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/diff"),
    false,
  );
  assert.equal(
    diffCommands.some((command) => command.name === "/diff"),
    true,
  );
  assert.equal(
    matchWatchCommands("/di", { commands: diffCommands }).at(0)?.name,
    "/diff",
  );
});

test("buildWatchCommands adds compaction commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const compactionCommands = buildWatchCommands({
    featureFlags: {
      compactionControls: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/compact"),
    false,
  );
  assert.equal(
    compactionCommands.some((command) => command.name === "/compact"),
    true,
  );
  assert.equal(
    matchWatchCommands("/com", { commands: compactionCommands }).at(0)?.name,
    "/compact",
  );
  assert.equal(
    parseWatchSlashCommand("/compact status", { commands: compactionCommands })?.command?.name,
    "/compact",
  );
});

test("buildWatchCommands adds permissions commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const permissionCommands = buildWatchCommands({
    featureFlags: {
      permissionsControls: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/permissions"),
    false,
  );
  assert.deepEqual(
    permissionCommands
      .filter((command) => ["/permissions", "/approvals"].includes(command.name))
      .map((command) => command.name),
    ["/permissions", "/approvals"],
  );
  assert.equal(
    parseWatchSlashCommand("/policy status", { commands: permissionCommands })?.command?.name,
    "/permissions",
  );
  assert.equal(
    parseWatchSlashCommand("/approve list", { commands: permissionCommands })?.command?.name,
    "/approvals",
  );
});

test("buildWatchCommands adds attachment commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const attachmentCommands = buildWatchCommands({
    featureFlags: {
      attachments: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/attach"),
    false,
  );
  assert.deepEqual(
    attachmentCommands
      .filter((command) => ["/attach", "/attachments", "/unattach"].includes(command.name))
      .map((command) => command.name),
    ["/attach", "/attachments", "/unattach"],
  );
  assert.equal(
    parseWatchSlashCommand("/attach ./diagram.png", { commands: attachmentCommands })?.command?.name,
    "/attach",
  );
  assert.equal(
    parseWatchSlashCommand("/detach all", { commands: attachmentCommands })?.command?.name,
    "/unattach",
  );
});

test("buildWatchCommands adds run recovery commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const recoveryCommands = buildWatchCommands({
    featureFlags: {
      rerunFromTrace: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/retry-run"),
    false,
  );
  assert.deepEqual(
    recoveryCommands
      .filter((command) =>
        [
          "/run-cancel",
          "/run-objective",
          "/run-constraints",
          "/run-budget",
          "/run-compact",
          "/run-worker",
          "/retry-run",
          "/retry-step",
          "/retry-trace",
          "/run-fork",
          "/verify-override",
        ].includes(command.name),
      )
      .map((command) => command.name),
    [
      "/run-cancel",
      "/run-objective",
      "/run-constraints",
      "/run-budget",
      "/run-compact",
      "/run-worker",
      "/retry-run",
      "/retry-step",
      "/retry-trace",
      "/run-fork",
      "/verify-override",
    ],
  );
  assert.equal(
    parseWatchSlashCommand("/rerun operator retry", { commands: recoveryCommands })?.command?.name,
    "/retry-run",
  );
  assert.equal(
    parseWatchSlashCommand('/run-budget {"maxCycles":12}', { commands: recoveryCommands })?.command?.name,
    "/run-budget",
  );
  assert.equal(
    parseWatchSlashCommand("/verify-override fail missing verifier output", { commands: recoveryCommands })?.command?.name,
    "/verify-override",
  );
  assert.equal(
    parseWatchSlashCommand("/retry-step verify tests --trace trace-1 --reason replay it", { commands: recoveryCommands })?.command?.name,
    "/retry-step",
  );
  assert.equal(
    parseWatchSlashCommand("/retry-trace trace-2 plan verifier --reason inspect failure", { commands: recoveryCommands })?.command?.name,
    "/retry-trace",
  );
  assert.equal(
    parseWatchSlashCommand("/run-fork sess-2 --objective branch it --reason compare approaches", { commands: recoveryCommands })?.command?.name,
    "/run-fork",
  );
});

test("buildWatchCommands adds remote tool commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const remoteCommands = buildWatchCommands({
    featureFlags: {
      remoteTools: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/desktop"),
    false,
  );
  assert.equal(
    remoteCommands.some((command) => command.name === "/desktop"),
    true,
  );
  assert.equal(
    matchWatchCommands("/desk", { commands: remoteCommands }).at(0)?.name,
    "/desktop",
  );
  assert.equal(
    parseWatchSlashCommand("/desktop attach 1", { commands: remoteCommands })?.command?.name,
    "/desktop",
  );
});

test("buildWatchCommands adds export bundle commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const exportBundleCommands = buildWatchCommands({
    featureFlags: {
      exportBundles: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/bundle"),
    false,
  );
  assert.equal(
    exportBundleCommands.some((command) => command.name === "/bundle"),
    true,
  );
  assert.equal(
    parseWatchSlashCommand("/export-bundle", { commands: exportBundleCommands })?.command?.name,
    "/bundle",
  );
});

test("buildWatchCommands adds insights commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const insightCommands = buildWatchCommands({
    featureFlags: {
      insights: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/insights"),
    false,
  );
  assert.equal(
    insightCommands.some((command) => command.name === "/insights"),
    true,
  );
  assert.equal(
    parseWatchSlashCommand("/insights", { commands: insightCommands })?.command?.name,
    "/insights",
  );
});

test("buildWatchCommands adds extensibility commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const extensibilityCommands = buildWatchCommands({
    featureFlags: {
      extensibilityHub: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/extensibility"),
    false,
  );
  assert.deepEqual(
    extensibilityCommands
      .filter((command) =>
        ["/extensibility", "/skills", "/plugins", "/mcp", "/hooks"].includes(command.name)
      )
      .map((command) => command.name),
    ["/extensibility", "/skills", "/plugins", "/mcp", "/hooks"],
  );
});

test("buildWatchCommands adds input-mode commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const inputModeCommands = buildWatchCommands({
    featureFlags: {
      inputModes: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/input-mode"),
    false,
  );
  assert.deepEqual(
    inputModeCommands
      .filter((command) =>
        ["/config", "/input-mode", "/keybindings", "/theme", "/statusline", "/vim"].includes(command.name)
      )
      .map((command) => command.name),
    ["/config", "/input-mode", "/keybindings", "/theme", "/statusline", "/vim"],
  );
});

test("buildWatchCommands adds thread switcher commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const threadCommands = buildWatchCommands({
    featureFlags: {
      threadSwitcher: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/agents"),
    false,
  );
  assert.equal(
    threadCommands.some((command) => command.name === "/agents"),
    true,
  );
  assert.equal(
    matchWatchCommands("/thr", { commands: threadCommands }).at(0)?.name,
    "/agents",
  );
  assert.equal(
    parseWatchSlashCommand("/threads all", { commands: threadCommands })?.command?.name,
    "/agents",
  );
});

test("buildWatchCommands adds session indexing commands only when enabled", () => {
  const defaultCommands = buildWatchCommands();
  const sessionCommands = buildWatchCommands({
    featureFlags: {
      sessionIndexing: true,
    },
  });

  assert.equal(
    defaultCommands.some((command) => command.name === "/session-label"),
    false,
  );
  assert.equal(
    sessionCommands.some((command) => command.name === "/session-label"),
    true,
  );
  assert.equal(
    matchWatchCommands("/session-l", { commands: sessionCommands }).at(0)?.name,
    "/session-label",
  );
  assert.equal(
    parseWatchSlashCommand("/rename-session release branch", { commands: sessionCommands })?.command?.name,
    "/session-label",
  );
});
