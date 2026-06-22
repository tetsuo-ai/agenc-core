import { describe, expect, it } from "vitest";
import {
  isTaskRecord,
  taskNumberField,
  taskStringField,
} from "./record-fields.js";

describe("task record field helpers", () => {
  it("keeps the loose task payload record guard semantics", () => {
    expect(isTaskRecord({})).toBe(true);
    expect(isTaskRecord([])).toBe(true);
    expect(isTaskRecord(Object.create(null))).toBe(true);
    expect(isTaskRecord(null)).toBe(false);
    expect(isTaskRecord("task")).toBe(false);
  });

  it("reads trimmed non-empty string fields", () => {
    expect(taskStringField({ title: "  Inspect queue  " }, "title")).toBe(
      "Inspect queue",
    );
    expect(taskStringField({ title: "\n\t" }, "title")).toBe(undefined);
    expect(taskStringField({ title: 1 }, "title")).toBe(undefined);
  });

  it("reads finite number fields", () => {
    expect(taskNumberField({ startTime: 12 }, "startTime")).toBe(12);
    expect(taskNumberField({ startTime: Number.NaN }, "startTime")).toBe(
      undefined,
    );
    expect(taskNumberField({ startTime: "12" }, "startTime")).toBe(undefined);
  });
});
