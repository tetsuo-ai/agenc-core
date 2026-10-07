import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";

export let home: string;
export let cwd: string;
export const kernels: ExecutionAdmissionKernel[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-child-budget-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-child-budget-project-"));
  mkdirSync(join(cwd, ".git"));
});
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

export function kernel() {
  const value = new ExecutionAdmissionKernel({ agencHome: home,
    limits: { global: 20, workspace: 20, session: 20, parent: 20, provider: 20 } });
  kernels.push(value);
  return value;
}
export function root(value: ExecutionAdmissionKernel, maxCostUsd?: number, maxTokens?: number) {
  return value.bindClient({ cwd, scope: { runId: "root", sessionId: "root", autonomous: false,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) } });
}
export function acquire(client: ExecutionAdmissionClient, stepId: string, cost: number, tokens = 1) {
  return client.acquire({ stepId, kind: "model_turn", model: "budget-model", provider: "budget-provider",
    maxInputTokens: tokens, maxOutputTokens: 0, maxCostUsd: cost });
}
export function reconcile(client: ExecutionAdmissionClient, lease: AdmissionLease, cost: number, tokens = 1) {
  client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
  client.reconcile(lease.reservation.reservationId, { inputTokens: tokens, outputTokens: 0, costUsd: cost });
  client.acknowledgeCompletion(lease.reservation.reservationId);
}
