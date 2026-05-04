import { describe, expect, it } from "vitest";

import {
  generateProgressiveArgumentHint,
  parseArgumentNames,
  parseArguments,
  substituteArguments,
} from "./argument-substitution.js";

describe("parseArguments", () => {
  it("splits shell-style arguments and preserves quoted spans", () => {
    expect(parseArguments('foo "hello world" baz')).toEqual([
      "foo",
      "hello world",
      "baz",
    ]);
  });

  it("preserves shell variables literally", () => {
    expect(parseArguments("foo $BAR ${BAZ}")).toEqual([
      "foo",
      "$BAR",
      "$BAZ",
    ]);
  });

  it("falls back to whitespace splitting when shell parsing throws", () => {
    expect(parseArguments("foo ${")).toEqual(["foo", "${"]);
  });
});

describe("parseArgumentNames", () => {
  it("accepts whitespace strings and arrays while dropping numeric names", () => {
    expect(parseArgumentNames("topic focus 123")).toEqual(["topic", "focus"]);
    expect(parseArgumentNames(["topic", "123", "focus"])).toEqual([
      "topic",
      "focus",
    ]);
  });
});

describe("generateProgressiveArgumentHint", () => {
  it("shows remaining named arguments", () => {
    expect(generateProgressiveArgumentHint(["one", "two", "three"], ["value"]))
      .toBe("[two] [three]");
    expect(generateProgressiveArgumentHint(["one"], ["value"])).toBeUndefined();
  });
});

describe("substituteArguments", () => {
  it("substitutes full, indexed, shorthand, and named placeholders", () => {
    expect(
      substituteArguments(
        "All=$ARGUMENTS first=$ARGUMENTS[0] second=$1 topic=$topic",
        "alpha beta",
        true,
        ["topic"],
      ),
    ).toBe("All=alpha beta first=alpha second=beta topic=alpha");
  });

  it("escapes named argument regex metacharacters", () => {
    expect(
      substituteArguments("$topic.name $topicX", "value extra", true, [
        "topic.name",
      ]),
    ).toBe("value $topicX");
  });

  it("uses an empty string for missing named or indexed args", () => {
    expect(
      substituteArguments("missing=$topic idx=$2", "value", true, ["topic"]),
    ).toBe("missing=value idx=");
  });

  it("appends arguments when no placeholders are present", () => {
    expect(substituteArguments("Body", "alpha beta")).toBe(
      "Body\n\nARGUMENTS: alpha beta",
    );
  });

  it("returns content unchanged when args are undefined", () => {
    expect(substituteArguments("Use $ARGUMENTS", undefined)).toBe(
      "Use $ARGUMENTS",
    );
  });
});
