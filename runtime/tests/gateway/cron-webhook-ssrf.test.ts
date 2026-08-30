import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCronWebhookUrlSafe,
  postCronWebhook,
  requestPinnedCronWebhook,
  type CronWebhookRequest,
  type CronWebhookRequester,
} from "../gateway/cron-delivery.js";

const PUBLIC_ADDRESS_A = "8.8.8.8";
const PUBLIC_ADDRESS_B = "1.1.1.1";

describe("assertCronWebhookUrlSafe", () => {
  it("blocks loopback, private, metadata, and mapped literals", async () => {
    for (const url of [
      "http://127.0.0.1/hook",
      "https://169.254.169.254/latest",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:a9fe:a9fe]/",
    ]) {
      await expect(assertCronWebhookUrlSafe(url)).rejects.toThrow(
        /blocked|private|loopback|metadata|link-local/i,
      );
    }
  });

  it("blocks reserved, documentation, benchmark, and multicast literals", async () => {
    for (const url of [
      "http://192.0.2.1/hook",
      "http://198.18.0.1/hook",
      "http://224.0.0.1/hook",
      "http://[2001:db8::1]/hook",
      "http://[ff02::1]/hook",
    ]) {
      await expect(assertCronWebhookUrlSafe(url)).rejects.toThrow(/blocked/i);
    }
  });

  it("blocks localhost names and embedded credentials", async () => {
    await expect(
      assertCronWebhookUrlSafe("http://localhost/h"),
    ).rejects.toThrow(/localhost/i);
    await expect(
      assertCronWebhookUrlSafe("https://user:secret@example.com/h"),
    ).rejects.toThrow(/credentials/i);
  });

  it("fails closed when any DNS answer is not public", async () => {
    await expect(
      assertCronWebhookUrlSafe("https://mixed.test/h", async () => [
        PUBLIC_ADDRESS_A,
        "10.0.0.8",
      ]),
    ).rejects.toThrow(/blocked|private/i);
  });

  it("fails closed on private IPv6 answers with dotted-decimal tails", async () => {
    await expect(
      assertCronWebhookUrlSafe("https://private.test/h", async () => [
        "fc00::192.0.2.1",
      ]),
    ).rejects.toThrow(/blocked|private/i);
  });

  it("fails closed on scoped private IPv6 answers", async () => {
    await expect(
      assertCronWebhookUrlSafe("https://private.test/h", async () => [
        "fe80::1%eth0",
      ]),
    ).rejects.toThrow(/blocked|private/i);
  });
});

describe("postCronWebhook", () => {
  it("passes only the approved address to the transport", async () => {
    const requests: CronWebhookRequest[] = [];
    let lookups = 0;

    await postCronWebhook(
      "https://public.test/hook",
      { ok: true },
      {
        lookup: async () => {
          lookups += 1;
          return lookups === 1 ? [PUBLIC_ADDRESS_A] : ["10.0.0.1"];
        },
        request: async (request) => {
          requests.push(request);
          return { statusCode: 204 };
        },
      },
    );

    expect(lookups).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      address: PUBLIC_ADDRESS_A,
      method: "POST",
    });
    expect(requests[0]!.url.hostname).toBe("public.test");
  });

  it("revalidates every redirect and rejects public-to-private transitions", async () => {
    const requests: CronWebhookRequest[] = [];
    const request: CronWebhookRequester = async (input) => {
      requests.push(input);
      return {
        statusCode: 302,
        location: "https://private.test/internal",
      };
    };

    await expect(
      postCronWebhook("https://public.test/hook", { ok: true }, {
        lookup: async (hostname) =>
          hostname === "public.test"
            ? [PUBLIC_ADDRESS_A]
            : ["169.254.169.254"],
        request,
      }),
    ).rejects.toThrow(/blocked|private|metadata|link-local/i);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.address).toBe(PUBLIC_ADDRESS_A);
  });

  it("pins each allowed redirect destination and preserves 307 POST bodies", async () => {
    const requests: CronWebhookRequest[] = [];
    const request: CronWebhookRequester = async (input) => {
      requests.push(input);
      return requests.length === 1
        ? {
            statusCode: 307,
            location: "https://next.test/deliver",
          }
        : { statusCode: 204 };
    };

    await postCronWebhook("https://public.test/hook", { ok: true }, {
      lookup: async (hostname) =>
        hostname === "public.test" ? [PUBLIC_ADDRESS_A] : [PUBLIC_ADDRESS_B],
      request,
    });

    expect(requests.map(({ address }) => address)).toEqual([
      PUBLIC_ADDRESS_A,
      PUBLIC_ADDRESS_B,
    ]);
    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST"]);
    expect(Buffer.from(requests[1]!.body!).toString("utf8")).toBe(
      '{"ok":true}',
    );
  });

  it("rejects redirect protocol and credential changes before another request", async () => {
    for (const location of [
      "http://next.test/hook",
      "https://user:secret@next.test/hook",
    ]) {
      let requests = 0;
      await expect(
        postCronWebhook("https://public.test/hook", { ok: true }, {
          lookup: async () => [PUBLIC_ADDRESS_A],
          request: async () => {
            requests += 1;
            return { statusCode: 302, location };
          },
        }),
      ).rejects.toThrow(/protocol|credentials/i);
      expect(requests).toBe(1);
    }
  });

  it("enforces a small redirect hop limit", async () => {
    let requests = 0;
    await expect(
      postCronWebhook("https://public.test/hook", { ok: true }, {
        maxRedirects: 1,
        lookup: async () => [PUBLIC_ADDRESS_A],
        request: async () => {
          requests += 1;
          return { statusCode: 307, location: "/again" };
        },
      }),
    ).rejects.toThrow(/too many redirects/i);
    expect(requests).toBe(2);
  });

  it("uses one deadline across DNS resolution and requests", async () => {
    await expect(
      postCronWebhook("https://slow.test/hook", { ok: true }, {
        timeoutMs: 20,
        lookup: async () => new Promise<readonly string[]>(() => {}),
        request: async () => {
          throw new Error("request must not start");
        },
      }),
    ).rejects.toThrow(/timed out/i);
  });
});

describe("requestPinnedCronWebhook", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  it("dials the approved IP without resolving the URL hostname", async () => {
    let receivedHost: string | undefined;
    let receivedBody = "";
    const server = createServer((request, response) => {
      receivedHost = request.headers.host;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(204).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    const url = new URL(`http://must-not-resolve.invalid:${port}/hook?q=1`);

    await expect(
      requestPinnedCronWebhook({
        url,
        address: "127.0.0.1",
        method: "POST",
        body: Buffer.from('{"pinned":true}', "utf8"),
        signal: AbortSignal.timeout(1_000),
      }),
    ).resolves.toEqual({ statusCode: 204 });

    expect(receivedHost).toBe(`must-not-resolve.invalid:${port}`);
    expect(receivedBody).toBe('{"pinned":true}');
  });
});
