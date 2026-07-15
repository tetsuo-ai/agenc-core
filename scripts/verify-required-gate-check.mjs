#!/usr/bin/env node

import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readAndVerifyGateCheck } from "./local-gate-github-app.mjs";
import { computeRequiredGateContract } from "./required-gate-contract.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--repository", "--sha", "--app-id"].includes(flag) || value === undefined) {
      throw new Error(`usage: verify-required-gate-check --repository owner/name --sha <40-hex> --app-id <id>`);
    }
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ["--repository", "--sha", "--app-id"]) {
    if (!values.has(flag)) throw new Error(`missing required option: ${flag}`);
  }
  return Object.freeze({
    repository: values.get("--repository"),
    sha: values.get("--sha"),
    appId: values.get("--app-id"),
  });
}

export async function verifyRequiredGateCheck({
  repository,
  sha,
  appId,
  token = process.env.GITHUB_TOKEN,
  apiBaseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  fetchImpl,
} = {}) {
  const contract = computeRequiredGateContract();
  const verified = await readAndVerifyGateCheck({
    repository,
    sha,
    appId,
    contractSha256: contract.sha256,
    token,
    apiBaseUrl,
    fetchImpl,
    expectedSubjectKind: "main",
  });
  return Object.freeze({
    context: verified.check.name,
    checkRunId: verified.check.id,
    appId: verified.check.app.id,
    sourceSha: verified.receipt.subject.sourceSha,
    contractSha256: verified.receipt.contractSha256,
    completedAt: verified.receipt.completedAt,
  });
}

async function main(argv) {
  const options = parseArguments(argv);
  const verified = await verifyRequiredGateCheck(options);
  process.stdout.write(`${JSON.stringify(verified)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`required-gate-check: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
