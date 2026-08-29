import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  getWalletCliStatus,
  installLatestWalletCli,
  resolveWalletCliExecutable,
} from "../../../src/services/Ledger/walletCli.js";

const homes: string[] = [];

async function tempAgencHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "agenc-wallet-cli-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("Ledger wallet-cli managed installation", () => {
  test("reports missing without executing an unrelated PATH command", async () => {
    const agencHome = await tempAgencHome();
    const status = await getWalletCliStatus({
      agencHome,
      env: { HOME: join(agencHome, "home"), PATH: "" },
    });

    expect(status).toEqual({
      installed: false,
      executable: null,
      source: null,
      version: null,
      installTool: "install_ledger_wallet_cli",
      package: "@ledgerhq/wallet-cli",
    });
  });

  test("resolves a valid AgenC-managed current installation", async () => {
    const agencHome = await tempAgencHome();
    const executable = join(
      agencHome,
      "tools",
      "wallet-cli",
      "versions",
      "2.0.1",
      "bin",
      "wallet-cli",
    );
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, "binary");
    await chmod(executable, 0o700);
    await writeFile(
      join(agencHome, "tools", "wallet-cli", "current.json"),
      JSON.stringify({
        schemaVersion: 1,
        package: "@ledgerhq/wallet-cli",
        platformPackage: "@ledgerhq/wallet-cli-linux-x64",
        version: "2.0.1",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        installedAt: "2026-07-29T00:00:00.000Z",
      }),
    );

    await expect(
      resolveWalletCliExecutable({
        agencHome,
        env: { HOME: agencHome, PATH: "" },
        platform: "linux",
        arch: "x64",
      }),
    ).resolves.toEqual({
      path: executable,
      source: "managed",
      version: "2.0.1",
    });
  });

  test.skipIf(process.platform === "win32")(
    "accepts a wallet-cli symlink found on PATH",
    async () => {
      const agencHome = await tempAgencHome();
      const binDirectory = join(agencHome, "path-bin");
      const target = join(agencHome, "wallet-cli-target");
      const executable = join(binDirectory, "wallet-cli");
      await mkdir(binDirectory);
      await writeFile(target, "binary");
      await chmod(target, 0o700);
      await symlink(target, executable);

      await expect(
        resolveWalletCliExecutable({
          agencHome,
          env: { HOME: agencHome, PATH: binDirectory },
          platform: "linux",
          arch: "x64",
        }),
      ).resolves.toEqual({
        path: executable,
        source: "path",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses a symlinked managed tool root before downloading",
    async () => {
      const agencHome = await tempAgencHome();
      const toolsDirectory = join(agencHome, "tools");
      const externalDirectory = join(agencHome, "external-wallet-cli");
      await mkdir(toolsDirectory);
      await mkdir(externalDirectory);
      await symlink(
        externalDirectory,
        join(toolsDirectory, "wallet-cli"),
        "dir",
      );
      const fetchImpl = vi.fn();

      await expect(
        installLatestWalletCli({
          agencHome,
          dependencies: {
            fetchImpl: fetchImpl as typeof globalThis.fetch,
            platform: "linux",
            arch: "x64",
          },
        }),
      ).rejects.toThrow("must be a real directory");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test("checks registry latest on every approved install and reuses a verified current binary", async () => {
    const agencHome = await tempAgencHome();
    const archiveBytes = Buffer.from("fixture wallet-cli archive");
    const integrity = `sha512-${createHash("sha512")
      .update(archiveBytes)
      .digest("base64")}`;
    const tarball =
      "https://registry.npmjs.org/@ledgerhq/wallet-cli-linux-x64/-/wallet-cli-linux-x64-2.0.1.tgz";
    let archiveRequests = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("%40ledgerhq%2Fwallet-cli/latest")) {
        const body = JSON.stringify({
          name: "@ledgerhq/wallet-cli",
          version: "2.0.1",
          optionalDependencies: {
            "@ledgerhq/wallet-cli-linux-x64": "2.0.1",
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-length": String(Buffer.byteLength(body)) },
        });
      }
      if (
        url.endsWith(
          "%40ledgerhq%2Fwallet-cli-linux-x64/2.0.1",
        )
      ) {
        const body = JSON.stringify({
          name: "@ledgerhq/wallet-cli-linux-x64",
          version: "2.0.1",
          bin: { "wallet-cli": "./bin/wallet-cli" },
          dist: {
            tarball,
            integrity,
            unpackedSize: 143_253_964,
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-length": String(Buffer.byteLength(body)) },
        });
      }
      if (url === tarball) {
        archiveRequests += 1;
        return new Response(archiveBytes, {
          status: 200,
          headers: { "content-length": String(archiveBytes.byteLength) },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;
    const extractPackage = vi.fn(
      async (
        _archive: string,
        destination: string,
      ): Promise<string> => {
        const executable = join(destination, "bin", "wallet-cli");
        await mkdir(join(destination, "bin"), { recursive: true });
        await writeFile(executable, "verified fixture");
        await chmod(executable, 0o700);
        return executable;
      },
    );
    const verifyExecutable = vi.fn(async () => {});
    const dependencies = {
      fetchImpl,
      platform: "linux" as const,
      arch: "x64" as const,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
      extractPackage,
      verifyExecutable,
    };

    const first = await installLatestWalletCli({
      agencHome,
      dependencies,
    });
    const second = await installLatestWalletCli({
      agencHome,
      dependencies,
    });

    expect(first.alreadyCurrent).toBe(false);
    expect(second.alreadyCurrent).toBe(true);
    expect(first.version).toBe("2.0.1");
    expect(archiveRequests).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(extractPackage).toHaveBeenCalledOnce();
    expect(verifyExecutable).toHaveBeenCalledTimes(2);
    await expect(readFile(first.executable, "utf8")).resolves.toBe(
      "verified fixture",
    );
    const current = JSON.parse(
      await readFile(
        join(agencHome, "tools", "wallet-cli", "current.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(current).toMatchObject({
      schemaVersion: 1,
      package: "@ledgerhq/wallet-cli",
      platformPackage: "@ledgerhq/wallet-cli-linux-x64",
      version: "2.0.1",
      integrity,
      installedAt: "2026-07-29T12:00:00.000Z",
    });
  });

  test("extracts the verified platform package into the managed version directory", async () => {
    const agencHome = await tempAgencHome();
    const fixtureRoot = join(agencHome, "fixture");
    const packageRoot = join(fixtureRoot, "package");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await writeFile(join(packageRoot, "LICENSE"), "Apache-2.0");
    await writeFile(
      join(packageRoot, "THIRD_PARTY_NOTICES.md"),
      "fixture notices",
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@ledgerhq/wallet-cli-linux-x64",
        version: "2.0.1",
        bin: { "wallet-cli": "./bin/wallet-cli" },
      }),
    );
    await writeFile(join(packageRoot, "bin", "wallet-cli"), "native fixture");
    const archivePath = join(agencHome, "fixture.tgz");
    await createTar(
      {
        cwd: fixtureRoot,
        file: archivePath,
        gzip: true,
        portable: true,
      },
      ["package"],
    );
    const archiveBytes = await readFile(archivePath);
    const integrity = `sha512-${createHash("sha512")
      .update(archiveBytes)
      .digest("base64")}`;
    const tarball =
      "https://registry.npmjs.org/@ledgerhq/wallet-cli-linux-x64/-/wallet-cli-linux-x64-2.0.1.tgz";
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("%40ledgerhq%2Fwallet-cli/latest")) {
        return new Response(
          JSON.stringify({
            name: "@ledgerhq/wallet-cli",
            version: "2.0.1",
            optionalDependencies: {
              "@ledgerhq/wallet-cli-linux-x64": "2.0.1",
            },
          }),
          { status: 200 },
        );
      }
      if (
        url.endsWith(
          "%40ledgerhq%2Fwallet-cli-linux-x64/2.0.1",
        )
      ) {
        return new Response(
          JSON.stringify({
            name: "@ledgerhq/wallet-cli-linux-x64",
            version: "2.0.1",
            bin: { "wallet-cli": "./bin/wallet-cli" },
            dist: {
              tarball,
              integrity,
              unpackedSize: 1_024,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(archiveBytes, { status: 200 });
    }) as typeof globalThis.fetch;

    const installed = await installLatestWalletCli({
      agencHome,
      dependencies: {
        fetchImpl,
        platform: "linux",
        arch: "x64",
        verifyExecutable: vi.fn(async () => {}),
      },
    });

    await expect(readFile(installed.executable, "utf8")).resolves.toBe(
      "native fixture",
    );
    await expect(
      readFile(
        join(
          agencHome,
          "tools",
          "wallet-cli",
          "versions",
          "2.0.1",
          "THIRD_PARTY_NOTICES.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("fixture notices");
  });

  test("refuses an archive whose bytes do not match npm sha512 metadata", async () => {
    const agencHome = await tempAgencHome();
    const expectedIntegrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
    const tarball =
      "https://registry.npmjs.org/@ledgerhq/wallet-cli-linux-x64/-/wallet-cli-linux-x64-2.0.1.tgz";
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("%40ledgerhq%2Fwallet-cli/latest")) {
        return new Response(
          JSON.stringify({
            name: "@ledgerhq/wallet-cli",
            version: "2.0.1",
            optionalDependencies: {
              "@ledgerhq/wallet-cli-linux-x64": "2.0.1",
            },
          }),
          { status: 200 },
        );
      }
      if (
        url.endsWith(
          "%40ledgerhq%2Fwallet-cli-linux-x64/2.0.1",
        )
      ) {
        return new Response(
          JSON.stringify({
            name: "@ledgerhq/wallet-cli-linux-x64",
            version: "2.0.1",
            bin: { "wallet-cli": "./bin/wallet-cli" },
            dist: {
              tarball,
              integrity: expectedIntegrity,
              unpackedSize: 143_253_964,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("tampered", { status: 200 });
    }) as typeof globalThis.fetch;

    await expect(
      installLatestWalletCli({
        agencHome,
        dependencies: {
          fetchImpl,
          platform: "linux",
          arch: "x64",
          extractPackage: vi.fn(),
          verifyExecutable: vi.fn(),
        },
      }),
    ).rejects.toThrow("sha512 integrity verification");
  });
});
