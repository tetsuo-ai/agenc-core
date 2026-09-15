import { describe, expect, test } from "vitest";

import {
  childApprovalRevocationSignal,
  isApprovalSessionOwnedBy,
  observeChildApprovalSessions,
  registerChildApprovalSession,
  revokeChildApprovalSession,
} from "../../src/agents/child-approval-context.js";
import type { Session } from "../../src/session/session.js";

interface SessionStub {
  abortController: AbortController;
  onBeforeDurableClose: (listener: () => void) => () => void;
  fireClose: () => void;
}

function makeSession(): Session & SessionStub {
  let close: (() => void) | undefined;
  const stub: SessionStub = {
    abortController: new AbortController(),
    onBeforeDurableClose(listener) {
      close = listener;
      return () => {
        if (close === listener) close = undefined;
      };
    },
    fireClose() {
      close?.();
    },
  };
  return stub as Session & SessionStub;
}

describe("child approval ownership", () => {
  test("binds the exact parent and refuses a second owner or a cycle", () => {
    const parent = makeSession();
    const child = makeSession();
    registerChildApprovalSession(child, parent);
    expect(isApprovalSessionOwnedBy(child, parent)).toBe(true);
    expect(isApprovalSessionOwnedBy(parent, parent)).toBe(true);
    expect(isApprovalSessionOwnedBy(parent, child)).toBe(false);
    expect(() => registerChildApprovalSession(child, parent)).toThrow(
      /already assigned or cyclic/,
    );
    expect(() => registerChildApprovalSession(parent, child)).toThrow(
      /already assigned or cyclic/,
    );
  });

  test("lookup fails closed after parent abort, child abort, or explicit revoke", () => {
    const parentAbort = makeSession();
    const childAbort = makeSession();
    registerChildApprovalSession(childAbort, parentAbort);
    parentAbort.abortController.abort();
    expect(isApprovalSessionOwnedBy(childAbort, parentAbort)).toBe(false);
    expect(childApprovalRevocationSignal(childAbort)?.aborted).toBe(true);

    const parentChild = makeSession();
    const childSelf = makeSession();
    registerChildApprovalSession(childSelf, parentChild);
    childSelf.abortController.abort();
    expect(isApprovalSessionOwnedBy(childSelf, parentChild)).toBe(false);

    const parentRevoke = makeSession();
    const childRevoke = makeSession();
    registerChildApprovalSession(childRevoke, parentRevoke);
    revokeChildApprovalSession(childRevoke);
    expect(isApprovalSessionOwnedBy(childRevoke, parentRevoke)).toBe(false);
  });

  test("observers see descendants, and close releases ownership for a replacement", () => {
    const root = makeSession();
    const mid = makeSession();
    const leaf = makeSession();
    const seen: Session[] = [];
    const unsubscribe = observeChildApprovalSessions(root, (child) => {
      seen.push(child);
      return () => {};
    });
    registerChildApprovalSession(mid, root);
    registerChildApprovalSession(leaf, mid);
    expect(seen).toEqual([mid, leaf]);
    expect(isApprovalSessionOwnedBy(leaf, root)).toBe(true);
    unsubscribe();

    mid.fireClose();
    expect(isApprovalSessionOwnedBy(mid, root)).toBe(false);
    const replacement = makeSession();
    registerChildApprovalSession(replacement, root);
    expect(isApprovalSessionOwnedBy(replacement, root)).toBe(true);
  });
});
