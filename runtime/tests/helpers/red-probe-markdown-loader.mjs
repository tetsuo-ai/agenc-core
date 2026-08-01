import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES = 256 * 1024;

const ENCODED_PATH_ALIAS_PATTERN = /%(?:00|2e|2f|5c)/iu;
const MARKDOWN_EXTENSION = ".md";
const RUNTIME_SOURCE_PREFIX = "src/";

function isSameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSameStableFileMetadata(left, right) {
  return (
    isSameFileIdentity(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertCanonicalFileUrl(value, label, requireDirectory) {
  if (typeof value !== "string" || ENCODED_PATH_ALIAS_PATTERN.test(value)) {
    throw new Error(`${label} URL is invalid or contains an encoded alias`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  if (
    url.protocol !== "file:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.host !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (requireDirectory && !url.pathname.endsWith("/"))
  ) {
    throw new Error(`${label} URL is not a canonical local file URL`);
  }
  const path = fileURLToPath(url);
  if (pathToFileURL(path).href !== url.href || url.href !== value) {
    throw new Error(`${label} URL is not canonical`);
  }
  return Object.freeze({ path, url: url.href });
}

function inspectCanonicalSourceRoot(runtimeSourceRootUrl) {
  const parsed = assertCanonicalFileUrl(
    runtimeSourceRootUrl,
    "red-probe runtime source root",
    true,
  );
  const path = resolve(parsed.path);
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      "red-probe runtime source root is not a non-symlink directory",
    );
  }
  if (
    realpathSync(path) !== path ||
    pathToFileURL(`${path}${sep}`).href !== parsed.url
  ) {
    throw new Error("red-probe runtime source root is not canonical");
  }
  return Object.freeze({ metadata, path, url: parsed.url });
}

function assertSourceRootUnchanged(sourceRoot) {
  const current = lstatSync(sourceRoot.path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !isSameFileIdentity(sourceRoot.metadata, current) ||
    realpathSync(sourceRoot.path) !== sourceRoot.path
  ) {
    throw new Error("red-probe runtime source root changed identity");
  }
}

function isExactMarkdownUrl(value) {
  try {
    return new URL(value).pathname.endsWith(MARKDOWN_EXTENSION);
  } catch {
    return false;
  }
}

function resolveContainedMarkdownAsset(url, sourceRoot) {
  const parsed = assertCanonicalFileUrl(url, "red-probe markdown asset", false);
  if (!parsed.path.endsWith(MARKDOWN_EXTENSION)) {
    throw new Error("red-probe markdown asset extension is not exact");
  }
  const path = resolve(parsed.path);
  const relativePath = relative(sourceRoot.path, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("red-probe markdown asset escapes the runtime source root");
  }
  const portableRelativePath = relativePath.split(sep).join("/");
  if (
    portableRelativePath.length === 0 ||
    portableRelativePath
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("red-probe markdown asset path is not canonical");
  }
  return Object.freeze({
    path,
    runtimeRelativePath: `${RUNTIME_SOURCE_PREFIX}${portableRelativePath}`,
  });
}

function assertSingleRegularFile(metadata) {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1n
  ) {
    throw new Error(
      "red-probe markdown asset is not one single-link regular file",
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeFatalUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("red-probe markdown asset is not valid UTF-8");
  }
}

function readMarkdownAsset(asset, sourceRoot, afterOpenForTest) {
  assertSourceRootUnchanged(sourceRoot);
  const beforePath = lstatSync(asset.path, { bigint: true });
  assertSingleRegularFile(beforePath);
  if (realpathSync(asset.path) !== asset.path) {
    throw new Error("red-probe markdown asset path is not canonical");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(asset.path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(
      "red-probe markdown asset could not be opened without following links",
      { cause: error },
    );
  }
  try {
    const beforeDescriptor = fstatSync(descriptor, { bigint: true });
    assertSingleRegularFile(beforeDescriptor);
    if (!isSameFileIdentity(beforePath, beforeDescriptor)) {
      throw new Error(
        "red-probe markdown asset changed identity while opening",
      );
    }
    if (
      beforeDescriptor.size > BigInt(MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES)
    ) {
      throw new Error(
        `red-probe markdown asset exceeds ${MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES} bytes`,
      );
    }

    afterOpenForTest?.(Object.freeze({ descriptor, path: asset.path }));

    const bytes = Buffer.allocUnsafe(
      MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES + 1,
    );
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES) {
      throw new Error(
        `red-probe markdown asset exceeds ${MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES} bytes`,
      );
    }

    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(asset.path, { bigint: true });
    assertSingleRegularFile(afterDescriptor);
    assertSingleRegularFile(afterPath);
    if (
      !isSameStableFileMetadata(beforeDescriptor, afterDescriptor) ||
      !isSameStableFileMetadata(afterDescriptor, afterPath) ||
      afterDescriptor.size !== BigInt(bytesRead) ||
      realpathSync(asset.path) !== asset.path
    ) {
      throw new Error("red-probe markdown asset changed while it was read");
    }
    assertSourceRootUnchanged(sourceRoot);
    const exactBytes = bytes.subarray(0, bytesRead);
    return Object.freeze({
      digest: sha256(exactBytes),
      source: decodeFatalUtf8(exactBytes),
    });
  } finally {
    closeSync(descriptor);
  }
}

export function createRedProbeMarkdownLoadHook(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.runtimeSourceRootUrl !== "string" ||
    typeof options.onAssetLoaded !== "function" ||
    (options.afterOpenForTest !== undefined &&
      typeof options.afterOpenForTest !== "function")
  ) {
    throw new TypeError("red-probe markdown loader options are invalid");
  }
  const sourceRoot = inspectCanonicalSourceRoot(options.runtimeSourceRootUrl);
  const afterOpenForTest = options.afterOpenForTest;
  const onAssetLoaded = options.onAssetLoaded;

  return function loadRedProbeMarkdown(url, context, nextLoad) {
    if (!isExactMarkdownUrl(url)) return nextLoad(url, context);
    const asset = resolveContainedMarkdownAsset(url, sourceRoot);
    const loaded = readMarkdownAsset(asset, sourceRoot, afterOpenForTest);
    onAssetLoaded(
      Object.freeze({
        path: asset.runtimeRelativePath,
        sha256: loaded.digest,
      }),
    );
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(loaded.source)};\n`,
    };
  };
}
