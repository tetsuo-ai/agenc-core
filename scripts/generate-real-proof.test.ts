import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_FIXTURE_PATH,
  DEFAULT_PROGRAM_ID,
  parseGenerateRealProofArgs,
} from "./generate-real-proof-cli.js";

test("parseGenerateRealProofArgs reads env defaults", () => {
  const cwd = "/tmp/agenc-core";
  const options = parseGenerateRealProofArgs(
    [],
    {
      AGENC_PROGRAM_ID: DEFAULT_PROGRAM_ID,
      AGENC_PROVER_ENDPOINT: "https://prover.example.com",
      AGENC_PROVER_TIMEOUT_MS: "15000",
      AGENC_PROVER_API_KEY: "secret-key",
      AGENC_PROVER_HEADERS_JSON: '{"authorization":"Bearer token"}',
      AGENC_REAL_PROOF_FIXTURE_PATH: "artifacts/fixture.json",
    },
    cwd,
  );

  assert.equal(options.programId, DEFAULT_PROGRAM_ID);
  assert.equal(options.proverEndpoint, "https://prover.example.com");
  assert.equal(options.proverTimeoutMs, 15000);
  assert.deepEqual(options.proverHeaders, {
    "x-api-key": "secret-key",
    authorization: "Bearer token",
  });
  assert.equal(options.fixturePath, path.resolve(cwd, "artifacts/fixture.json"));
});

test("parseGenerateRealProofArgs lets CLI flags override env values", () => {
  const cwd = "/tmp/agenc-core";
  const options = parseGenerateRealProofArgs(
    [
      "--program-id",
      "11111111111111111111111111111111",
      "--prover-endpoint",
      "http://127.0.0.1:8080/base",
      "--prover-timeout-ms",
      "2500",
      "--header",
      "authorization=Bearer local",
      "--output",
      "custom/fixture.json",
    ],
    {
      AGENC_PROGRAM_ID: DEFAULT_PROGRAM_ID,
      AGENC_PROVER_ENDPOINT: "https://prover.example.com",
      AGENC_PROVER_TIMEOUT_MS: "15000",
      AGENC_PROVER_API_KEY: "secret-key",
    },
    cwd,
  );

  assert.equal(options.programId, "11111111111111111111111111111111");
  assert.equal(options.proverEndpoint, "http://127.0.0.1:8080/base");
  assert.equal(options.proverTimeoutMs, 2500);
  assert.deepEqual(options.proverHeaders, {
    "x-api-key": "secret-key",
    authorization: "Bearer local",
  });
  assert.equal(options.fixturePath, path.resolve(cwd, "custom/fixture.json"));
});

test("parseGenerateRealProofArgs rejects malformed header JSON", () => {
  assert.throws(
    () =>
      parseGenerateRealProofArgs([], {
        AGENC_PROVER_ENDPOINT: "https://prover.example.com",
        AGENC_PROVER_HEADERS_JSON: '{"authorization":42}',
      }),
    /AGENC_PROVER_HEADERS_JSON/u,
  );
});

test("parseGenerateRealProofArgs rejects invalid timeout values", () => {
  assert.throws(
    () =>
      parseGenerateRealProofArgs([], {
        AGENC_PROVER_ENDPOINT: "https://prover.example.com",
        AGENC_PROVER_TIMEOUT_MS: "0",
      }),
    /AGENC_PROVER_TIMEOUT_MS/u,
  );
});

test("parseGenerateRealProofArgs rejects unsupported endpoint protocols", () => {
  assert.throws(
    () =>
      parseGenerateRealProofArgs([], {
        AGENC_PROVER_ENDPOINT: "ftp://prover.example.com",
      }),
    /protocol/u,
  );
});

test("parseGenerateRealProofArgs keeps the default fixture path when unset", () => {
  const cwd = "/tmp/agenc-core";
  const options = parseGenerateRealProofArgs(
    [],
    {
      AGENC_PROVER_ENDPOINT: "https://prover.example.com",
    },
    cwd,
  );

  assert.equal(options.fixturePath, path.resolve(cwd, DEFAULT_FIXTURE_PATH));
});
