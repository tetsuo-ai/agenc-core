import { describe, expect, test } from "vitest";
import type { ProviderEnvironment } from "../../../src/llm/provider-options.js";
import { createBedrockRuntimeClient } from "../../../src/utils/model/bedrock.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";

async function createClient(environment: ProviderEnvironment) {
  return runWithStartupProviderSelection(
    {
      provider: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
      environment,
    },
    () => createBedrockRuntimeClient(),
  );
}

describe("Bedrock SDK client settings", () => {
  test("projects canonical credential, region, and endpoint aliases", async () => {
    const client = await createClient({
      AWS_BEDROCK_ACCESS_KEY_ID: " bedrock-access ",
      AWS_ACCESS_KEY_ID: "fallback-access",
      AWS_BEDROCK_SECRET_ACCESS_KEY: " bedrock-secret ",
      AWS_SECRET_ACCESS_KEY: "fallback-secret",
      AWS_BEDROCK_SESSION_TOKEN: " bedrock-session ",
      AWS_BEDROCK_REGION: " ca-central-1 ",
      AWS_REGION: "us-west-2",
      AWS_BEDROCK_BASE_URL: " https://bedrock-proxy.example/v1 ",
    });

    try {
      await expect(client.config.region()).resolves.toBe("ca-central-1");
      await expect(client.config.credentials()).resolves.toMatchObject({
        accessKeyId: "bedrock-access",
        secretAccessKey: "bedrock-secret",
        sessionToken: "bedrock-session",
      });
      await expect(client.config.endpoint?.()).resolves.toMatchObject({
        protocol: "https:",
        hostname: "bedrock-proxy.example",
        path: "/v1",
      });
    } finally {
      client.destroy();
    }
  });

  test("uses the registry-owned default region and runtime endpoint", async () => {
    const client = await createClient({
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    });

    try {
      await expect(client.config.region()).resolves.toBe("us-east-1");
      await expect(client.config.credentials()).resolves.toMatchObject({
        accessKeyId: "access",
        secretAccessKey: "secret",
      });
      await expect(client.config.endpoint?.()).resolves.toMatchObject({
        protocol: "https:",
        hostname: "bedrock-runtime.us-east-1.amazonaws.com",
        path: "/",
      });
    } finally {
      client.destroy();
    }
  });

  test("rejects incomplete credentials instead of activating the AWS SDK chain", async () => {
    await expect(
      createClient({
        AWS_BEDROCK_ACCESS_KEY_ID: "access",
      }),
    ).rejects.toThrow(
      "Amazon Bedrock requires AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
    );
  });
});
