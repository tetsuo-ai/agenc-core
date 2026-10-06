import { describe, expect, it } from "vitest";

import {
  isUndeliverableApproval,
  sessionEventDelivery,
} from "../../src/app-server/approval-delivery.js";

const PERMISSION = { method: "event.permission_request" };
const OTHER = { method: "event.agent_message" };

describe("sessionEventDelivery", () => {
  it("does not ask about pending listings when a client already received the request", async () => {
    let listings = 0;
    const delivery = await sessionEventDelivery(
      PERMISSION,
      { deliveredClientIds: ["desktop"] },
      () => {
        listings += 1;
        return true;
      },
    );
    expect(delivery).toEqual({ deliveredClientIds: ["desktop"] });
    expect(listings).toBe(0);
  });

  it("does not ask about pending listings for a non-approval event", async () => {
    let listings = 0;
    const delivery = await sessionEventDelivery(
      OTHER,
      { deliveredClientIds: [] },
      () => {
        listings += 1;
        return false;
      },
    );
    expect(delivery).toEqual({ deliveredClientIds: [] });
    expect(listings).toBe(0);
  });

  it("records whether anyone can list a request that reached nobody", async () => {
    const unseen = await sessionEventDelivery(
      PERMISSION,
      { deliveredClientIds: [] },
      () => false,
    );
    expect(unseen).toEqual({ deliveredClientIds: [], pendingListing: false });

    const listed = await sessionEventDelivery(
      PERMISSION,
      { deliveredClientIds: [] },
      async () => true,
    );
    expect(listed).toEqual({ deliveredClientIds: [], pendingListing: true });
  });

  it("copies the delivered ids so the broadcast result is not shared", async () => {
    const deliveredClientIds = ["desktop"];
    const delivery = await sessionEventDelivery(
      PERMISSION,
      { deliveredClientIds },
      () => false,
    );
    deliveredClientIds.push("later");
    expect(delivery.deliveredClientIds).toEqual(["desktop"]);
  });
});

describe("isUndeliverableApproval", () => {
  it("is true only when nobody received the request and nobody can list it", () => {
    expect(isUndeliverableApproval({ deliveredClientIds: [], pendingListing: false })).toBe(
      true,
    );
    expect(isUndeliverableApproval({ deliveredClientIds: [] })).toBe(true);
    expect(isUndeliverableApproval({ deliveredClientIds: [], pendingListing: true })).toBe(
      false,
    );
    expect(isUndeliverableApproval({ deliveredClientIds: ["desktop"] })).toBe(false);
  });

  it("never treats a missing or malformed binding as proof nobody can show it", () => {
    expect(isUndeliverableApproval(undefined)).toBe(false);
    expect(isUndeliverableApproval(null)).toBe(false);
    expect(isUndeliverableApproval("undelivered")).toBe(false);
    expect(isUndeliverableApproval({ pendingListing: false })).toBe(false);
    expect(isUndeliverableApproval({ deliveredClientIds: "desktop" })).toBe(false);
  });
});
