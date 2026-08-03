import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ModuleKind,
  ScriptTarget,
  flattenDiagnosticMessageText,
  transpileDeclaration,
  type Diagnostic,
} from "typescript";
import { describe, expect, it } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";

const RUNTIME_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUDGET_SOURCE_ROOT = join(RUNTIME_ROOT, "src", "budget");

const REMOVED_SOURCE_FILES = ["ledger.ts", "enforcer.ts", "pricing.ts"] as const;
const REMOVED_EXPORT_NAMES = [
  "BudgetLedger",
  "BudgetLedgerOptions",
  "windowKeys",
  "BudgetEnforcer",
  "BudgetEnforcerOptions",
  "createModelPriceResolver",
  "BudgetWindowSpend",
  "AgentBudgetState",
  "BudgetUsage",
  "AdmitRequest",
  "BudgetRefusalReason",
  "AdmitResult",
  "BudgetHold",
  "PersistedBudgetHold",
  "ReconcileResult",
  "BudgetNotification",
  "BudgetNotifier",
  "ModelPrice",
  "ModelPriceResolver",
] as const;
const REMOVED_PACKAGE_SUBPATHS = [
  "./budget/ledger",
  "./budget/enforcer",
  "./budget/pricing",
] as const;

interface RuntimePackageManifest {
  readonly types: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

function declarationFor(sourcePath: string): string {
  const result = transpileDeclaration(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ModuleKind.NodeNext,
      target: ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const diagnostics = result.diagnostics ?? [];
  expect(formatDiagnostics(diagnostics)).toEqual([]);
  return result.outputText;
}

function formatDiagnostics(diagnostics: readonly Diagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) =>
    flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
}

function packageExportKeyMatches(key: string, subpath: string): boolean {
  if (key === subpath) return true;
  const wildcardIndex = key.indexOf("*");
  if (wildcardIndex === -1) return false;
  const prefix = key.slice(0, wildcardIndex);
  const suffix = key.slice(wildcardIndex + 1);
  return subpath.startsWith(prefix) && subpath.endsWith(suffix);
}

describe("legacy JSON budget surface removal", () => {
  it("removes source, import, declaration, and package subpath surfaces", async () => {
    for (const fileName of REMOVED_SOURCE_FILES) {
      expect(existsSync(join(BUDGET_SOURCE_ROOT, fileName)), fileName).toBe(false);
    }

    const budgetModule: Readonly<Record<string, unknown>> = await import(
      "../../src/budget/index.js"
    );
    for (const exportName of REMOVED_EXPORT_NAMES) {
      expect(exportName in budgetModule, exportName).toBe(false);
    }

    const declarations = [
      join(BUDGET_SOURCE_ROOT, "index.ts"),
      join(BUDGET_SOURCE_ROOT, "types.ts"),
      join(RUNTIME_ROOT, "src", "index.ts"),
    ]
      .map(declarationFor)
      .join("\n");
    for (const exportName of REMOVED_EXPORT_NAMES) {
      expect(declarations, exportName).not.toMatch(
        new RegExp(`\\b${exportName}\\b`, "u"),
      );
    }

    const manifest = JSON.parse(
      readFileSync(join(RUNTIME_ROOT, "package.json"), "utf8"),
    ) as RuntimePackageManifest;
    expect(manifest.types).toBe("dist/index.d.ts");
    for (const subpath of REMOVED_PACKAGE_SUBPATHS) {
      const matchingKeys = Object.keys(manifest.exports).filter((key) =>
        packageExportKeyMatches(key, subpath),
      );
      expect(matchingKeys, subpath).toEqual([]);
    }
  });

  it("keeps SQLite authoritative when a legacy ledger file disagrees", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-json-ledger-removal-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-json-ledger-removal-cwd-"));
    const budgetIdentity = "legacy-json-authority-proof";
    const now = new Date("2026-08-01T12:00:00.000Z");
    const ledgerPath = join(agencHome, "budget", "ledger.json");
    mkdirSync(join(cwd, ".git"));
    writeLegacyLedger(ledgerPath, budgetIdentity, now, {
      paused: true,
      tokens: Number.MAX_SAFE_INTEGER,
    });

    const kernel = new ExecutionAdmissionKernel({
      agencHome,
      limits: {
        global: 1,
        workspace: 1,
        session: 1,
        parent: 1,
        provider: 1,
      },
      ownerId: "legacy-json-authority-proof",
      ownerPid: process.pid,
      now: () => now,
    });

    try {
      const client = kernel.bindClient({
        cwd,
        budgetIdentity,
        scope: {
          runId: "legacy-json-authority-run",
          sessionId: "legacy-json-authority-run",
          autonomous: true,
        },
        budget: { dailyTokens: 2 },
      });
      const first = await client.acquire(admissionRequest("first"));
      expect(
        client.reconcile(first.reservation.reservationId, {
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        }),
      ).toMatchObject({ applied: true });

      writeLegacyLedger(ledgerPath, budgetIdentity, now, {
        paused: false,
        tokens: 0,
      });
      await expect(client.acquire(admissionRequest("second"))).rejects.toMatchObject({
        reason: "budget_exceeded",
      });
    } finally {
      kernel.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function admissionRequest(stepId: string) {
  return {
    stepId,
    kind: "model_turn" as const,
    model: "test-model",
    provider: "test-provider",
    maxInputTokens: 1,
    maxOutputTokens: 1,
    maxCostUsd: 0,
  };
}

function writeLegacyLedger(
  ledgerPath: string,
  agentId: string,
  now: Date,
  state: { readonly paused: boolean; readonly tokens: number },
): void {
  const dayKey = now.toISOString().slice(0, 10);
  const monthKey = dayKey.slice(0, 7);
  const window = (key: string) => ({ key, usd: 0, tokens: state.tokens });
  const contents = {
    version: 1,
    agents: {
      [agentId]: {
        agentId,
        day: window(dayKey),
        month: window(monthKey),
        paused: state.paused,
        softWarned: { day: false, month: false },
      },
    },
    holds: {},
  };

  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(contents)}\n`, { mode: 0o600 });
}
