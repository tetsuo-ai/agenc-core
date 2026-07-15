#!/usr/bin/env python3
"""Fail closed unless an immutable runtime release has the exact reviewed asset graph."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import stat
from typing import Any


EXPECTED_PLATFORMS = {
    ("darwin", "arm64"),
    ("darwin", "x64"),
    ("linux", "arm64"),
    ("linux", "x64"),
    ("win", "x64"),
}
STATIC_CHECKSUM_ASSETS = {
    "agenc-runtime-manifest-v2.json",
    "agenc-runtime-manifest.json",
    "agenc-core.spdx.json",
    "install.sh",
    "install.ps1",
}
ASSET_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
CHECKSUM_LINE = re.compile(rb"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)\Z")
SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: pathlib.Path, maximum: int, label: str) -> tuple[dict[str, Any], bytes]:
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{label} is not a regular file")
    if metadata.st_size <= 0 or metadata.st_size > maximum:
        raise ValueError(f"{label} is outside its byte bound")
    raw = path.read_bytes()
    try:
        parsed = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"{label} is not strict UTF-8 JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"{label} root must be an object")
    return parsed, raw


def parse_checksums(path: pathlib.Path) -> tuple[dict[str, str], bytes]:
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise ValueError("SHA256SUMS is not a regular file")
    if metadata.st_size <= 0 or metadata.st_size > 128 * 1024:
        raise ValueError("SHA256SUMS is outside its byte bound")
    raw = path.read_bytes()
    if not raw.endswith(b"\n") or b"\r" in raw:
        raise ValueError("SHA256SUMS is not canonical LF text")
    lines = raw[:-1].split(b"\n")
    if not lines or lines != sorted(lines) or any(not line for line in lines):
        raise ValueError("SHA256SUMS is empty, unsorted, or has blank lines")
    result: dict[str, str] = {}
    for line in lines:
        match = CHECKSUM_LINE.fullmatch(line)
        if match is None:
            raise ValueError("SHA256SUMS has a malformed entry")
        name = match.group(2).decode("ascii")
        if name in result:
            raise ValueError(f"duplicate checksum entry: {name}")
        result[name] = match.group(1).decode("ascii")
    return result, raw


def canonical_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    requested = path.absolute()
    metadata = requested.lstat()
    if requested.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"{label} is not a real directory")
    canonical = requested.resolve(strict=True)
    if canonical != requested:
        raise ValueError(f"{label} must use its canonical path")
    return canonical


def runtime_asset_names(manifest: dict[str, Any], tag: str) -> set[str]:
    if manifest.get("releaseTag") != tag:
        raise ValueError("v2 manifest tag mismatch")
    version = manifest.get("runtimeVersion")
    if not isinstance(version, str) or SEMVER.fullmatch(version) is None:
        raise ValueError("v2 manifest runtimeVersion is invalid")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != len(EXPECTED_PLATFORMS):
        raise ValueError("runtime matrix is incomplete")
    seen: set[tuple[str, str]] = set()
    names: set[str] = set()
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise ValueError("runtime artifact entry is invalid")
        key = (artifact.get("platform"), artifact.get("arch"))
        if key not in EXPECTED_PLATFORMS or key in seen:
            raise ValueError(f"invalid or duplicate runtime key: {key}")
        seen.add(key)
        node_major = artifact.get("nodeMajor")
        node_abi = artifact.get("nodeModuleAbi")
        if type(node_major) is not int or node_major <= 0:
            raise ValueError(f"invalid Node major for runtime key: {key}")
        if not isinstance(node_abi, str) or not node_abi.isascii() or not node_abi.isdigit():
            raise ValueError(f"invalid Node ABI for runtime key: {key}")
        name = (
            f"agenc-runtime-{version}-{key[0]}-{key[1]}-"
            f"node{node_major}-abi{node_abi}.tar.gz"
        )
        expected_url = (
            "https://github.com/tetsuo-ai/agenc-releases/releases/download/"
            f"{tag}/{name}"
        )
        if artifact.get("url") != expected_url:
            raise ValueError(f"noncanonical runtime URL: {key}")
        names.update((name, f"{name}.meta.json", f"{name}.sigstore.json"))
    if seen != EXPECTED_PLATFORMS:
        raise ValueError("runtime matrix is incomplete")
    return names


def validate(
    release: dict[str, Any],
    manifest: dict[str, Any],
    checksums: dict[str, str],
    checksum_bytes: bytes,
    tag: str,
    asset_root: pathlib.Path,
    prepared_root: pathlib.Path | None = None,
) -> None:
    for root, label in ((asset_root, "download root"), (prepared_root, "prepared root")):
        if root is None:
            continue
        metadata = root.lstat()
        if root.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError(f"{label} is not a real directory")
    if release.get("tag_name") != tag:
        raise ValueError("runtime release tag mismatch")
    if (
        release.get("draft") is not False
        or release.get("prerelease") is not False
        or release.get("immutable") is not True
    ):
        raise ValueError("runtime release must be published, stable, and immutable")

    runtime_assets = runtime_asset_names(manifest, tag)
    checksum_names = runtime_assets | STATIC_CHECKSUM_ASSETS
    if set(checksums) != checksum_names:
        raise ValueError("SHA256SUMS asset inventory is incomplete or has extras")
    release_names = checksum_names | {"SHA256SUMS"}

    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ValueError("release assets are invalid")
    by_name: dict[str, dict[str, Any]] = {}
    for asset in assets:
        if not isinstance(asset, dict):
            raise ValueError("release asset entry is invalid")
        name = asset.get("name")
        if not isinstance(name, str) or ASSET_NAME.fullmatch(name) is None:
            raise ValueError("release asset name is invalid")
        if name in by_name:
            raise ValueError(f"duplicate release asset: {name}")
        by_name[name] = asset
    if set(by_name) != release_names:
        raise ValueError("immutable release asset inventory is incomplete or has extras")

    checksum_digest = hashlib.sha256(checksum_bytes).hexdigest()
    for name, asset in by_name.items():
        expected = checksum_digest if name == "SHA256SUMS" else checksums[name]
        size = asset.get("size")
        if (
            asset.get("state") != "uploaded"
            or asset.get("digest") != f"sha256:{expected}"
            or type(size) is not int
            or size <= 0
        ):
            raise ValueError(f"release asset digest, state, or size mismatch: {name}")

    locally_required = runtime_assets | {
        "agenc-runtime-manifest-v2.json",
        "agenc-runtime-manifest.json",
        "SHA256SUMS",
    }
    for name in locally_required:
        path = asset_root / name
        metadata = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"downloaded release asset is not a regular file: {name}")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        expected = checksum_digest if name == "SHA256SUMS" else checksums[name]
        if actual != expected:
            raise ValueError(f"downloaded release asset digest mismatch: {name}")

    if prepared_root is not None:
        prepared_names: set[str] = set()
        for path in prepared_root.iterdir():
            metadata = path.lstat()
            if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
                raise ValueError(f"prepared release contains a non-regular entry: {path.name}")
            prepared_names.add(path.name)
        if prepared_names != release_names:
            raise ValueError("prepared release asset inventory differs from the immutable release")
        for name in release_names:
            path = prepared_root / name
            raw = path.read_bytes()
            asset = by_name[name]
            if len(raw) != asset["size"] or hashlib.sha256(raw).hexdigest() != asset["digest"][7:]:
                raise ValueError(f"prepared release bytes differ from immutable asset: {name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-json", required=True, type=pathlib.Path)
    parser.add_argument("--manifest", required=True, type=pathlib.Path)
    parser.add_argument("--checksums", required=True, type=pathlib.Path)
    parser.add_argument("--asset-root", required=True, type=pathlib.Path)
    parser.add_argument("--prepared-root", type=pathlib.Path)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"agenc-v[0-9]+\.[0-9]+\.[0-9]+", args.tag):
        raise SystemExit("release tag is invalid")
    try:
        asset_root = canonical_directory(args.asset_root, "download root")
        if args.manifest.resolve(strict=True) != asset_root / "agenc-runtime-manifest-v2.json":
            raise ValueError("v2 manifest must be the canonical downloaded release asset")
        if args.checksums.resolve(strict=True) != asset_root / "SHA256SUMS":
            raise ValueError("SHA256SUMS must be the canonical downloaded release asset")
        release, _ = load_json(args.release_json, 16 * 1024 * 1024, "release JSON")
        manifest, _ = load_json(args.manifest, 1024 * 1024, "v2 manifest")
        checksums, checksum_bytes = parse_checksums(args.checksums)
        validate(
            release,
            manifest,
            checksums,
            checksum_bytes,
            args.tag,
            asset_root,
            canonical_directory(args.prepared_root, "prepared root")
            if args.prepared_root else None,
        )
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
