import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalSecretKey,
  environmentIdFromCwd,
  environmentSecretScope,
  GLOBAL_SECRET_SCOPE,
  REDACTED_SECRET,
  redactSecrets,
  redactSecretsInValue,
  SecretName,
} from "./index.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agenc-secrets-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("secrets sanitizer", () => {
  it("redacts common API keys and token forms", () => {
    const input = [
      "openai=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "openai-dash=sk-proj-abcdefghijklmnopqrstuvwxyz123456-",
      "anthropic=sk-ant-abcdefghijklmnopqrstuvwxyz123456",
      "groq=gsk_abcdefghijklmnopqrstuvwxyz123456",
      "github=ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ123456",
      "aws=AKIA1234567890ABCDEF",
      "auth Bearer abcdefghijklmnopqrstuvwxyz.1234567890",
      "auth2 Bearer abcdefghijklmnop=",
      "auth3 Bearer abcdefghijklmnop;",
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456-");
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted.match(new RegExp(REDACTED_SECRET, "g"))?.length).toBeGreaterThanOrEqual(6);
    expect(redacted).toContain(`Bearer ${REDACTED_SECRET}`);
    expect(redacted).not.toContain(`${REDACTED_SECRET}=`);
    expect(redacted).toContain(`Bearer ${REDACTED_SECRET};`);
  });

  it("redacts vendor key shapes lacking a key/context word", () => {
    // Vendor tokens assembled from fragments so the test fixture is not
    // flagged as a real secret by push-protection / secret scanning; the
    // runtime values still match the sanitizer's vendor patterns.
    const xaiToken = "xai-" + "abcdefghijklmnopqrstuvwxyz0123456789";
    const slackToken = ["xoxb", "1234567890", "abcdefghijklmnopqrstuvwx"].join("-");
    const googleToken = "AIza" + "0123456789abcdefghijklmnopqrstuvwxy";
    const input = [
      xaiToken,
      `slack=${slackToken}`,
      `google=${googleToken}`,
      "aws_secret_access_key=abcd1234EFGH5678ijkl9012MNOP3456qrst7890",
      "secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      '{"aws_secret_access_key": "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY"}',
      "The meeting lasted forty minutes and everyone seemed satisfied",
      "value=abcd1234EFGH5678ijkl9012MNOP3456qrst7890",
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain(xaiToken);
    expect(redacted).not.toContain(slackToken);
    expect(redacted).not.toContain(googleToken);
    expect(redacted).toContain(`aws_secret_access_key=${REDACTED_SECRET}`);
    expect(redacted).toContain(`secret_access_key = ${REDACTED_SECRET}`);
    // JSON-quoted AWS key:value (closing quote before the colon) is redacted.
    expect(redacted).not.toContain("je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY");
    expect(redacted).toContain(`"aws_secret_access_key": "${REDACTED_SECRET}"`);
    // False-positive guard: a bare 40-char-ish word in prose stays visible.
    expect(redacted).toContain("forty minutes and everyone seemed satisfied");
    // A 40-char base64 value with no aws/secret context is NOT AWS-redacted.
    expect(redacted).toContain("value=abcd1234EFGH5678ijkl9012MNOP3456qrst7890");
  });

  it("redacts AWS secret/access-key fields on the structured-object path", () => {
    const artifact = {
      credentials: {
        aws_secret_access_key: "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        aws_access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secretKey: "opaque-value-12345",
      },
      // False-positive guard: non-secret `...key` names stay visible.
      publicKey: "ssh-rsa AAAAB3NzaC1yc2EexamplePublicKeyMaterial",
      keyCount: 42,
    };

    const redacted = redactSecretsInValue(artifact);

    expect(redacted).toEqual({
      credentials: {
        aws_secret_access_key: REDACTED_SECRET,
        secret_access_key: REDACTED_SECRET,
        aws_access_key_id: REDACTED_SECRET,
        secretKey: REDACTED_SECRET,
      },
      publicKey: "ssh-rsa AAAAB3NzaC1yc2EexamplePublicKeyMaterial",
      keyCount: 42,
    });
  });

  it("redacts JWTs and secret-looking assignments", () => {
    const input = [
      "jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureValue123-",
      "api_key = \"abc123456789xyz\"",
      "{\"api_key\":\"abc123456789xyz\"}",
      "{\"accessToken\":\"abcdef1234567890\"}",
      "password: hunter2-secret",
      "short token=abc stays visible",
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain("signatureValue123-");
    expect(redacted).not.toContain("abcdef1234567890");
    expect(redacted).toContain(`api_key = "${REDACTED_SECRET}"`);
    expect(redacted).toContain(`"api_key":"${REDACTED_SECRET}"`);
    expect(redacted).toContain(`"accessToken":"${REDACTED_SECRET}"`);
    expect(redacted).toContain(`password: ${REDACTED_SECRET}`);
    expect(redacted).toContain("short token=abc stays visible");
  });

  it("redacts common compound token and secret field names", () => {
    const input = [
      "{\"id_token\":\"opaque-value-12345\"}",
      "{\"sessionToken\":\"opaque-value-12345\"}",
      "{\"client_secret\":\"opaque-value-12345\"}",
      "refreshTokenValue=opaque-value-12345",
      "postCompactTokens=12345678",
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain("opaque-value-12345");
    expect(redacted).toContain(`"id_token":"${REDACTED_SECRET}"`);
    expect(redacted).toContain(`"sessionToken":"${REDACTED_SECRET}"`);
    expect(redacted).toContain(`"client_secret":"${REDACTED_SECRET}"`);
    expect(redacted).toContain(`refreshTokenValue=${REDACTED_SECRET}`);
    expect(redacted).toContain("postCompactTokens=12345678");
  });

  it("redacts nested artifact values without mutating the input", () => {
    const artifact = {
      event: "hook_output",
      stdout: "token=abcdef1234567890",
      nested: {
        args: ["safe", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
        credentials: {
          apiKey: "opaque-value-12345",
          token: "abcdef1234567890",
        },
      },
    };

    const redacted = redactSecretsInValue(artifact);

    expect(redacted).toEqual({
      event: "hook_output",
      stdout: `token=${REDACTED_SECRET}`,
      nested: {
        args: ["safe", `Authorization: Bearer ${REDACTED_SECRET}`],
        credentials: {
          apiKey: REDACTED_SECRET,
          token: REDACTED_SECRET,
        },
      },
    });
    expect(artifact.stdout).toBe("token=abcdef1234567890");
  });

  it("preserves object cycles while redacting strings", () => {
    const artifact: { token: string; self?: unknown } = {
      token: "token=abcdef1234567890",
    };
    artifact.self = artifact;

    const redacted = redactSecretsInValue(artifact) as typeof artifact;

    expect(redacted.token).toBe(REDACTED_SECRET);
    expect(redacted.self).toBe(redacted);
  });

  it("redacts nested compound token and secret keys without redacting counters", () => {
    const artifact = {
      oauth: {
        id_token: "opaque-value-12345",
        sessionToken: "opaque-value-12345",
        client_secret: "opaque-value-12345",
        refreshTokenValue: "opaque-value-12345",
        postCompactTokens: 12345678,
      },
    };

    const redacted = redactSecretsInValue(artifact);

    expect(redacted).toEqual({
      oauth: {
        id_token: REDACTED_SECRET,
        sessionToken: REDACTED_SECRET,
        client_secret: REDACTED_SECRET,
        refreshTokenValue: REDACTED_SECRET,
        postCompactTokens: 12345678,
      },
    });
  });

  it("validates secret names and canonical scope keys", () => {
    const name = SecretName.parse(" GITHUB_TOKEN ");

    expect(name.toString()).toBe("GITHUB_TOKEN");
    expect(canonicalSecretKey(GLOBAL_SECRET_SCOPE, name)).toBe("global/GITHUB_TOKEN");
    expect(canonicalSecretKey(environmentSecretScope("prod"), name)).toBe("env/prod/GITHUB_TOKEN");
    expect(() => SecretName.parse("github-token")).toThrow(/only A-Z/);
  });

  it("derives environment ids from git roots or canonical cwd hashes", () => {
    const repo = path.join(tempDir(), "repo-name");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const child = path.join(repo, "packages", "runtime");
    mkdirSync(child, { recursive: true });

    expect(environmentIdFromCwd(child)).toBe("repo-name");

    const plain = tempDir();
    const id = environmentIdFromCwd(plain);
    expect(id).toMatch(/^cwd-[a-f0-9]{12}$/);
  });
});
