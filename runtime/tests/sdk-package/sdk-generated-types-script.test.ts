import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseSdkGeneratedTypesMode,
  synchronizeTranscriptV2Generated,
  synchronizeTurnTerminalGenerated,
} from "../../scripts/check-sdk-generated-types.mjs";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, "../../..");
const npmWriteArgs = [
  "--workspace=@tetsuo-ai/runtime",
  "run",
  "check:sdk-generated-types",
  "--",
  "--write",
] as const;

function npmWriteCommand({
  nodeExecutable,
  npmExecPath,
  windows,
}: {
  readonly nodeExecutable: string;
  readonly npmExecPath: string | undefined;
  readonly windows: boolean;
}): { readonly executable: string; readonly args: readonly string[] } {
  const path = windows ? win32 : posix;
  const nodeDirectory = path.dirname(nodeExecutable);
  const npmCliPath =
    npmExecPath?.trim() ||
    (windows
      ? path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(
          path.dirname(nodeDirectory),
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ));
  return {
    executable: nodeExecutable,
    args: [npmCliPath, ...npmWriteArgs],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

function runtimeProtocol(): string {
  return `interface JsonObject {}

/** Leading interface documentation is not mirrored. */
export interface SessionTranscriptV2Message extends JsonObject {
  /** Member documentation is mirrored. */
  readonly id: string;
  readonly text?: string;
}

export interface SessionTranscriptV2ActiveTurn extends JsonObject {
  readonly turnId: string;
}

export interface SessionTranscriptV2TurnResult extends JsonObject {
  readonly turnId: string;
  readonly outcome: "completed" | "aborted";
}

export interface SessionTranscriptV2Result extends JsonObject {
  readonly messages: readonly SessionTranscriptV2Message[];
}
`;
}

async function createFixture(
  protocol = runtimeProtocol(),
  generated = "stale generated output\n",
): Promise<{
  readonly root: string;
  readonly protocolPath: string;
  readonly generatedPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-sdk-generator-"));
  temporaryRoots.push(root);
  const protocolPath = join(root, "protocol.ts");
  const generatedPath = join(root, "transcript-v2.generated.ts");
  await Promise.all([
    writeFile(protocolPath, protocol, "utf8"),
    writeFile(generatedPath, generated, "utf8"),
  ]);
  return { root, protocolPath, generatedPath };
}

async function createCanonicalFixture() {
  const fixture = await createFixture();
  const result = await synchronizeTranscriptV2Generated({
    runtimeProtocolPath: fixture.protocolPath,
    generatedPath: fixture.generatedPath,
    write: true,
  });
  return { ...fixture, expected: result.expected };
}

describe("SDK generated transcript v2 script", () => {
  it("checks the terminal classifier implementation as well as its types", async () => {
    const source = "export const terminalCode = 1;\n";
    const fixture = await createFixture(source);
    const options = {
      canonicalPath: fixture.protocolPath,
      generatedPath: fixture.generatedPath,
    };
    expect(await synchronizeTurnTerminalGenerated(options)).toMatchObject({
      changed: false, matches: false,
    });
    expect(await readFile(fixture.generatedPath, "utf8")).toBe("stale generated output\n");
    expect(await synchronizeTurnTerminalGenerated({ ...options, write: true })).toMatchObject({
      changed: true, matches: true,
    });
    expect(await readFile(fixture.generatedPath, "utf8")).toBe(source);
    expect(await synchronizeTurnTerminalGenerated({ ...options, write: true })).toMatchObject({
      changed: false, matches: true,
    });
    await writeFile(fixture.generatedPath, source.replace("= 1", "= 0"));
    expect(await synchronizeTurnTerminalGenerated(options)).toMatchObject({
      changed: false, matches: false,
    });
    expect(await readFile(fixture.generatedPath, "utf8")).toBe(source.replace("= 1", "= 0"));
  });

  it("keeps check mode as the default and requires an explicit write flag", () => {
    expect(parseSdkGeneratedTypesMode([])).toBe("check");
    expect(parseSdkGeneratedTypesMode(["--write"])).toBe("write");
    expect(() => parseSdkGeneratedTypesMode(["--check"])).toThrow(/usage/);
    expect(() => parseSdkGeneratedTypesMode(["--write", "extra"])).toThrow(
      /usage/,
    );
  });

  it("accepts the documented npm write entrypoint", async () => {
    const command = npmWriteCommand({
      nodeExecutable: process.execPath,
      npmExecPath: process.env.npm_execpath,
      windows: process.platform === "win32",
    });
    expect(command.executable).toMatch(/node(?:\.exe)?$/i);
    expect(command.executable).not.toMatch(/\.cmd$/i);
    expect(command.args[0]).toMatch(/npm-cli\.js$/);

    const { stdout } = await execFileAsync(
      command.executable,
      [...command.args],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(stdout).toContain(
      "packages/agenc-sdk/src/transcript-v2.generated.ts is already current",
    );
  });

  it.each([
    [
      "POSIX",
      "/opt/node/bin/node",
      false,
      "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    ],
    [
      "Windows",
      "C:\\Program Files\\nodejs\\node.exe",
      true,
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    ],
  ] as const)(
    "uses the Node executable for the %s npm command",
    (_label, nodeExecutable, windows, expectedNpmCliPath) => {
      const command = npmWriteCommand({
        nodeExecutable,
        npmExecPath: undefined,
        windows,
      });

      expect(command.executable).toBe(nodeExecutable);
      expect(command.args).toEqual([expectedNpmCliPath, ...npmWriteArgs]);
    },
  );

  it("accepts LF and CRLF inputs without writing in check mode", async () => {
    const fixture = await createCanonicalFixture();
    const crlfProtocol = runtimeProtocol().replace(/\n/g, "\r\n");
    const crlfGenerated = fixture.expected.replace(/\n/g, "\r\n");
    await Promise.all([
      writeFile(fixture.protocolPath, crlfProtocol, "utf8"),
      writeFile(fixture.generatedPath, crlfGenerated, "utf8"),
    ]);

    const result = await synchronizeTranscriptV2Generated({
      runtimeProtocolPath: fixture.protocolPath,
      generatedPath: fixture.generatedPath,
    });

    expect(result).toMatchObject({ changed: false, matches: true });
    expect(await readFile(fixture.generatedPath, "utf8")).toBe(crlfGenerated);
  });

  it("leaves stale output untouched and rejects every exact-mirror drift", async () => {
    const fixture = await createCanonicalFixture();
    const propertyBlock = `  /** Member documentation is mirrored. */
  readonly id: string;
  readonly text?: string;`;
    const drifts = [
      [
        "header",
        fixture.expected.replace("// @generated", "// stale generated"),
      ],
      [
        "alias",
        fixture.expected.replace(
          "type TranscriptV2JsonPrimitive",
          "type StaleJsonPrimitive",
        ),
      ],
      [
        "heritage",
        fixture.expected.replace(
          "extends TranscriptV2JsonObject",
          "extends OtherJsonObject",
        ),
      ],
      [
        "field",
        fixture.expected.replace("readonly id: string", "readonly key: string"),
      ],
      [
        "type",
        fixture.expected.replace("readonly id: string", "readonly id: number"),
      ],
      [
        "order",
        fixture.expected.replace(
          propertyBlock,
          `  readonly text?: string;
  /** Member documentation is mirrored. */
  readonly id: string;`,
        ),
      ],
      [
        "member comment",
        fixture.expected.replace(
          "Member documentation is mirrored.",
          "Changed member documentation.",
        ),
      ],
    ] as const;

    for (const [label, stale] of drifts) {
      expect(stale, label).not.toBe(fixture.expected);
      await writeFile(fixture.generatedPath, stale, "utf8");
      const result = await synchronizeTranscriptV2Generated({
        runtimeProtocolPath: fixture.protocolPath,
        generatedPath: fixture.generatedPath,
      });
      expect(result.matches, label).toBe(false);
      expect(await readFile(fixture.generatedPath, "utf8"), label).toBe(stale);
    }
  });

  it("atomically writes canonical LF output and is idempotent", async () => {
    const protocol = runtimeProtocol().replace(/\n/g, "\r\n");
    const fixture = await createFixture(protocol, "stale\r\noutput\r\n");
    const protocolBefore = await readFile(fixture.protocolPath, "utf8");

    const first = await synchronizeTranscriptV2Generated({
      runtimeProtocolPath: fixture.protocolPath,
      generatedPath: fixture.generatedPath,
      write: true,
    });
    const generated = await readFile(fixture.generatedPath, "utf8");
    expect(first).toMatchObject({ changed: true, matches: true });
    expect(generated).toBe(first.expected);
    expect(generated).not.toContain("\r");
    expect(await readFile(fixture.protocolPath, "utf8")).toBe(protocolBefore);
    expect((await readdir(fixture.root)).sort()).toEqual([
      "protocol.ts",
      "transcript-v2.generated.ts",
    ]);

    const second = await synchronizeTranscriptV2Generated({
      runtimeProtocolPath: fixture.protocolPath,
      generatedPath: fixture.generatedPath,
      write: true,
    });
    expect(second).toMatchObject({ changed: false, matches: true });
    expect(await readFile(fixture.generatedPath, "utf8")).toBe(generated);

    await writeFile(
      fixture.generatedPath,
      generated.replace(/\n/g, "\r\n"),
      "utf8",
    );
    const canonicalized = await synchronizeTranscriptV2Generated({
      runtimeProtocolPath: fixture.protocolPath,
      generatedPath: fixture.generatedPath,
      write: true,
    });
    expect(canonicalized.changed).toBe(true);
    expect(await readFile(fixture.generatedPath, "utf8")).toBe(generated);
  });

  it.runIf(process.platform !== "win32")(
    "preserves existing permissions and respects the umask for a missing target",
    async () => {
      const fixture = await createFixture();
      await chmod(fixture.generatedPath, 0o640);

      await synchronizeTranscriptV2Generated({
        runtimeProtocolPath: fixture.protocolPath,
        generatedPath: fixture.generatedPath,
        write: true,
      });
      expect((await lstat(fixture.generatedPath)).mode & 0o777).toBe(0o640);

      await rm(fixture.generatedPath);
      const previousUmask = process.umask(0o007);
      try {
        await synchronizeTranscriptV2Generated({
          runtimeProtocolPath: fixture.protocolPath,
          generatedPath: fixture.generatedPath,
          write: true,
        });
      } finally {
        process.umask(previousUmask);
      }

      expect((await lstat(fixture.generatedPath)).mode & 0o777).toBe(0o660);
    },
  );

  it("rejects missing interfaces and invalid runtime heritage before writing", async () => {
    const missingResult = runtimeProtocol().replace(
      `

export interface SessionTranscriptV2Result extends JsonObject {
  readonly messages: readonly SessionTranscriptV2Message[];
}`,
      "",
    );
    const invalidHeritage = runtimeProtocol().replace(
      "SessionTranscriptV2Message extends JsonObject",
      "SessionTranscriptV2Message extends Record<string, unknown>",
    );

    for (const [protocol, message] of [
      [missingResult, /missing runtime interface SessionTranscriptV2Result/],
      [
        invalidHeritage,
        /SessionTranscriptV2Message must extend JsonObject/,
      ],
    ] as const) {
      const fixture = await createFixture(protocol);
      await expect(
        synchronizeTranscriptV2Generated({
          runtimeProtocolPath: fixture.protocolPath,
          generatedPath: fixture.generatedPath,
          write: true,
        }),
      ).rejects.toThrow(message);
      expect(await readFile(fixture.generatedPath, "utf8")).toBe(
        "stale generated output\n",
      );
    }
  });

  it("mirrors member comments but deliberately excludes leading JSDoc", async () => {
    const fixture = await createCanonicalFixture();
    expect(fixture.expected).toContain("Member documentation is mirrored.");
    expect(fixture.expected).not.toContain(
      "Leading interface documentation is not mirrored.",
    );

    const changedLeadingJsdoc = runtimeProtocol().replace(
      "Leading interface documentation is not mirrored.",
      "Changed leading interface documentation is still not mirrored.",
    );
    await writeFile(fixture.protocolPath, changedLeadingJsdoc, "utf8");
    const result = await synchronizeTranscriptV2Generated({
      runtimeProtocolPath: fixture.protocolPath,
      generatedPath: fixture.generatedPath,
    });
    expect(result).toMatchObject({ changed: false, matches: true });
  });
});
