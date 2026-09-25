import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { sourceUrl } from "../helpers/source-path.ts";

describe("agent status notification schema", () => {
  it("accepts projected turn and run boundaries with object payloads", () => {
    const schema = JSON.parse(readFileSync(sourceUrl("app-server/protocol/schema.json"), "utf8")) as {
      definitions: Record<string, unknown>;
    };
    const validate = new Ajv({ strict: false }).compile({
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: schema.definitions,
      $ref: "#/definitions/AgenCDaemonNotification",
    });
    const envelope = (turnEvent: unknown) => ({
      jsonrpc: "2.0", method: "event.agent_status",
      params: { sessionId: "session_1", eventId: "event_1", agentId: "agent_1", status: "idle", turnEvent },
    });
    for (const type of ["turn_started", "turn_complete", "turn_aborted", "run_terminal"]) {
      expect(validate(envelope({ type, payload: { runId: "run_1" } })), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate(envelope({ type: "other", payload: {} }))).toBe(false);
    expect(validate(envelope({ type: "run_terminal", payload: "invalid" }))).toBe(false);
  });
});
