import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { AGENC_DAEMON_METHODS, AGENC_DAEMON_NOTIFICATION_METHODS, AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";
import { AGENC_SDK_DAEMON_METHODS, AGENC_SDK_DAEMON_NOTIFICATION_METHODS } from "../../../packages/agenc-sdk/src/protocol.js";

const schema = JSON.parse(readFileSync(new URL("../../src/app-server/protocol/schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validator = (name: string) => ajv.getSchema(`${schema.$id}#/definitions/${name}`)!;

describe("routine preparation protocol parity", () => {
  it("publishes the versioned request and answer in Core, schema and generated SDK", () => {
    expect(AGENC_DAEMON_PROTOCOL_VERSION).toBe("1.17.0");
    expect(AGENC_DAEMON_METHODS).toContain("routine.session.prepare.respond");
    expect(AGENC_DAEMON_NOTIFICATION_METHODS).toContain("routine.session.prepare");
    expect(schema["x-agenc-methods"]).toContain("routine.session.prepare.respond");
    expect(schema["x-agenc-notifications"]).toContain("routine.session.prepare");
    expect(AGENC_SDK_DAEMON_METHODS).toContain("routine.session.prepare.respond");
    expect(AGENC_SDK_DAEMON_NOTIFICATION_METHODS).toContain("routine.session.prepare");
  });
  it("validates exact preparation identity, response and recorded outcome", () => {
    const requestId = "123e4567-e89b-12d3-a456-426614174000";
    expect(validator("RoutineSessionPrepareNotification")({ jsonrpc: "2.0", method: "routine.session.prepare", params: { requestId, sessionId: "session", routineId: "routine", runId: "run", cwd: "/workspace" } })).toBe(true);
    expect(validator("RoutineSessionPrepareResponseRequest")({ jsonrpc: "2.0", id: "one", method: "routine.session.prepare.respond", params: { requestId, status: "declined", reason: "No window." } })).toBe(true);
    expect(validator("RoutineDesktopTools")({ status: "attached", reason: null })).toBe(true);
    expect(validator("RoutineDesktopTools")({ status: "declined", reason: "No window." })).toBe(true);
    expect(validator("RoutineDesktopTools")({ status: "unavailable", reason: "No client." })).toBe(true);
    expect(validator("RoutineDesktopTools")({ status: "bypass", reason: null })).toBe(false);
  });
});
