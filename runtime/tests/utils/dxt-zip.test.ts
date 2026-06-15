import { Buffer } from "node:buffer"
import { describe, expect, test } from "vitest"
import { strToU8, zipSync } from "fflate"

import { isPathSafe, unzipFile } from "../../src/utils/dxt/zip.js"

const textDecoder = new TextDecoder()

describe("isPathSafe", () => {
  test("accepts relative archive paths and rejects traversal or absolute paths", () => {
    expect(isPathSafe("plugin.json")).toBe(true)
    expect(isPathSafe("commands/hello.md")).toBe(true)
    expect(isPathSafe("./commands/hello.md")).toBe(true)

    expect(isPathSafe("../escape.txt")).toBe(false)
    expect(isPathSafe("commands/../../escape.txt")).toBe(false)
    expect(isPathSafe("/tmp/escape.txt")).toBe(false)
  })
})

describe("unzipFile", () => {
  test("extracts safe zip entries", async () => {
    const zipData = Buffer.from(
      zipSync({
        "plugin.json": strToU8("{}"),
        "commands/hello.md": strToU8("hello"),
      }),
    )

    const files = await unzipFile(zipData)

    expect(Object.keys(files).sort()).toEqual([
      "commands/hello.md",
      "plugin.json",
    ])
    expect(textDecoder.decode(files["commands/hello.md"])).toBe("hello")
  })

  test("rejects traversal entries before returning data", async () => {
    const zipData = Buffer.from(
      zipSync({
        "../escape.txt": strToU8("bad"),
      }),
    )

    await expect(unzipFile(zipData)).rejects.toThrow(
      /Unsafe file path detected/,
    )
  })
})
