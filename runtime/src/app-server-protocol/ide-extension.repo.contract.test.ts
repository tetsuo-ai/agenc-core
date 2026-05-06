import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENC_IDE_EXTENSION_PACKAGE_NAME,
  AGENC_IDE_EXTENSION_REPOSITORY_NAME,
} from "./ide-extension.js";

interface ExtensionPackageJson {
  readonly name?: string;
  readonly displayName?: string;
  readonly publisher?: string;
  readonly engines?: {
    readonly vscode?: string;
  };
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly {
      readonly command?: string;
      readonly title?: string;
    }[];
  };
  readonly dependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}

function findAgenCVscodeRepo(): string {
  const mainCheckoutCandidate = mainCheckoutSiblingCandidate();
  const candidates = [
    process.env.AGENC_VSCODE_REPO,
    mainCheckoutCandidate,
    resolve(process.cwd(), "..", "..", AGENC_IDE_EXTENSION_REPOSITORY_NAME),
    resolve(process.cwd(), "..", "..", "..", AGENC_IDE_EXTENSION_REPOSITORY_NAME),
  ].filter((candidate): candidate is string => typeof candidate === "string");

  const packagePath = candidates
    .map((candidate) => resolve(candidate, "package.json"))
    .find(existsSync);
  if (packagePath === undefined) {
    throw new Error("Missing agenc-vscode sibling repo package.json");
  }
  return dirname(packagePath);
}

function mainCheckoutSiblingCandidate(): string | undefined {
  const commonDir = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (commonDir.status !== 0) return undefined;
  const mainCheckout = dirname(commonDir.stdout.trim());
  return resolve(mainCheckout, "..", AGENC_IDE_EXTENSION_REPOSITORY_NAME);
}

describe("AgenC VS Code sibling repo scaffold", () => {
  it("exists as a local extension repo with the expected manifest", () => {
    const repoRoot = findAgenCVscodeRepo();
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    ) as ExtensionPackageJson;

    expect(pkg.name).toBe(AGENC_IDE_EXTENSION_PACKAGE_NAME);
    expect(pkg.displayName).toBe("AgenC");
    expect(pkg.publisher).toBe("tetsuo-ai");
    expect(pkg.engines?.vscode).toBe("^1.90.0");
    expect(pkg.activationEvents).toContain("onCommand:agenc.connectDaemon");
    expect(pkg.contributes?.commands?.[0]).toEqual({
      command: "agenc.connectDaemon",
      title: "AgenC: Connect to Daemon",
    });
    expect(pkg.dependencies?.["@tetsuo-ai/protocol"]).toBe(
      "file:../agenc-protocol/packages/protocol",
    );
    expect(pkg.dependencies?.["@tetsuo-ai/runtime"]).toBe(
      "file:../agenc-core/runtime",
    );
    expect(pkg.scripts?.["test:scaffold"]).toBe("node test/scaffold.test.mjs");
  });

  it("anchors the extension activation module to the shared IDE protocol", () => {
    const repoRoot = findAgenCVscodeRepo();
    const source = readFileSync(resolve(repoRoot, "src/extension.ts"), "utf8");
    const hasInitialProtocolStub =
      source.includes("AGENC_IDE_EXTENSION_SCAFFOLD") &&
      source.includes("createAgenCIdeInitializeParams");
    const hasDaemonProtocolConnection =
      source.includes("AgenCDaemonProcess") &&
      source.includes("daemon.connect()");

    expect(hasInitialProtocolStub || hasDaemonProtocolConnection).toBe(true);
    expect(source).toContain("agenc.connectDaemon");
  });

  it("requires the daemon-backed activation path once the daemon module exists", () => {
    const repoRoot = findAgenCVscodeRepo();
    const daemonModulePath = resolve(repoRoot, "src/daemon.ts");
    if (!existsSync(daemonModulePath)) return;

    const extensionSource = readFileSync(
      resolve(repoRoot, "src/extension.ts"),
      "utf8",
    );
    const daemonSource = readFileSync(daemonModulePath, "utf8");

    expect(extensionSource).toContain("AgenCDaemonProcess");
    expect(extensionSource).toContain("daemon.connect()");
    expect(extensionSource).toContain("showErrorMessage");
    expect(daemonSource).toContain("sendAgenCDaemonInitializeRequest");
    expect(daemonSource).toContain("connectAgenCDaemonSocket");
  });
});
