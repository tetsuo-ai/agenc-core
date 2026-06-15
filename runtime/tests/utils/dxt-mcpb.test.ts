import { describe, expect, test } from "vitest"

import {
  parseAndValidateManifestFromText,
  validateManifest,
} from "../../src/utils/dxt/helpers.js"
import { getMcpConfigForManifest } from "../../src/utils/dxt/mcpb.js"

const baseManifest = {
  manifest_version: "0.4",
  name: "sample-extension",
  version: "1.0.0",
  description: "Sample extension",
  author: {
    name: "Tetsuo AI",
  },
  server: {
    type: "node",
    entry_point: "server.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server.js"],
    },
  },
}

describe("MCPB manifest validation", () => {
  test("accepts current v0.4 manifests including uv servers", async () => {
    const manifest = await validateManifest({
      ...baseManifest,
      server: {
        type: "uv",
        entry_point: "main.py",
        mcp_config: {
          command: "uv",
          args: ["run", "${__dirname}/main.py"],
        },
      },
    })

    expect(manifest.server.type).toBe("uv")
  })

  test("rejects uv servers before manifest v0.4", async () => {
    await expect(
      validateManifest({
        ...baseManifest,
        manifest_version: "0.3",
        server: {
          type: "uv",
          entry_point: "main.py",
          mcp_config: {
            command: "uv",
          },
        },
      }),
    ).rejects.toThrow(/Invalid manifest/)
  })

  test("rejects manifests without an MCPB manifest version", async () => {
    const { manifest_version: _manifestVersion, ...manifestWithoutVersion } =
      baseManifest

    await expect(validateManifest(manifestWithoutVersion)).rejects.toThrow(
      /Invalid manifest/,
    )
  })

  test("parses valid manifest JSON text", async () => {
    const manifest = await parseAndValidateManifestFromText(
      JSON.stringify(baseManifest),
    )

    expect(manifest.name).toBe("sample-extension")
  })
})

describe("getMcpConfigForManifest", () => {
  test("applies defaults, user config, system dirs, and array expansion", async () => {
    const manifest = await validateManifest({
      ...baseManifest,
      user_config: {
        paths: {
          type: "string",
          title: "Paths",
          description: "Extra paths",
          multiple: true,
          default: ["default-a", "default-b"],
        },
        enabled: {
          type: "boolean",
          title: "Enabled",
          description: "Feature switch",
          default: false,
        },
      },
      server: {
        type: "node",
        entry_point: "server.js",
        mcp_config: {
          command: "${runtime}",
          args: [
            "${__dirname}/server.js",
            "${user_config.paths}",
            "--enabled=${user_config.enabled}",
          ],
          env: {
            HOME_DIR: "${HOME}",
          },
        },
      },
    })

    const config = await getMcpConfigForManifest({
      manifest,
      extensionPath: "/tmp/extension",
      systemDirs: {
        HOME: "/home/tester",
        runtime: "node",
      },
      userConfig: {
        enabled: true,
      },
      pathSeparator: "/",
    })

    expect(config).toMatchObject({
      command: "node",
      args: [
        "/tmp/extension/server.js",
        "default-a",
        "default-b",
        "--enabled=true",
      ],
      env: {
        HOME_DIR: "/home/tester",
      },
    })
  })

  test("returns undefined when required user config is missing", async () => {
    const manifest = await validateManifest({
      ...baseManifest,
      user_config: {
        token: {
          type: "string",
          title: "Token",
          description: "Required token",
          required: true,
        },
      },
    })

    await expect(
      getMcpConfigForManifest({
        manifest,
        extensionPath: "/tmp/extension",
        systemDirs: {},
        pathSeparator: "/",
      }),
    ).resolves.toBeUndefined()
  })
})
