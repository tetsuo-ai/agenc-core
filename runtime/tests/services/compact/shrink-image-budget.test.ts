import { afterEach, describe, expect, test, vi } from "vitest";

import { MAX_TOKEN_ACCOUNTING_REQUEST_BYTES } from "../../../src/llm/token-accounting.js";
import {
  CONTEXT_IMAGE_BUDGET_ENV,
  DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES,
  DEEPSEEK_CONTEXT_IMAGE_BUDGET_BYTES,
} from "../../../src/session/query-image-budget.js";
import { shrinkAccountingImageBudgetBytes } from "../../../src/services/compact/transaction.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The budget the compaction shrink measurement applies to inline images (#2498). */
describe("shrinkAccountingImageBudgetBytes", () => {
  const sessionWithEnv = (env: NodeJS.ProcessEnv) =>
    ({ services: { userShell: { childEnvironment: env } } }) as never;
  const sessionWithoutShell = () => ({ services: {} }) as never;

  test("uses the operator's context image budget", () => {
    expect(shrinkAccountingImageBudgetBytes(sessionWithEnv({ [CONTEXT_IMAGE_BUDGET_ENV]: "5000" })))
      .toBe(5000);
  });

  test("uses the selected provider's budget for both shrink projections", () => {
    const session = sessionWithEnv({});
    expect(shrinkAccountingImageBudgetBytes(session, "deepseek")).toBe(DEEPSEEK_CONTEXT_IMAGE_BUDGET_BYTES);
    expect(shrinkAccountingImageBudgetBytes(session, "openai-compatible")).toBe(DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES);
    expect(shrinkAccountingImageBudgetBytes(sessionWithEnv({ [CONTEXT_IMAGE_BUDGET_ENV]: "8000000" }), "deepseek"))
      .toBe(8_000_000);
    for (const raw of ["0", "25165825"]) {
      expect(shrinkAccountingImageBudgetBytes(sessionWithEnv({ [CONTEXT_IMAGE_BUDGET_ENV]: raw }), "deepseek"))
        .toBe(DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES);
    }
  });

  test("measures with the default when the bound is disabled or would exceed the accounting cap", () => {
    expect(shrinkAccountingImageBudgetBytes(sessionWithEnv({ [CONTEXT_IMAGE_BUDGET_ENV]: "0" })))
      .toBe(DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES);
    expect(shrinkAccountingImageBudgetBytes(
      sessionWithEnv({ [CONTEXT_IMAGE_BUDGET_ENV]: String(MAX_TOKEN_ACCOUNTING_REQUEST_BYTES) }),
    )).toBe(DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES);
  });

  test("falls back to the process environment without a user shell", () => {
    vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "7000");
    expect(shrinkAccountingImageBudgetBytes(sessionWithoutShell())).toBe(7000);
  });
});
