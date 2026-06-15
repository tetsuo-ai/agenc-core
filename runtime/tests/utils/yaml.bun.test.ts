import { expect, test } from "bun:test"

import { parseYaml } from "../../src/utils/yaml.ts"

test("parseYaml uses Bun.YAML in Bun", () => {
  expect(typeof Bun.YAML.parse).toBe("function")
  expect(parseYaml("name: AgenC\npaths:\n  - runtime/src/**/*.ts\n")).toEqual({
    name: "AgenC",
    paths: ["runtime/src/**/*.ts"],
  })
})
