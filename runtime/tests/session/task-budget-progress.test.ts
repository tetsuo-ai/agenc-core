import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTaskBudgetProgress } from "../../src/session/task-budget-progress.js";
import { TaskBudget, taskBudgetOf } from "../../src/session/task-budget.js";
import type { Session } from "../../src/session/session.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "budget-progress-")); roots.push(root);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const registration = { initialTokens: 100, nonce: "unique-host-task-1234", commandDigest: "a".repeat(64),
    publicKey: publicKey.export({ type: "spki", format: "pem" }), receiptPath: join(root, "receipt.json") };
  const raw = JSON.stringify(registration);
  const proof = { version: 1, nonce: registration.nonce, commandDigest: registration.commandDigest,
    initialTokens: 100, hardTokens: 200, beforeExitCode: 1, afterExitCode: 0, timedOut: false,
    beforeWorkspaceDigest: "b".repeat(64), afterWorkspaceDigest: "c".repeat(64) };
  function publish(overrides: object = {}) {
    const payload = JSON.stringify({ ...proof, ...overrides });
    writeFileSync(registration.receiptPath, JSON.stringify({ payload,
      signature: sign(null, Buffer.from(payload), privateKey).toString("base64") }));
  }
  return { raw, registration, proof, publish };
}
test("signed progress releases one tranche and survives reconstruction without raising the hard ceiling", () => {
  const f = fixture(); const limit = createTaskBudgetProgress(f.raw, 200);
  const budget = new TaskBudget(200, 4, limit); budget.tokens = 70;
  expect(budget.limit).toBe(100); budget.assertFits(20);
  f.publish(); expect(budget.limit).toBe(200); budget.assertFits(120);
  expect(budget.reminder()?.content).toContain("extended once to 200");
  expect(budget.reminder()).toBeUndefined();
  expect(createTaskBudgetProgress(f.raw, 200)()).toBe(200);
  expect(() => budget.assertFits(131)).toThrow("Task budget reached");
});
test.each([
  { nonce: "another-task" }, { commandDigest: "d".repeat(64) }, { hardTokens: 300 },
  { initialTokens: 50 }, { beforeExitCode: 0 }, { afterExitCode: 1 }, { timedOut: true },
  { afterWorkspaceDigest: "b".repeat(64) }, { beforeWorkspaceDigest: "invalid" },
])("invalid signed proof never releases tokens: %j", overrides => {
  const f = fixture(); f.publish(overrides); expect(createTaskBudgetProgress(f.raw, 200)()).toBe(100);
});
test("agent-authored unsigned or tampered receipts fail closed", () => {
  const f = fixture(); writeFileSync(f.registration.receiptPath, JSON.stringify({ payload: JSON.stringify(f.proof), signature: "forged" }));
  expect(createTaskBudgetProgress(f.raw, 200)()).toBe(100);
  writeFileSync(f.registration.receiptPath, "not JSON"); expect(createTaskBudgetProgress(f.raw, 200)()).toBe(100);
});
test("explicit token optout remains off and independent call cap remains binding", () => {
  const f = fixture(); f.publish();
  const session = { config: { taskTokenBudget: 0, experimentalTaskBudgetProgress: f.raw }, services: {} } as unknown as Session;
  expect(taskBudgetOf(session)).toBeUndefined();
  const budget = new TaskBudget(200, 1, createTaskBudgetProgress(f.raw, 200)); budget.calls = 1;
  expect(() => budget.assertFits(1)).toThrow("Task budget reached");
});
test("registration cannot relax a smaller configured cap", () => {
  const f = fixture(); expect(() => createTaskBudgetProgress(f.raw, 99)).toThrow();
});
test("one experimental session cannot dispatch concurrent attempts beyond the initial allowance", async () => {
  const f = fixture(); const budget = new TaskBudget(200, undefined, createTaskBudgetProgress(f.raw, 200));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const first = budget.invoke(60, async () => {
    calls++; await held;
    return { content: "", toolCalls: [], model: "test", finishReason: "stop",
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60, availability: "reported" } };
  });
  await expect(budget.invoke(60, async () => { calls++; throw new Error("must not dispatch"); })).rejects.toThrow("Task budget reached");
  expect(calls).toBe(1); release(); await first; expect(budget.tokens).toBe(60);
});
