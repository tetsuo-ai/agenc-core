import { describe, expect, test } from "vitest";

import { DENIED } from "../../src/permissions/review-decision.js";
import type { ApprovalResolver } from "../../src/tools/orchestrator.js";
import {
  notifyApprovalResolverReady,
  waitForApprovalResolver,
} from "../../src/tui/approval-resolver-ready.js";

function resolver(): ApprovalResolver {
  return { request: async () => DENIED };
}

describe("waitForApprovalResolver", () => {
  test("returns a mounted resolver and ignores an already-aborted wait", async () => {
    const approvalResolver = resolver();
    await expect(
      waitForApprovalResolver({ approvalResolver }, new AbortController().signal),
    ).resolves.toBe(approvalResolver);
    await expect(
      waitForApprovalResolver({}, AbortSignal.abort()),
    ).resolves.toBeUndefined();
  });

  test("wakes every waiter on the same services object once the UI mounts", async () => {
    const services: { approvalResolver?: ApprovalResolver } = {};
    const first = waitForApprovalResolver(services, new AbortController().signal);
    const second = waitForApprovalResolver(services, new AbortController().signal);
    const approvalResolver = resolver();
    services.approvalResolver = approvalResolver;
    notifyApprovalResolverReady(services);
    await expect(Promise.all([first, second])).resolves.toEqual([
      approvalResolver,
      approvalResolver,
    ]);
  });

  test("aborts waiters that never see a resolver and does not leak across objects", async () => {
    const waiting: { approvalResolver?: ApprovalResolver } = {};
    const other: { approvalResolver?: ApprovalResolver } = {};
    const controller = new AbortController();
    const aborted = waitForApprovalResolver(waiting, controller.signal);
    const isolated = waitForApprovalResolver(waiting, new AbortController().signal);
    let isolatedSettled = false;
    void isolated.then(() => {
      isolatedSettled = true;
    });
    notifyApprovalResolverReady(other);
    await Promise.resolve();
    expect(isolatedSettled).toBe(false);
    controller.abort();
    await expect(aborted).resolves.toBeUndefined();
    expect(isolatedSettled).toBe(false);
    const approvalResolver = resolver();
    waiting.approvalResolver = approvalResolver;
    notifyApprovalResolverReady(waiting);
    await expect(isolated).resolves.toBe(approvalResolver);
  });

  test("notify is a no-op when nobody is waiting", () => {
    expect(() => notifyApprovalResolverReady({})).not.toThrow();
  });
});
