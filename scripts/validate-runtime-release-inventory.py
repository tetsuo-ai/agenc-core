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
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
MINIMUM_DUAL_PROVENANCE_VERSION = (0, 13, 0)
RELEASE_CANDIDATE_KEYS = {
    "workflow",
    "runId",
    "runAttempt",
    "runUrl",
    "phase",
    "sourceRef",
    "evidenceSha256",
}


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


def node_bootstrap_contract(
    toolchain: dict[str, Any],
) -> tuple[str, dict[str, tuple[str, int]]]:
    bootstrap = toolchain.get("nodeBootstrap")
    if (
        not isinstance(bootstrap, dict)
        or bootstrap.get("schemaVersion") != 1
    ):
        raise ValueError("release toolchain has no reviewed Node bootstrap contract")
    minimum_version = bootstrap.get("minimumRuntimeVersion")
    release_tag = bootstrap.get("releaseTag")
    if (
        not isinstance(minimum_version, str)
        or SEMVER.fullmatch(minimum_version) is None
        or release_tag != f"agenc-v{minimum_version}"
    ):
        raise ValueError("Node bootstrap is not anchored to its minimum runtime version")

    assets: dict[str, tuple[str, int]] = {}
    for key in ("linux-arm64", "linux-x64"):
        entry = bootstrap.get(key)
        expected_file = f"agenc-node-bootstrap-libatomic-{key}.tar.gz"
        expected_url = (
            "https://github.com/tetsuo-ai/agenc-releases/releases/download/"
            f"{release_tag}/{expected_file}"
        )
        if (
            not isinstance(entry, dict)
            or entry.get("file") != expected_file
            or entry.get("url") != expected_url
            or not isinstance(entry.get("sha256"), str)
            or SHA256.fullmatch(entry["sha256"]) is None
            or type(entry.get("bytes")) is not int
            or entry["bytes"] <= 0
        ):
            raise ValueError(f"invalid reviewed Node bootstrap asset: {key}")
        assets[expected_file] = (entry["sha256"], entry["bytes"])
    return release_tag, assets


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


def release_candidate_identity(
    value: Any,
    source_commit: Any,
    *,
    required: bool,
) -> dict[str, Any] | None:
    if value is None and not required:
        return None
    if (
        not isinstance(value, dict)
        or set(value) != RELEASE_CANDIDATE_KEYS
        or value.get("workflow") != "release-runtime.yml"
        or type(value.get("runId")) is not int
        or value["runId"] <= 0
        or type(value.get("runAttempt")) is not int
        or value["runAttempt"] <= 0
        or value.get("runUrl") != (
            "https://github.com/tetsuo-ai/agenc-core/actions/runs/"
            f"{value.get('runId')}"
        )
        or value.get("phase") != "candidate"
        or value.get("sourceRef") != "refs/heads/main"
        or not isinstance(value.get("evidenceSha256"), str)
        or SHA256.fullmatch(value["evidenceSha256"]) is None
        or not isinstance(source_commit, str)
        or re.fullmatch(r"[0-9a-f]{40}", source_commit) is None
    ):
        raise ValueError("runtime release candidate identity is invalid")
    return value


def runtime_asset_names(
    manifest: dict[str, Any],
    tag: str,
) -> tuple[
    set[str],
    dict[str, tuple[str, int | None]],
    str,
    dict[str, Any] | None,
]:
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
    bound_assets: dict[str, tuple[str, int | None]] = {}
    requires_dual_provenance = (
        tuple(int(part) for part in version.split(".")) >=
        MINIMUM_DUAL_PROVENANCE_VERSION
    )
    build = manifest.get("build")
    if (
        not isinstance(build, dict)
        or build.get("sourceRef") != f"refs/tags/{tag}"
    ):
        raise ValueError("runtime manifest build identity is invalid")
    source_commit = build.get("sourceCommit")
    release_candidate = release_candidate_identity(
        build.get("releaseCandidate"),
        source_commit,
        required=requires_dual_provenance,
    )
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
        artifact_sha256 = artifact.get("sha256")
        artifact_bytes = artifact.get("bytes")
        metadata_sha256 = artifact.get("metadataSha256")
        if (
            not isinstance(artifact_sha256, str)
            or SHA256.fullmatch(artifact_sha256) is None
            or type(artifact_bytes) is not int
            or artifact_bytes <= 0
            or not isinstance(metadata_sha256, str)
            or SHA256.fullmatch(metadata_sha256) is None
        ):
            raise ValueError(f"invalid runtime byte identity: {key}")
        bound_assets[name] = (artifact_sha256, artifact_bytes)
        bound_assets[f"{name}.meta.json"] = (metadata_sha256, None)

        provenance = [
            (
                f"{name}.sigstore.json",
                "attestationUrl",
                "attestationSha256",
                "attestationBytes",
            ),
        ]
        has_build_provenance = any(
            artifact.get(field) is not None
            for field in (
                "buildProvenanceUrl",
                "buildProvenanceSha256",
                "buildProvenanceBytes",
            )
        )
        if requires_dual_provenance or has_build_provenance:
            provenance.append(
                (
                    f"{name}.build.sigstore.json",
                    "buildProvenanceUrl",
                    "buildProvenanceSha256",
                    "buildProvenanceBytes",
                )
            )
        for provenance_name, url_field, digest_field, bytes_field in provenance:
            expected_provenance_url = f"{expected_url}{provenance_name[len(name):]}"
            digest = artifact.get(digest_field)
            byte_count = artifact.get(bytes_field)
            if (
                artifact.get(url_field) != expected_provenance_url
                or not isinstance(digest, str)
                or SHA256.fullmatch(digest) is None
                or type(byte_count) is not int
                or byte_count <= 0
                or byte_count > 4 * 1024 * 1024
            ):
                raise ValueError(f"invalid runtime provenance identity: {key}")
            bound_assets[provenance_name] = (digest, byte_count)
        names.update(bound_assets.keys())
    if seen != EXPECTED_PLATFORMS:
        raise ValueError("runtime matrix is incomplete")
    return names, bound_assets, source_commit, release_candidate


def validate(
    release: dict[str, Any],
    manifest: dict[str, Any],
    checksums: dict[str, str],
    checksum_bytes: bytes,
    tag: str,
    asset_root: pathlib.Path,
    bootstrap_release_tag: str,
    reviewed_bootstrap_assets: dict[str, tuple[str, int]],
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

    (
        runtime_assets,
        manifest_bound_assets,
        source_commit,
        release_candidate,
    ) = runtime_asset_names(manifest, tag)
    bootstrap_contract = (
        reviewed_bootstrap_assets if tag == bootstrap_release_tag else {}
    )
    bootstrap_assets = set(bootstrap_contract)
    checksum_names = runtime_assets | STATIC_CHECKSUM_ASSETS | bootstrap_assets
    if set(checksums) != checksum_names:
        raise ValueError("SHA256SUMS asset inventory is incomplete or has extras")
    for name, (expected_sha256, _) in bootstrap_contract.items():
        if checksums[name] != expected_sha256:
            raise ValueError(f"Node bootstrap checksum is detached from the toolchain: {name}")
    for name, (expected_sha256, _) in manifest_bound_assets.items():
        if checksums[name] != expected_sha256:
            raise ValueError(f"runtime manifest digest is detached from the asset: {name}")
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
        if name in bootstrap_contract and size != bootstrap_contract[name][1]:
            raise ValueError(f"Node bootstrap byte count is detached from the toolchain: {name}")
        if name in manifest_bound_assets:
            expected_size = manifest_bound_assets[name][1]
            if expected_size is not None and size != expected_size:
                raise ValueError(f"runtime manifest byte count is detached from the asset: {name}")

    locally_required = runtime_assets | bootstrap_assets | {
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
        if name.endswith(".meta.json"):
            metadata_document, _ = load_json(
                path,
                1024 * 1024,
                f"runtime metadata {name}",
            )
            metadata_candidate = release_candidate_identity(
                metadata_document.get("releaseCandidate"),
                metadata_document.get("sourceCommit"),
                required=release_candidate is not None,
            )
            if (
                metadata_document.get("sourceCommit") != source_commit
                or metadata_candidate != release_candidate
            ):
                raise ValueError(
                    f"runtime metadata release candidate identity is detached: {name}"
                )

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
    parser.add_argument(
        "--toolchain",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parent.parent / "release-toolchain.json",
    )
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
        toolchain, _ = load_json(args.toolchain, 1024 * 1024, "release toolchain")
        bootstrap_release_tag, bootstrap_assets = node_bootstrap_contract(toolchain)
        checksums, checksum_bytes = parse_checksums(args.checksums)
        validate(
            release,
            manifest,
            checksums,
            checksum_bytes,
            args.tag,
            asset_root,
            bootstrap_release_tag,
            bootstrap_assets,
            canonical_directory(args.prepared_root, "prepared root")
            if args.prepared_root else None,
        )
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
