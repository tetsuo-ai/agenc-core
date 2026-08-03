import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeCsvResult,
  compileCsvOutputSchema,
  getCsvValidationPoolMetrics,
  primeCsvOutputSchemaValidation,
  releaseCsvOutputSchemaValidation,
  validateCsvResultForPersistence,
  validateCsvResultInWorkerPool,
} from "./csv-schema.js";

describe("CSV output schema contract", () => {
  it("validates nested Draft-07 subset semantics with Ajv", () => {
    const compiled = compileCsvOutputSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        decision: { enum: ["accept", "reject"] },
        evidence: {
          type: "object",
          properties: { score: { type: "number", minimum: 0, maximum: 1 } },
          required: ["score"],
          additionalProperties: false,
        },
      },
      required: ["decision", "evidence"],
      additionalProperties: false,
    })!;

    expect(
      compiled.validate({ decision: "accept", evidence: { score: 0.5 } }),
    ).toBeNull();
    expect(
      compiled.validate({ decision: "maybe", evidence: { score: 2 } }),
    ).toMatch(/does not match/u);
    expect(compiled.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    [{ oneOf: [{ type: "string" }] }, /oneOf.*not supported/u],
    [{ pattern: "(a+)+" }, /pattern.*not supported/u],
    [{ $ref: "https://example.invalid/schema" }, /local definitions/u],
    [
      { $schema: "https://json-schema.org/draft/2020-12/schema" },
      /must be exactly/u,
    ],
    [
      {
        definitions: { loop: { $ref: "#/definitions/loop" } },
        $ref: "#/definitions/loop",
      },
      /cyclic/u,
    ],
    [
      {
        definitions: {
          loop: {
            type: "object",
            properties: { child: { $ref: "#/definitions/loop" } },
          },
        },
      },
      /cyclic/u,
    ],
    [
      {
        definitions: {
          left: { properties: { child: { $ref: "#/definitions/right" } } },
          right: { items: { $ref: "#/definitions/left" } },
        },
      },
      /cyclic/u,
    ],
  ])("rejects unsupported or unbounded schema constructs", (schema, error) => {
    expect(() => compileCsvOutputSchema(schema)).toThrow(error);
  });

  it("compiles and validates through the shared owned worker pool", async () => {
    const compiled = compileCsvOutputSchema({
      type: "object",
      properties: { score: { type: "integer", minimum: 0, maximum: 10 } },
      required: ["score"],
      additionalProperties: false,
    })!;
    await primeCsvOutputSchemaValidation("worker-pool-job", compiled);
    const outcomes = await Promise.all(
      [1, 2, 3, 4, 5].map((score) =>
        validateCsvResultInWorkerPool(
          "worker-pool-job",
          compiled,
          canonicalizeCsvResult({ score }),
        ),
      ),
    );
    expect(outcomes).toEqual([null, null, null, null, null]);
    await expect(
      validateCsvResultInWorkerPool(
        "worker-pool-job",
        compiled,
        canonicalizeCsvResult({ score: 11 }),
      ),
    ).resolves.toMatch(/does not match/u);
    const metrics = getCsvValidationPoolMetrics();
    expect(metrics.workerCount).toBeLessThanOrEqual(4);
    expect(metrics.queuedTasks).toBe(0);
    expect(
      metrics.jobs.find((job) => job.jobId === "worker-pool-job"),
    ).toMatchObject({ queuedTasks: 0, activeTasks: 0 });
    releaseCsvOutputSchemaValidation("worker-pool-job");
    expect(
      getCsvValidationPoolMetrics().jobs.some(
        (job) => job.jobId === "worker-pool-job",
      ),
    ).toBe(false);
  });

  it("rejects Ajv-invalid schemas in the owned worker before job creation", async () => {
    const compiled = compileCsvOutputSchema({
      enum: ["duplicate", "duplicate"],
    })!;
    await expect(
      primeCsvOutputSchemaValidation("invalid-worker-schema", compiled),
    ).rejects.toThrow(/schema|enum|duplicate/iu);
    releaseCsvOutputSchemaValidation("invalid-worker-schema");
  });

  it("binds one-shot validation tokens to the exact job, item, and schema", async () => {
    const compiled = compileCsvOutputSchema({
      type: "object",
      properties: { score: { type: "integer" } },
      required: ["score"],
      additionalProperties: false,
    })!;
    const result = canonicalizeCsvResult({ score: 7 });
    const validated = await validateCsvResultForPersistence(
      "token-job",
      "row-a",
      compiled,
      result,
    );
    expect(typeof validated).not.toBe("string");
    if (typeof validated === "string") throw new Error(validated);

    expect(() =>
      validated.consumeFor("token-job", "row-b", compiled.digest),
    ).toThrow(/another job\/item\/schema/u);
    expect(() =>
      validated.consumeFor("token-job", "row-a", "different-schema"),
    ).toThrow(/another job\/item\/schema/u);
    expect(validated.consumeFor("token-job", "row-a", compiled.digest)).toBe(
      result,
    );
    expect(() =>
      validated.consumeFor("token-job", "row-a", compiled.digest),
    ).toThrow(/already consumed/u);
  });

  it("keeps schema validation off the event loop", async () => {
    const compiled = compileCsvOutputSchema({
      type: "object",
      properties: { score: { type: "integer" } },
      required: ["score"],
      additionalProperties: false,
    })!;
    let timerFired = false;
    const validations = Array.from({ length: 64 }, (_, index) =>
      validateCsvResultForPersistence(
        "event-loop-job",
        `row-${index}`,
        compiled,
        canonicalizeCsvResult({ score: index }),
      ),
    );
    setTimeout(() => {
      timerFired = true;
    }, 0);
    await expect(Promise.all(validations)).resolves.toHaveLength(64);
    expect(timerFired).toBe(true);
  });
});

describe("CSV result canonicalization", () => {
  it("sorts keys, freezes inert clones, and produces a stable digest", () => {
    const first = canonicalizeCsvResult({ z: 1, a: { y: true, b: "x" } });
    const second = canonicalizeCsvResult({ a: { b: "x", y: true }, z: 1 });
    expect(first.json).toBe('{"a":{"b":"x","y":true},"z":1}');
    expect(first.digest).toBe(second.digest);
    expect(Object.getPrototypeOf(first.value)).toBeNull();
    expect(Object.isFrozen(first.value)).toBe(true);
  });

  it("never invokes getters or toJSON hooks", () => {
    const getter = vi.fn(() => "secret");
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "payload", { enumerable: true, get: getter });
    expect(() => canonicalizeCsvResult(value)).toThrow(/accessor/u);
    expect(getter).not.toHaveBeenCalled();

    expect(() =>
      canonicalizeCsvResult({ toJSON: () => ({ forged: true }) }),
    ).toThrow(/non-JSON value/u);
  });

  it("rejects non-finite and over-deep JSON values", () => {
    expect(() =>
      canonicalizeCsvResult({ value: Number.POSITIVE_INFINITY }),
    ).toThrow(/non-finite/u);
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let depth = 0; depth < 65; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    expect(() => canonicalizeCsvResult(root)).toThrow(/maximum depth/u);
  });
});
