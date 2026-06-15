import { describe, expect, test } from "vitest"

import { parseYaml } from "../../src/utils/yaml.js"

describe("parseYaml", () => {
  test("uses the Node js-yaml fallback outside Bun", () => {
    expect(parseYaml("name: AgenC\npaths:\n  - src/**/*.ts\n")).toEqual({
      name: "AgenC",
      paths: ["src/**/*.ts"],
    })
  })
})
