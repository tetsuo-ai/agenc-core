import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";
import {
  mergeGatewayCredentialEnvironment,
  readGatewayCredentialEnvironment,
  readGatewayGeneratedToken,
  resolveGatewayGeneratedToken,
  updateGatewayCredentialEnvironment,
} from "../../src/gateway/credentials.js";
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from "../../src/utils/secureStorage/native.js";

const roots: string[] = [];

function home() {
  const path = mkdtempSync(join(tmpdir(), "agenc-gateway-credentials-"));
  roots.push(path);
  return resolveHomeContext({ AGENC_HOME: path });
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("gateway native credential authority", () => {
  test("isolates two homes and preserves unrelated vault namespaces", () => {
    const first = home();
    const second = home();
    updateNativeSecureStorage(
      first,
      (current) => ({ ...current, primaryApiKey: "provider-secret" }),
      "test vault unavailable",
    );

    updateGatewayCredentialEnvironment(first, {
      AGENC_TELEGRAM_BOT_TOKEN: "telegram-first",
    });
    updateGatewayCredentialEnvironment(second, {
      AGENC_TELEGRAM_BOT_TOKEN: "telegram-second",
    });

    expect(readGatewayCredentialEnvironment(first)).toEqual({
      AGENC_TELEGRAM_BOT_TOKEN: "telegram-first",
    });
    expect(readGatewayCredentialEnvironment(second)).toEqual({
      AGENC_TELEGRAM_BOT_TOKEN: "telegram-second",
    });
    expect(readNativeSecureStorage(first).primaryApiKey).toBe("provider-secret");
  });

  test("gives explicit environment values precedence without mutating the vault", () => {
    const context = home();
    updateGatewayCredentialEnvironment(context, {
      AGENC_DISCORD_BOT_TOKEN: "stored-token",
    });

    expect(mergeGatewayCredentialEnvironment(context, {
      AGENC_DISCORD_BOT_TOKEN: "explicit-token",
      PATH: "/usr/bin",
    })).toMatchObject({
      AGENC_DISCORD_BOT_TOKEN: "explicit-token",
      PATH: "/usr/bin",
    });
    expect(readGatewayCredentialEnvironment(context)).toEqual({
      AGENC_DISCORD_BOT_TOKEN: "stored-token",
    });
  });

  test("persists generated surface tokens per home with serialized native RMW", () => {
    const first = home();
    const second = home();
    const firstToken = resolveGatewayGeneratedToken(first, "hooks", undefined);

    expect(firstToken.length).toBeGreaterThanOrEqual(16);
    expect(resolveGatewayGeneratedToken(first, "hooks", undefined)).toBe(
      firstToken,
    );
    expect(readGatewayGeneratedToken(first, "hooks")).toBe(firstToken);
    expect(resolveGatewayGeneratedToken(second, "hooks", undefined)).not.toBe(
      firstToken,
    );
  });

  test("rejects persistent non-secret settings and empty credentials", () => {
    const context = home();
    expect(() => updateGatewayCredentialEnvironment(context, {
      AGENC_GATEWAY_HELIUS_DAILY_LIMIT: "10",
    })).toThrow(/not a gateway credential.*config\.toml/u);
    expect(() => updateGatewayCredentialEnvironment(context, {
      AGENC_SLACK_BOT_TOKEN: "  ",
    })).toThrow(/non-empty credential/u);
    expect(readGatewayCredentialEnvironment(context)).toEqual({});
  });
});
