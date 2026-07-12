import { describe, expect, it } from "vitest";
import { assertCronWebhookUrlSafe } from "../gateway/cron-delivery.js";

describe("assertCronWebhookUrlSafe (todo-111)", () => {
  it("blocks loopback and private literals", async () => {
    await expect(
      assertCronWebhookUrlSafe("http://127.0.0.1/hook"),
    ).rejects.toThrow(/private|localhost|link-local/i);
    await expect(
      assertCronWebhookUrlSafe("https://169.254.169.254/latest"),
    ).rejects.toThrow(/private|link-local/i);
    await expect(
      assertCronWebhookUrlSafe("http://[::1]/"),
    ).rejects.toThrow(/private|link-local/i);
  });

  it("blocks localhost names", async () => {
    await expect(
      assertCronWebhookUrlSafe("http://localhost/h"),
    ).rejects.toThrow(/localhost/i);
  });
});
