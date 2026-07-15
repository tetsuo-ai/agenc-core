import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_SYMLINK_EXPANSIONS = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });

function field(block, start, length) {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(block, start, length, label) {
  const raw = field(block, start, length).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar ${label}`);
  return value;
}

function validateChecksum(block) {
  const expected = octal(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (actual !== expected) throw new Error("invalid tar header checksum");
}

function parsePax(data) {
  const values = {};
  const seenKeys = new Set();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error("invalid PAX record length");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("invalid PAX record length");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error("invalid PAX record boundary");
    }
    const record = decoder.decode(data.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("invalid PAX record");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (seenKeys.has(key)) throw new Error(`duplicate PAX key: ${key}`);
    seenKeys.add(key);
    if (key === "path" || key === "linkpath") values[key] = value;
    else if (key === "size") {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid PAX size");
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size > MAX_UNCOMPRESSED_BYTES) {
        throw new Error("invalid PAX size");
      }
      values.size = size;
    } else if (["mtime", "atime", "ctime"].includes(key)) {
      if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
        throw new Error(`invalid PAX ${key}`);
      }
    } else throw new Error(`unsupported PAX key: ${key}`);
    offset = end;
  }
  return values;
}

function unsafePortableSegment(part, platform) {
  if (platform !== "win" && platform !== "darwin") return false;
  if (/[. ]$/.test(part)) return true;
  return platform === "win" && (
    part.includes(":") ||
    /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part)
  );
}

function validateMemberPath(path, platform, collisionPaths) {
  if (
    path.length === 0 ||
    /[\\\x00-\x1f\x7f]/.test(path) ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(`unsafe runtime archive path: ${path || "(empty)"}`);
  }
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe runtime archive path: ${path}`);
  }
  if (trimmed !== "node_modules" && !trimmed.startsWith("node_modules/")) {
    throw new Error(`runtime archive member is outside node_modules: ${path}`);
  }
  if (platform === "win" || platform === "darwin") {
    let prefix = "";
    for (const part of parts) {
      if (unsafePortableSegment(part, platform)) {
        throw new Error(`unsafe runtime archive path for ${platform}: ${path}`);
      }
      prefix = prefix ? `${prefix}/${part}` : part;
      const collisionKey = prefix.normalize("NFC").toLowerCase();
      const prior = collisionPaths.get(collisionKey);
      if (prior !== undefined && prior !== prefix) {
        throw new Error(`runtime archive has a case/Unicode path collision: ${prior} and ${prefix}`);
      }
      collisionPaths.set(collisionKey, prefix);
    }
  }
  return trimmed;
}

function validateLink(memberPath, linkPath, platform) {
  if (
    linkPath.length === 0 ||
    /[\\\x00-\x1f\x7f]/.test(linkPath) ||
    linkPath.startsWith("/") ||
    /^[A-Za-z]:/.test(linkPath)
  ) {
    throw new Error(`unsafe runtime archive link target: ${linkPath || "(empty)"}`);
  }
  if (
    (platform === "win" || platform === "darwin") &&
    linkPath.split("/").some((part) =>
      part !== "." && part !== ".." && unsafePortableSegment(part, platform))
  ) {
    throw new Error(`unsafe runtime archive link target for ${platform}: ${linkPath}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(memberPath), linkPath));
  if (resolved !== "node_modules" && !resolved.startsWith("node_modules/")) {
    throw new Error(`runtime archive link escapes node_modules: ${memberPath} -> ${linkPath}`);
  }
}

function resolveArchiveGraphPath(components, links) {
  const pending = [...components];
  const resolved = [];
  let expansions = 0;
  let steps = 0;
  while (pending.length > 0) {
    if (++steps > MAX_ENTRIES + MAX_SYMLINK_EXPANSIONS) {
      throw new Error("runtime archive symlink resolution is too complex");
    }
    const part = pending.shift() ?? "";
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) {
        throw new Error("runtime archive symlink graph escapes the extraction root");
      }
      resolved.pop();
      continue;
    }
    resolved.push(part);
    const candidate = resolved.join("/");
    const target = links.get(candidate);
    if (target === undefined) continue;
    expansions += 1;
    if (expansions > MAX_SYMLINK_EXPANSIONS) {
      throw new Error("runtime archive symlink graph contains a cycle or excessive depth");
    }
    resolved.pop();
    pending.unshift(...target.split("/"));
  }
  return resolved.join("/");
}

function assertGraphResultWithinNodeModules(path) {
  if (path !== "node_modules" && !path.startsWith("node_modules/")) {
    throw new Error(`runtime archive symlink graph escapes node_modules: ${path || "(root)"}`);
  }
}

function validateSymlinkGraph(members, links) {
  for (const member of members) {
    if (member.type === "2") {
      const parent = posix.dirname(member.path);
      if (parent !== ".") {
        assertGraphResultWithinNodeModules(
          resolveArchiveGraphPath(parent.split("/"), links),
        );
      }
      const target = links.get(member.path);
      if (target === undefined) throw new Error(`missing runtime archive link target: ${member.path}`);
      assertGraphResultWithinNodeModules(resolveArchiveGraphPath([
        ...(parent === "." ? [] : parent.split("/")),
        ...target.split("/"),
      ], links));
    } else {
      assertGraphResultWithinNodeModules(
        resolveArchiveGraphPath(member.path.split("/"), links),
      );
    }
  }
}

export function validateRuntimeArchive(
  path,
  platform = process.platform === "win32" ? "win" : process.platform,
) {
  const archive = gunzipSync(readFileSync(path), {
    maxOutputLength: MAX_UNCOMPRESSED_BYTES,
  });
  let offset = 0;
  let entries = 0;
  let pendingPax;
  const seen = new Set();
  const members = [];
  const links = new Map();
  const collisionPaths = new Map();
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    validateChecksum(header);
    const size = octal(header, 124, 12, "entry size");
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error("truncated tar entry");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(header, 345, 155);
    const headerPath = [prefix, field(header, 0, 100)].filter(Boolean).join("/");
    const headerLink = field(header, 157, 100);
    if (type === "x") {
      if (pendingPax !== undefined) throw new Error("stacked PAX headers are not allowed");
      pendingPax = parsePax(archive.subarray(dataStart, dataEnd));
    } else {
      if (pendingPax?.size !== undefined && pendingPax.size !== size) {
        throw new Error("PAX size does not match tar header size");
      }
      if (!["0", "5", "2"].includes(type)) {
        throw new Error(`unsupported runtime archive member type: ${type}`);
      }
      const memberPath = validateMemberPath(
        pendingPax?.path ?? headerPath,
        platform,
        collisionPaths,
      );
      if (seen.has(memberPath)) throw new Error(`duplicate runtime archive member: ${memberPath}`);
      seen.add(memberPath);
      if (type === "2") {
        const linkPath = pendingPax?.linkpath ?? headerLink;
        validateLink(memberPath, linkPath, platform);
        links.set(memberPath, linkPath);
      }
      members.push({ path: memberPath, type });
      pendingPax = undefined;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("runtime archive has too many entries");
    }
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  if (pendingPax !== undefined) throw new Error("orphaned PAX header");
  if (entries === 0 || !seen.has("node_modules")) {
    throw new Error("runtime archive is empty or missing node_modules");
  }
  validateSymlinkGraph(members, links);
  return { entries, uncompressedBytes: archive.length };
}
