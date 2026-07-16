import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { assertPortableRelativePath } from "../eval-contract/index.js";
import type { EvalSuiteCatalogDocument, ValidatedEvalSuiteCatalog } from "./types.js";
import {
  EvalSuiteProtocolValidationError,
  validateEvalSuiteCatalogSet,
  validateEvalSuiteProtocolDocument,
} from "./validation.js";
import { validateTrustFixtureBundleBinding } from "./fixtures.js";

const MAX_SUITE_DOCUMENT_BYTES = 1024 * 1024;

function assertNoDuplicateObjectKeys(text: string, file: string): void {
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const scanString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new EvalSuiteProtocolValidationError([`${file} contains an unterminated JSON string`]);
  };
  const scanValue = (): void => {
    skipWhitespace();
    if (text[offset] === "{") {
      offset += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        skipWhitespace();
        const key = scanString();
        if (keys.has(key)) {
          throw new EvalSuiteProtocolValidationError([
            `${file} contains duplicate JSON object key ${JSON.stringify(key)}`,
          ]);
        }
        keys.add(key);
        skipWhitespace();
        offset += 1; // JSON.parse already proved this byte is ':'.
        scanValue();
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        offset += 1; // JSON.parse already proved this byte is ','.
      }
      return;
    }
    if (text[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        scanValue();
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        offset += 1;
      }
      return;
    }
    if (text[offset] === '"') {
      scanString();
      return;
    }
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset] ?? "")) offset += 1;
  };
  scanValue();
}

async function readBoundedRegularJson(file: string, expectedRoot?: string): Promise<unknown> {
  const beforePath = await lstat(file, { bigint: true });
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
    throw new EvalSuiteProtocolValidationError([`${file} must be a regular non-symlink file`]);
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.size !== beforePath.size ||
      before.mtimeNs !== beforePath.mtimeNs ||
      before.size > BigInt(MAX_SUITE_DOCUMENT_BYTES)
    ) {
      throw new EvalSuiteProtocolValidationError([
        `${file} exceeds ${MAX_SUITE_DOCUMENT_BYTES} bytes, is not regular, or changed before open`,
      ]);
    }
    if (expectedRoot) {
      const openedPath = process.platform === "linux"
        ? await realpath(`/proc/self/fd/${handle.fd}`)
        : await realpath(file);
      const openedPathStat = await lstat(openedPath, { bigint: true });
      if (!isWithinRoot(expectedRoot, openedPath)) {
        throw new EvalSuiteProtocolValidationError([`${file} opened outside the catalog root`]);
      }
      if (
        !openedPathStat.isFile() ||
        openedPathStat.dev !== before.dev ||
        openedPathStat.ino !== before.ino
      ) {
        throw new EvalSuiteProtocolValidationError([
          `${file} opened-object identity differs from its contained path`,
        ]);
      }
    }
    const buffer = Buffer.allocUnsafe(MAX_SUITE_DOCUMENT_BYTES + 1);
    let byteLength = 0;
    while (byteLength < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        byteLength,
        buffer.byteLength - byteLength,
        byteLength,
      );
      if (bytesRead === 0) break;
      byteLength += bytesRead;
    }
    if (byteLength > MAX_SUITE_DOCUMENT_BYTES) {
      throw new EvalSuiteProtocolValidationError([
        `${file} exceeds ${MAX_SUITE_DOCUMENT_BYTES} bytes`,
      ]);
    }
    const bytes = buffer.subarray(0, byteLength);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      bytes.byteLength !== Number(before.size)
    ) {
      throw new EvalSuiteProtocolValidationError([`${file} changed while it was being read`]);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = JSON.parse(text) as unknown;
      assertNoDuplicateObjectKeys(text, file);
      return parsed;
    } catch (error) {
      if (error instanceof EvalSuiteProtocolValidationError) throw error;
      throw new EvalSuiteProtocolValidationError([
        `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  } finally {
    await handle.close();
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." &&
    !path.isAbsolute(relative);
}

export async function loadAndValidateEvalSuiteCatalog(
  catalogFile: string,
): Promise<ValidatedEvalSuiteCatalog> {
  const catalogPath = path.resolve(catalogFile);
  const catalogValue = await readBoundedRegularJson(catalogPath);
  const catalogDocument = validateEvalSuiteProtocolDocument(catalogValue);
  if (catalogDocument.kind !== "agenc.eval.suite-catalog") {
    throw new EvalSuiteProtocolValidationError([`${catalogPath} is not a suite catalog`]);
  }
  const catalog = catalogDocument as EvalSuiteCatalogDocument;
  const root = await realpath(path.dirname(catalogPath));
  const definitions: unknown[] = [];
  for (const entry of catalog.activeDefinitions) {
    assertPortableRelativePath(entry.path, `${entry.suiteClass} catalog path`);
    const candidate = path.resolve(root, entry.path);
    if (!isWithinRoot(root, candidate)) {
      throw new EvalSuiteProtocolValidationError([
        `${entry.suiteClass} definition escapes the catalog root`,
      ]);
    }
    const candidateStat = await lstat(candidate, { bigint: true });
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      throw new EvalSuiteProtocolValidationError([
        `${entry.suiteClass} definition must be a regular non-symlink file`,
      ]);
    }
    const canonical = await realpath(candidate);
    if (!isWithinRoot(root, canonical)) {
      throw new EvalSuiteProtocolValidationError([
        `${entry.suiteClass} definition resolves outside the catalog root`,
      ]);
    }
    const definitionValue = await readBoundedRegularJson(canonical, root);
    definitions.push(definitionValue);
    const definition = validateEvalSuiteProtocolDocument(definitionValue);
    if (definition.kind === "agenc.eval.trust-suite-definition") {
      const artifact = definition.execution.fixtureBundle;
      assertPortableRelativePath(artifact.path, "trust fixture bundle path");
      const artifactCandidate = path.resolve(path.dirname(canonical), artifact.path);
      if (!isWithinRoot(root, artifactCandidate)) {
        throw new EvalSuiteProtocolValidationError([
          "trust fixture bundle escapes the catalog root",
        ]);
      }
      const artifactStat = await lstat(artifactCandidate, { bigint: true });
      if (
        artifactStat.isSymbolicLink() ||
        !artifactStat.isFile() ||
        artifactStat.size !== BigInt(artifact.sizeBytes)
      ) {
        throw new EvalSuiteProtocolValidationError([
          "trust fixture bundle is missing, symlinked, or has the wrong size",
        ]);
      }
      const artifactCanonical = await realpath(artifactCandidate);
      if (!isWithinRoot(root, artifactCanonical)) {
        throw new EvalSuiteProtocolValidationError([
          "trust fixture bundle resolves outside the catalog root",
        ]);
      }
      const bundleValue = await readBoundedRegularJson(artifactCanonical, root);
      validateTrustFixtureBundleBinding(definition, bundleValue);
    }
  }
  return validateEvalSuiteCatalogSet(catalog, definitions);
}
