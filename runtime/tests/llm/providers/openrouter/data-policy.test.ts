import { describe, expect, test } from "vitest";

import {
  openRouterDataPolicyErrorMessage,
  readOpenRouterDataPolicyRefusal,
} from "./data-policy.js";

const ZDR_MESSAGE =
  "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy";
const ACCOUNT_MESSAGE =
  "No endpoints found matching your data policy (Paid model training). Configure: https://openrouter.ai/settings/privacy";
const ROUTING_STEP = "Filter by Data Policy";

function refusal(args: {
  readonly providerName?: string;
  readonly status?: number;
  readonly message?: string;
  readonly body?: unknown;
}) {
  return readOpenRouterDataPolicyRefusal({
    providerName: args.providerName ?? "openrouter",
    status: args.status ?? 404,
    message: args.message ?? "",
    body: args.body,
  });
}

describe("readOpenRouterDataPolicyRefusal", () => {
  test("classifies the documented 404 as a zero-data-retention refusal", () => {
    expect(refusal({
      message: ZDR_MESSAGE,
      body: { error: { message: ZDR_MESSAGE, code: 404, metadata: { failed_routing_step: ROUTING_STEP } } },
    })).toBe("zero-data-retention");
  });

  test("classifies an account policy 404 as other, including a routing-step-only body", () => {
    expect(refusal({ message: ACCOUNT_MESSAGE })).toBe("other");
    expect(refusal({
      body: { error: { metadata: { failed_routing_step: ROUTING_STEP } } },
    })).toBe("other");
  });

  test("leaves every other failure for the shared 404 path", () => {
    expect(refusal({ providerName: "openai", message: ZDR_MESSAGE })).toBeUndefined();
    expect(refusal({ status: 500, message: ZDR_MESSAGE })).toBeUndefined();
    expect(refusal({ message: "Not Found", body: { error: { message: "Not Found", code: 404 } } }))
      .toBeUndefined();
  });

  test("reads a string body and does not throw on a body JSON.stringify cannot print", () => {
    expect(refusal({ body: ZDR_MESSAGE })).toBe("zero-data-retention");
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(refusal({ message: "Not Found", body: circular })).toBeUndefined();
  });
});

describe("openRouterDataPolicyErrorMessage", () => {
  test("names the setting that turns ZDR off, and never the picker mark that is not shown", () => {
    const zdr = openRouterDataPolicyErrorMessage("zero-data-retention");
    expect(zdr).toContain("no zero-data-retention endpoint for this model");
    expect(zdr).toContain("not marked no ZDR");
    expect(zdr).toContain("zero_data_retention = false under [providers.openrouter]");
    expect(zdr).not.toContain("marked ZDR");

    const other = openRouterDataPolicyErrorMessage("other");
    expect(other).toContain("data policy for this account");
    expect(other).not.toContain("zero_data_retention");
  });
});
