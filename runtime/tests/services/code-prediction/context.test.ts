import { describe, expect, it } from "vitest";

import {
  buildCodePredictionMessages,
  compilePredictionIgnore,
  isSensitivePredictionPath,
  prepareCodePredictionContext,
} from "../../../src/services/code-prediction/context.js";
import type { CodePredictionRequest } from "../../../src/services/code-prediction/types.js";

function request(
  overrides: Partial<CodePredictionRequest> = {},
): CodePredictionRequest {
  const value = {
    requestId: "prediction-1",
    sessionId: "session-1",
    editorInstanceId: "editor-1",
    bufferHandle: 1,
    generation: 1,
    changedtick: 4,
    path: "/workspace/src/main.ts",
    language: "typescript",
    cursor: { line: 1, byteColumn: 2 },
    prefix: "const answer = ",
    suffix: ";\n",
    ...overrides,
  };
  return {
    ...value,
    fileBytes:
      overrides.fileBytes ??
      Buffer.byteLength(value.prefix, "utf8") +
        Buffer.byteLength(value.suffix, "utf8"),
  };
}

describe("code prediction context", () => {
  it("bounds model context around the cursor and emits a completion-only prompt", () => {
    const prepared = prepareCodePredictionContext({
      request: request({
        prefix: `${"a".repeat(30 * 1024)}const answer = `,
        suffix: `${";".repeat(12 * 1024)}\n`,
        header: "import { value } from './value.js';",
        latestIntent: "finish the calculation",
        diagnostics: [{ severity: "error", message: "expression expected" }],
        relatedBuffers: [
          {
            path: "/workspace/src/value.ts",
            language: "typescript",
            content: "export const value = 42;",
          },
          {
            path: "/workspace/src/other.ts",
            content: "export const other = 7;",
          },
          {
            path: "/workspace/src/ignored-third.ts",
            content: "export const third = 3;",
          },
        ],
      }),
      workspaceRoot: "/workspace",
    });

    expect("context" in prepared).toBe(true);
    if (!("context" in prepared)) return;
    expect(Buffer.byteLength(prepared.context.prefix)).toBeLessThanOrEqual(
      20 * 1024,
    );
    expect(Buffer.byteLength(prepared.context.suffix)).toBeLessThanOrEqual(
      8 * 1024,
    );
    expect(prepared.context.relatedBuffers).toHaveLength(2);
    const prompt = buildCodePredictionMessages(prepared.context);
    expect(prompt.systemPrompt).toContain("Return only the exact text");
    expect(prompt.userPrompt).toContain("<prefix>");
    expect(prompt.userPrompt).toContain("<suffix>");
    expect(prompt.userPrompt).not.toContain("ignored-third");
  });

  it("fails closed for outside, ignored, credential, secret, and binary buffers", () => {
    const ignored = compilePredictionIgnore(["generated/**"]);
    expect(
      prepareCodePredictionContext({
        request: request({ path: "/tmp/main.ts" }),
        workspaceRoot: "/workspace",
      }),
    ).toEqual({ reason: "outside_workspace" });
    expect(
      prepareCodePredictionContext({
        request: request({ path: "/workspace/generated/client.ts" }),
        workspaceRoot: "/workspace",
        ignored,
      }),
    ).toEqual({ reason: "sensitive_path" });
    expect(
      prepareCodePredictionContext({
        request: request({ path: "/workspace/.env" }),
        workspaceRoot: "/workspace",
      }),
    ).toEqual({ reason: "sensitive_path" });
    expect(
      prepareCodePredictionContext({
        request: request({
          prefix: 'const apiKey = "abcdefghijklmnop123456";',
        }),
        workspaceRoot: "/workspace",
      }),
    ).toEqual({ reason: "sensitive_path" });
    expect(
      prepareCodePredictionContext({
        request: request({ prefix: "hello\0world" }),
        workspaceRoot: "/workspace",
      }),
    ).toEqual({ reason: "binary_content" });
    expect(
      prepareCodePredictionContext({
        request: request({
          fileBytes: 1024 * 1024 + 1,
          prefix: "bounded prefix",
          suffix: "bounded suffix",
        }),
        workspaceRoot: "/workspace",
      }),
    ).toEqual({ reason: "file_too_large" });
  });

  it("blocks credential-store directory segments even when the basename is generic", () => {
    for (const path of [
      "/workspace/.git/config",
      "/workspace/.ssh/config",
      "/workspace/.aws/config",
      "/workspace/.azure/config",
      "/workspace/.gnupg/gpg.conf",
      "/workspace/.kube/config",
      "/workspace/.docker/config.json",
      "/workspace/.agenc/wallets/mainnet.json",
      "/workspace/secrets/config.json",
      "/workspace/credentials/service.json",
      "/workspace/.config/gcloud/credentials.db",
      "/workspace/.config/gh/hosts.yml",
      "C:\\workspace\\.ssh\\config",
    ]) {
      expect(isSensitivePredictionPath(path), path).toBe(true);
    }
    expect(isSensitivePredictionPath("/workspace/src/config.ts")).toBe(false);
    expect(isSensitivePredictionPath("/workspace/src/secrets-manager.ts")).toBe(
      false,
    );
  });

  it("suppresses sensitive primary paths and drops sensitive related paths", () => {
    expect(
      prepareCodePredictionContext({
        request: request({ path: "/workspace/.git/config" }),
        workspaceRoot: "/workspace",
      }),
    ).toEqual({ reason: "sensitive_path" });

    const prepared = prepareCodePredictionContext({
      request: request({
        relatedBuffers: [
          {
            path: "/workspace/.ssh/config",
            content: "Host private-host",
          },
          {
            path: "/workspace/secrets/config.json",
            content: '{"environment":"production"}',
          },
          {
            path: "/workspace/src/public.ts",
            content: "export const publicValue = 2;",
          },
        ],
      }),
      workspaceRoot: "/workspace",
    });
    expect(prepared).toMatchObject({
      context: {
        relatedBuffers: [{ path: "src/public.ts" }],
      },
    });
  });

  it("does not leak ignored related buffers into provider context", () => {
    const prepared = prepareCodePredictionContext({
      request: request({
        relatedBuffers: [
          {
            path: "/workspace/generated/private.ts",
            content: "export const privateValue = 1;",
          },
          {
            path: "/workspace/src/public.ts",
            content: "export const publicValue = 2;",
          },
        ],
      }),
      workspaceRoot: "/workspace",
      ignored: compilePredictionIgnore(["generated/**"]),
    });
    expect(prepared).toMatchObject({
      context: {
        relatedBuffers: [{ path: "src/public.ts" }],
      },
    });
  });

  it("applies the central secret boundary to every provider-bound context field", () => {
    const secret = "ghp_012345678901234567890123456789012345";
    for (const overrides of [
      { latestIntent: `use ${secret}` },
      { diagnostics: [{ message: `failed with ${secret}` }] },
    ] satisfies Array<Partial<CodePredictionRequest>>) {
      expect(
        prepareCodePredictionContext({
          request: request(overrides),
          workspaceRoot: "/workspace",
        }),
      ).toEqual({ reason: "sensitive_path" });
    }
    expect(
      prepareCodePredictionContext({
        request: request({
          relatedBuffers: [
          {
            path: "/workspace/src/public.ts",
            content: `export const fixture = "${secret}";`,
          },
          {
            path: "/workspace/src/binary.ts",
            content: "public\0private",
          },
        ],
      }),
        workspaceRoot: "/workspace",
      }),
    ).toMatchObject({
      context: { relatedBuffers: [] },
    });
  });
});
