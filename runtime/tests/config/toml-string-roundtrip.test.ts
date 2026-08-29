import { describe, expect, test } from "vitest";

import { parseToml, TomlParseError } from "../../src/config/loader.js";
import { serializeConfigToml } from "../../src/config/serialize.js";

describe("canonical TOML string handling", () => {
  test("decodes every TOML single-line basic-string escape", () => {
    const parsed = parseToml(
      String.raw`value = "\b\t\n\f\r\"\\\u0041\U0001F642"`,
    );

    expect(parsed.value).toBe("\b\t\n\f\r\"\\A🙂");
  });

  test.each([
    String.raw`value = "\q"`,
    String.raw`value = "\/"`,
    String.raw`value = "\u12xz"`,
    String.raw`value = "\uD800"`,
    String.raw`value = "\U00110000"`,
    `value = "raw\u0000control"`,
  ])("rejects invalid or unescaped basic-string content: %s", (document) => {
    expect(() => parseToml(document)).toThrow(TomlParseError);
  });

  test("serializer/parser round-trip preserves Unicode, escapes, and controls", () => {
    const source = {
      config_version: 2,
      model: "grok-4.6🙂\"\\\b\f\u0000\u007f",
    };

    const serialized = serializeConfigToml(source);
    expect(serialized).toContain("\\b");
    expect(serialized).toContain("\\f");
    expect(serialized).toContain("\\u0000");
    expect(serialized).toContain("\\u007F");
    expect(parseToml(serialized)).toEqual(source);
  });

  test("migration-style parse and rewrite preserves Unicode escape values", () => {
    const parsed = parseToml(String.raw`model = "grok-\u0034.6"`);
    const rewritten = serializeConfigToml({ config_version: 2, ...parsed });

    expect(parseToml(rewritten)).toEqual({
      config_version: 2,
      model: "grok-4.6",
    });
  });

  test("serializes the canonical teammate leader-inheritance sentinel", () => {
    const source = {
      config_version: 2,
      teammates: { defaultModel: "inherit" },
    };

    expect(parseToml(serializeConfigToml(source))).toEqual(source);
  });
});
