import { afterEach, describe, expect, test } from "vitest";

import { parseToml, TomlParseError } from "../../src/config/loader.js";

// C3 (core-todo.md): parseToml walked table/key paths with plain `cur[seg] = …`
// and never rejected `__proto__`, so a config file could pollute Object.prototype
// for the whole daemon process. These tests pin that every form now throws and,
// critically, that the global prototype is never mutated.

function protoPolluted(): boolean {
  // A fresh empty object must not have gained the injected property.
  return ({} as Record<string, unknown>).isAdmin !== undefined;
}

describe("parseToml — C3 prototype-pollution hardening", () => {
  afterEach(() => {
    // Defensive: if any assertion regressed and polluted, clean up so the failure
    // doesn't cascade into unrelated tests.
    delete (Object.prototype as Record<string, unknown>).isAdmin;
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  test.each([
    { name: "table header", src: "[__proto__]\nisAdmin = true\n" },
    { name: "dotted key", src: "__proto__.isAdmin = true\n" },
    { name: "quoted table header", src: '["__proto__"]\nisAdmin = true\n' },
    { name: "inline table", src: "danger = { __proto__.polluted = 1 }\n" },
    { name: "array of tables", src: "[[__proto__]]\nisAdmin = true\n" },
    { name: "constructor gadget", src: "constructor.prototype.isAdmin = true\n" },
    { name: "nested proto", src: "[a.__proto__]\nisAdmin = true\n" },
  ])("rejects $name and does not pollute Object.prototype", ({ src }) => {
    expect(() => parseToml(src)).toThrow(TomlParseError);
    expect(protoPolluted()).toBe(false);
  });

  test("a config that legitimately references keys near the denylist still parses", () => {
    // Ordinary keys must be unaffected; only the exact forbidden segments are rejected.
    const parsed = parseToml(
      ['model = "opus"', "[wallet]", 'name = "main"', "count = 3"].join("\n") + "\n",
    ) as Record<string, unknown>;
    expect(parsed.model).toBe("opus");
    expect(parsed.wallet).toEqual({ name: "main", count: 3 });
  });
});
