import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { sourceUrl } from "../helpers/source-path.ts";

describe("published artifact request schema", () => {
  it("accepts complete bounded chunk requests", () => {
    const schema = JSON.parse(readFileSync(sourceUrl("app-server/protocol/schema.json"), "utf8")) as { definitions: Record<string, object> };
    const validate = new Ajv({ strict: false }).compile({
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: schema.definitions,
      $ref: "#/definitions/AgenCDaemonRequest",
    });
    const base = { sessionId: "session", id: "a".repeat(64) };
    const request = (params: object) => ({ jsonrpc: "2.0", id: "read", method: "session.artifact.read", params });
    expect(validate(request({ ...base, offset: 524_288, length: 524_288 }))).toBe(true);
    expect(validate(request({ ...base, offset: -1, length: 1 }))).toBe(false);
    expect(validate(request({ ...base, offset: 0, length: 524_289 }))).toBe(false);
  });
});
