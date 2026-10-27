import { describe, expect, test } from "vitest";
import { parseLocalControlCommand } from "../../src/commands/local-control.js";

describe("local controls admitted without model or Editor authority", () => {
  test.each(["/tasks", "/jobs", "/bashes", "/status", "/swarm", "/swarm status", "/swarm STATUS", "/goal", "/goal status", "/goal cancel", "/goal pause", "/goal clear", "/goal stop", "/goal off", "/goal reset", "/goal none"])("admits %s", input => {
    expect(parseLocalControlCommand(input)).not.toBeNull();
  });
  test.each(["/goal resume", "/goal build a feature", "/goal cancel extra", "/tasks stop all", "/tasks(MCP)", "/status extra", "/tasks\nmodify files", "/swarm off", "/swarm on", "/swarm status extra", "/model", "/clear", "/resume", "/exit", "/help", "/context", "/unknown", "$tasks", "! /tasks", "change files"])("rejects %s", input => {
    expect(parseLocalControlCommand(input)).toBeNull();
  });
});
