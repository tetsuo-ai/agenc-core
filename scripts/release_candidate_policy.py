#!/usr/bin/env python3
"""Validate and seal immutable AgenC runtime release candidates.

GitHub's checksum-pinned CLI remains responsible for cryptographic Sigstore
verification. This policy additionally binds the authenticated DSSE statements,
candidate metadata, receipt, and downloaded bytes to one exact workflow run.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import pathlib
import re
import stat
from collections.abc import Iterable, Mapping, Sequence
from typing import Any


WORKFLOW_NAME = "release-runtime.yml"
WORKFLOW_PATH = f".github/workflows/{WORKFLOW_NAME}"
SOURCE_REF = "refs/heads/main"
SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1"
IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1"
GITHUB_WORKFLOW_BUILD_V1 = "https://actions.github.io/buildtypes/workflow/v1"
MAX_BUNDLE_BYTES = 4 * 1024 * 1024
SLUGS = (
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win-x64",
)
EXPECTED_JOBS = tuple(
    sorted(
        (
            "release-source",
            "hosted-toolchain-preflight (macos-15, darwin-arm64)",
            "hosted-toolchain-preflight (macos-15-intel, darwin-x64)",
            "hosted-toolchain-preflight (windows-2025-vs2026, win-x64)",
            "linux-tarball (ubuntu-24.04, linux-x64)",
            "linux-tarball (ubuntu-24.04-arm, linux-arm64)",
            "native-tarball (macos-15, darwin-arm64)",
            "native-tarball (macos-15-intel, darwin-x64)",
            "native-tarball (windows-2025-vs2026, win-x64)",
            "candidate-seal",
        )
    )
)
RECEIPT_KEYS = frozenset(
    (
        "artifacts",
        "evidenceSha256",
        "phase",
        "runAttempt",
        "runId",
        "runUrl",
        "schemaVersion",
        "sha",
        "successfulJobs",
        "workflow",
    )
)
ARTIFACT_RECORD_KEYS = frozenset(
    (
        "archive",
        "archiveBytes",
        "archiveSha256",
        "metadataBytes",
        "metadataSha256",
        "candidateBundleBytes",
        "candidateBundleSha256",
    )
)
SHA1 = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


class CandidatePolicyError(ValueError):
    """A candidate violates the immutable promotion policy."""


def _fail(message: str) -> None:
    raise CandidatePolicyError(message)


def _require_fullmatch(pattern: re.Pattern[str], value: str, label: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        _fail(f"{label} is not canonical")
    return value


def _positive_integer(value: str | int, label: str) -> int:
    text = str(value)
    if re.fullmatch(r"[1-9][0-9]*", text) is None:
        _fail(f"{label} is not a positive integer")
    parsed = int(text)
    if parsed > 2**53 - 1:
        _fail(f"{label} is outside the safe integer range")
    return parsed


def _identity(
    *,
    repository: str,
    run_id: str | int,
    run_attempt: str | int,
    tested_sha: str,
    evidence_sha256: str,
) -> dict[str, Any]:
    return {
        "repository": _require_fullmatch(REPOSITORY, repository, "repository"),
        "runId": _positive_integer(run_id, "candidate run ID"),
        "runAttempt": _positive_integer(run_attempt, "candidate run attempt"),
        "sha": _require_fullmatch(SHA1, tested_sha, "candidate source SHA"),
        "evidenceSha256": _require_fullmatch(
            SHA256,
            evidence_sha256,
            "candidate evidence digest",
        ),
    }


def _require_version(version: str) -> str:
    return _require_fullmatch(VERSION, version, "runtime version")


def _require_slug(slug: str) -> str:
    if slug not in SLUGS:
        _fail(f"runtime slug is not supported: {slug!r}")
    return slug


def _require_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    if path.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        _fail(f"{label} is not a non-symlink directory")
    return path


def _read_regular_file(
    path: pathlib.Path,
    label: str,
    *,
    maximum_bytes: int | None = None,
) -> bytes:
    try:
        metadata = path.lstat()
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        _fail(f"{label} is not a non-symlink regular file")
    if metadata.st_size < 1:
        _fail(f"{label} is empty")
    if maximum_bytes is not None and metadata.st_size > maximum_bytes:
        _fail(f"{label} is larger than {maximum_bytes} bytes")
    try:
        payload = path.read_bytes()
    except OSError as error:
        _fail(f"{label} could not be read: {error}")
    if len(payload) != metadata.st_size:
        _fail(f"{label} changed while it was read")
    return payload


def _json_object(payload: bytes, label: str) -> dict[str, Any]:
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        _fail(f"{label} is not valid UTF-8 JSON: {error}")
    if not isinstance(parsed, dict):
        _fail(f"{label} root is not a JSON object")
    return parsed


def _file_identity(payload: bytes) -> tuple[int, str]:
    return len(payload), hashlib.sha256(payload).hexdigest()


def _exact_keys(value: Any, expected: Iterable[str], label: str) -> Mapping[str, Any]:
    expected_keys = frozenset(expected)
    if not isinstance(value, dict) or frozenset(value) != expected_keys:
        observed = sorted(value) if isinstance(value, dict) else type(value).__name__
        _fail(
            f"{label} keys were {observed!r}, "
            f"expected {sorted(expected_keys)!r}"
        )
    return value


def _candidate_metadata(
    *,
    version: str,
    slug: str,
    archive_name: str,
    archive_payload: bytes,
    identity: Mapping[str, Any],
) -> dict[str, Any]:
    platform, arch = slug.rsplit("-", 1)
    return {
        "artifact": archive_name,
        "platform": platform,
        "arch": arch,
        "runtimeVersion": version,
        "sourceCommit": identity["sha"],
        "sha256": hashlib.sha256(archive_payload).hexdigest(),
        "bytes": len(archive_payload),
        "nodeVersion": "v26.5.0",
        "nodeMajor": 26,
        "nodeModuleAbi": "147",
        "releaseCandidate": {
            "workflow": WORKFLOW_NAME,
            "runId": identity["runId"],
            "runAttempt": identity["runAttempt"],
            "runUrl": (
                f"https://github.com/{identity['repository']}/actions/runs/"
                f"{identity['runId']}"
            ),
            "phase": "candidate",
            "sourceRef": SOURCE_REF,
            "evidenceSha256": identity["evidenceSha256"],
        },
    }


def _validate_metadata(
    metadata: Mapping[str, Any],
    *,
    version: str,
    slug: str,
    archive_name: str,
    archive_payload: bytes,
    identity: Mapping[str, Any],
) -> None:
    expected = _candidate_metadata(
        version=version,
        slug=slug,
        archive_name=archive_name,
        archive_payload=archive_payload,
        identity=identity,
    )
    for field, value in expected.items():
        if metadata.get(field) != value:
            _fail(
                f"{slug} metadata {field} was {metadata.get(field)!r}, "
                f"expected {value!r}"
            )


def _statement_from_bundle(bundle_payload: bytes, label: str) -> dict[str, Any]:
    bundle = _json_object(bundle_payload, f"{label} bundle")
    envelope = bundle.get("dsseEnvelope")
    if not isinstance(envelope, dict) or not isinstance(envelope.get("payload"), str):
        _fail(f"{label} bundle has no DSSE payload")
    try:
        statement_payload = base64.b64decode(
            envelope["payload"].encode("ascii"),
            validate=True,
        )
        statement = json.loads(statement_payload)
    except (
        UnicodeEncodeError,
        UnicodeDecodeError,
        binascii.Error,
        ValueError,
    ) as error:
        _fail(f"{label} DSSE payload is invalid: {error}")
    if not isinstance(statement, dict):
        _fail(f"{label} statement is not a JSON object")
    return statement


def _require_subjects(
    statement: Mapping[str, Any],
    expected_subjects: Sequence[tuple[str, bytes]],
    label: str,
) -> None:
    subjects = statement.get("subject")
    if not isinstance(subjects, list) or len(subjects) != len(expected_subjects):
        _fail(f"{label} subject inventory is not exact")
    observed: dict[str, str] = {}
    for subject in subjects:
        if not isinstance(subject, dict) or not isinstance(subject.get("name"), str):
            _fail(f"{label} contains a malformed subject")
        name = subject["name"]
        if name in observed:
            _fail(f"{label} contains a duplicate subject name")
        digest = subject.get("digest")
        if not isinstance(digest, dict) or frozenset(digest) != {"sha256"}:
            _fail(f"{label} subject digest schema is not exact")
        sha256 = digest.get("sha256")
        if not isinstance(sha256, str) or SHA256.fullmatch(sha256) is None:
            _fail(f"{label} subject digest is not canonical")
        observed[name] = sha256
    expected = {
        name: hashlib.sha256(payload).hexdigest()
        for name, payload in expected_subjects
    }
    if observed != expected:
        _fail(f"{label} subjects do not bind the named candidate bytes")


def _require_candidate_provenance(
    bundle_payload: bytes,
    *,
    label: str,
    identity: Mapping[str, Any],
    subjects: Sequence[tuple[str, bytes]],
) -> None:
    statement = _statement_from_bundle(bundle_payload, label)
    if statement.get("_type") != IN_TOTO_STATEMENT_V1:
        _fail(f"{label} has the wrong statement type")
    if statement.get("predicateType") != SLSA_PROVENANCE_V1:
        _fail(f"{label} has the wrong predicate type")
    _require_subjects(statement, subjects, label)
    predicate = statement.get("predicate")
    if not isinstance(predicate, dict):
        _fail(f"{label} has no provenance predicate")
    definition = predicate.get("buildDefinition")
    if not isinstance(definition, dict):
        _fail(f"{label} has no build definition")
    if definition.get("buildType") != GITHUB_WORKFLOW_BUILD_V1:
        _fail(f"{label} has the wrong build type")
    external = definition.get("externalParameters")
    workflow = external.get("workflow") if isinstance(external, dict) else None
    expected_workflow = {
        "ref": SOURCE_REF,
        "repository": f"https://github.com/{identity['repository']}",
        "path": WORKFLOW_PATH,
    }
    if workflow != expected_workflow:
        _fail(f"{label} workflow identity is detached")
    expected_dependency = {
        "uri": (
            f"git+https://github.com/{identity['repository']}@{SOURCE_REF}"
        ),
        "digest": {"gitCommit": identity["sha"]},
    }
    if definition.get("resolvedDependencies") != [expected_dependency]:
        _fail(f"{label} source dependency is detached")
    internal = definition.get("internalParameters")
    github = internal.get("github") if isinstance(internal, dict) else None
    if (
        not isinstance(github, dict)
        or github.get("event_name") != "workflow_dispatch"
        or github.get("runner_environment") != "github-hosted"
    ):
        _fail(f"{label} runner identity is detached")
    run_details = predicate.get("runDetails")
    builder = run_details.get("builder") if isinstance(run_details, dict) else None
    run_metadata = (
        run_details.get("metadata") if isinstance(run_details, dict) else None
    )
    expected_builder = {
        "id": (
            f"https://github.com/{identity['repository']}/{WORKFLOW_PATH}"
            f"@{SOURCE_REF}"
        )
    }
    expected_invocation = (
        f"https://github.com/{identity['repository']}/actions/runs/"
        f"{identity['runId']}/attempts/{identity['runAttempt']}"
    )
    if (
        builder != expected_builder
        or not isinstance(run_metadata, dict)
        or run_metadata.get("invocationId") != expected_invocation
    ):
        _fail(f"{label} invocation identity is detached")


def _archive_name(version: str, slug: str) -> str:
    return f"agenc-runtime-{version}-{slug}-node26-abi147.tar.gz"


def _validate_candidate_inventory(
    *,
    source_root: pathlib.Path,
    version: str,
    identity: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    _require_directory(source_root, "candidate artifact directory")
    expected_names: set[str] = set()
    artifact_records: dict[str, dict[str, Any]] = {}
    for slug in SLUGS:
        archive_name = _archive_name(version, slug)
        metadata_name = f"{archive_name}.meta.json"
        bundle_name = f"{archive_name}.sigstore.json"
        expected_names.update((archive_name, metadata_name, bundle_name))
        archive_payload = _read_regular_file(
            source_root / archive_name,
            f"{slug} candidate archive",
        )
        metadata_payload = _read_regular_file(
            source_root / metadata_name,
            f"{slug} candidate metadata",
        )
        bundle_payload = _read_regular_file(
            source_root / bundle_name,
            f"{slug} candidate bundle",
            maximum_bytes=MAX_BUNDLE_BYTES,
        )
        metadata = _json_object(metadata_payload, f"{slug} candidate metadata")
        _validate_metadata(
            metadata,
            version=version,
            slug=slug,
            archive_name=archive_name,
            archive_payload=archive_payload,
            identity=identity,
        )
        _require_candidate_provenance(
            bundle_payload,
            label=f"{slug} build",
            identity=identity,
            subjects=(
                (archive_name, archive_payload),
                (metadata_name, metadata_payload),
            ),
        )
        archive_bytes, archive_sha256 = _file_identity(archive_payload)
        metadata_bytes, metadata_sha256 = _file_identity(metadata_payload)
        bundle_bytes, bundle_sha256 = _file_identity(bundle_payload)
        artifact_records[f"agenc-runtime-{slug}"] = {
            "archive": archive_name,
            "archiveBytes": archive_bytes,
            "archiveSha256": archive_sha256,
            "metadataBytes": metadata_bytes,
            "metadataSha256": metadata_sha256,
            "candidateBundleBytes": bundle_bytes,
            "candidateBundleSha256": bundle_sha256,
        }
    observed = {path.name for path in source_root.iterdir()}
    if observed != expected_names:
        _fail(
            "candidate file inventory mismatch: "
            f"observed={sorted(observed)!r}, expected={sorted(expected_names)!r}"
        )
    for path in source_root.iterdir():
        _read_regular_file(path, f"candidate inventory entry {path.name}")
    return artifact_records


def _receipt_document(
    *,
    identity: Mapping[str, Any],
    artifact_records: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "workflow": WORKFLOW_NAME,
        "phase": "candidate",
        "runId": identity["runId"],
        "runAttempt": identity["runAttempt"],
        "runUrl": (
            f"https://github.com/{identity['repository']}/actions/runs/"
            f"{identity['runId']}"
        ),
        "sha": identity["sha"],
        "evidenceSha256": identity["evidenceSha256"],
        "successfulJobs": list(EXPECTED_JOBS),
        "artifacts": dict(artifact_records),
    }


def _write_receipt(path: pathlib.Path, receipt: Mapping[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        _fail(f"refusing a pre-existing candidate receipt: {path}")
    _require_directory(path.parent, "candidate receipt directory")
    payload = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        _fail(f"candidate receipt could not be written: {error}")


def seal_candidate(args: argparse.Namespace) -> None:
    identity = _identity(
        repository=args.repository,
        run_id=args.run_id,
        run_attempt=args.run_attempt,
        tested_sha=args.tested_sha,
        evidence_sha256=args.evidence_sha256,
    )
    version = _require_version(args.version)
    artifact_records = _validate_candidate_inventory(
        source_root=pathlib.Path(args.source_dir),
        version=version,
        identity=identity,
    )
    receipt = _receipt_document(
        identity=identity,
        artifact_records=artifact_records,
    )
    _write_receipt(pathlib.Path(args.receipt), receipt)
    print(
        f"sealed {len(artifact_records) * 3} candidate files for run "
        f"{identity['runId']}/attempts/{identity['runAttempt']}"
    )


def _validated_receipt(
    payload: bytes,
    *,
    version: str,
    identity: Mapping[str, Any],
) -> dict[str, Mapping[str, Any]]:
    receipt = _exact_keys(
        _json_object(payload, "candidate seal"),
        RECEIPT_KEYS,
        "candidate seal",
    )
    expected_identity = _receipt_document(identity=identity, artifact_records={})
    for field in (
        "schemaVersion",
        "workflow",
        "phase",
        "runId",
        "runAttempt",
        "runUrl",
        "sha",
        "evidenceSha256",
    ):
        if receipt.get(field) != expected_identity[field]:
            _fail(
                f"candidate seal {field} was {receipt.get(field)!r}, "
                f"expected {expected_identity[field]!r}"
            )
    if receipt.get("successfulJobs") != list(EXPECTED_JOBS):
        _fail("candidate seal successful job inventory is not exact")
    artifacts = _exact_keys(
        receipt.get("artifacts"),
        (f"agenc-runtime-{slug}" for slug in SLUGS),
        "candidate artifact inventory",
    )
    records: dict[str, Mapping[str, Any]] = {}
    for slug in SLUGS:
        artifact_name = f"agenc-runtime-{slug}"
        record = _exact_keys(
            artifacts[artifact_name],
            ARTIFACT_RECORD_KEYS,
            f"candidate artifact {artifact_name}",
        )
        if record.get("archive") != _archive_name(version, slug):
            _fail(f"candidate artifact archive is detached for {slug}")
        for field in (
            "archiveBytes",
            "metadataBytes",
            "candidateBundleBytes",
        ):
            if type(record.get(field)) is not int or record[field] < 1:
                _fail(f"candidate artifact {field} is invalid for {slug}")
        for field in (
            "archiveSha256",
            "metadataSha256",
            "candidateBundleSha256",
        ):
            value = record.get(field)
            if not isinstance(value, str) or SHA256.fullmatch(value) is None:
                _fail(f"candidate artifact {field} is invalid for {slug}")
        records[slug] = record
    return records


def _require_exact_download(
    directory: pathlib.Path,
    expected: set[str],
    label: str,
) -> None:
    _require_directory(directory, f"{label} directory")
    observed = {path.name for path in directory.iterdir()}
    if observed != expected:
        _fail(
            f"{label} file inventory is not exact: "
            f"{sorted(observed)!r}, expected {sorted(expected)!r}"
        )
    for path in directory.iterdir():
        _read_regular_file(path, f"{label} entry {path.name}")


def validate_promotion(args: argparse.Namespace) -> None:
    identity = _identity(
        repository=args.repository,
        run_id=args.run_id,
        run_attempt=args.run_attempt,
        tested_sha=args.tested_sha,
        evidence_sha256=args.evidence_sha256,
    )
    version = _require_version(args.version)
    slug = _require_slug(args.slug)
    receipt_path = pathlib.Path(args.receipt)
    seal_bundle_path = pathlib.Path(args.seal_bundle)
    artifact_path = pathlib.Path(args.artifact)
    metadata_path = pathlib.Path(args.metadata)
    candidate_bundle_path = pathlib.Path(args.candidate_bundle)
    expected_archive_name = _archive_name(version, slug)
    if artifact_path.name != expected_archive_name:
        _fail(f"candidate archive name is detached for {slug}")
    if metadata_path != artifact_path.with_name(f"{artifact_path.name}.meta.json"):
        _fail(f"candidate metadata path is detached for {slug}")
    if candidate_bundle_path != artifact_path.with_name(
        f"{artifact_path.name}.sigstore.json"
    ):
        _fail(f"candidate bundle path is detached for {slug}")
    if receipt_path.name != "agenc-runtime-candidate-seal.json":
        _fail("candidate seal receipt name is not canonical")
    if seal_bundle_path != receipt_path.with_name(
        f"{receipt_path.name}.sigstore.json"
    ):
        _fail("candidate seal bundle path is detached")
    _require_exact_download(
        artifact_path.parent,
        {
            artifact_path.name,
            metadata_path.name,
            candidate_bundle_path.name,
        },
        f"{slug} downloaded candidate",
    )
    _require_exact_download(
        receipt_path.parent,
        {receipt_path.name, seal_bundle_path.name},
        "candidate seal",
    )
    receipt_payload = _read_regular_file(receipt_path, "candidate seal receipt")
    seal_bundle_payload = _read_regular_file(
        seal_bundle_path,
        "candidate seal bundle",
        maximum_bytes=MAX_BUNDLE_BYTES,
    )
    artifact_payload = _read_regular_file(artifact_path, f"{slug} archive")
    metadata_payload = _read_regular_file(metadata_path, f"{slug} metadata")
    candidate_bundle_payload = _read_regular_file(
        candidate_bundle_path,
        f"{slug} candidate bundle",
        maximum_bytes=MAX_BUNDLE_BYTES,
    )
    _require_candidate_provenance(
        seal_bundle_payload,
        label="candidate seal",
        identity=identity,
        subjects=((receipt_path.name, receipt_payload),),
    )
    _require_candidate_provenance(
        candidate_bundle_payload,
        label=f"{slug} build",
        identity=identity,
        subjects=(
            (artifact_path.name, artifact_payload),
            (metadata_path.name, metadata_payload),
        ),
    )
    records = _validated_receipt(
        receipt_payload,
        version=version,
        identity=identity,
    )
    record = records[slug]
    actual = {
        "archiveBytes": len(artifact_payload),
        "archiveSha256": hashlib.sha256(artifact_payload).hexdigest(),
        "metadataBytes": len(metadata_payload),
        "metadataSha256": hashlib.sha256(metadata_payload).hexdigest(),
        "candidateBundleBytes": len(candidate_bundle_payload),
        "candidateBundleSha256": hashlib.sha256(candidate_bundle_payload).hexdigest(),
    }
    for field, value in actual.items():
        if record.get(field) != value:
            _fail(
                f"{slug} {field} was {value!r}, sealed as {record.get(field)!r}"
            )
    metadata = _json_object(metadata_payload, f"{slug} candidate metadata")
    _validate_metadata(
        metadata,
        version=version,
        slug=slug,
        archive_name=artifact_path.name,
        archive_payload=artifact_payload,
        identity=identity,
    )
    print(
        f"validated {slug} candidate bytes from run "
        f"{identity['runId']}/attempts/{identity['runAttempt']}"
    )


def _add_identity_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repository", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--tested-sha", required=True)
    parser.add_argument("--evidence-sha256", required=True)
    parser.add_argument("--version", required=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Seal or validate an AgenC native runtime release candidate."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    seal = commands.add_parser("seal", help="validate all native artifacts and write a receipt")
    _add_identity_arguments(seal)
    seal.add_argument("--source-dir", required=True)
    seal.add_argument("--receipt", required=True)
    seal.set_defaults(handler=seal_candidate)
    promote = commands.add_parser(
        "promote",
        help="validate one downloaded candidate artifact against its signed receipt",
    )
    _add_identity_arguments(promote)
    promote.add_argument("--slug", required=True)
    promote.add_argument("--receipt", required=True)
    promote.add_argument("--seal-bundle", required=True)
    promote.add_argument("--artifact", required=True)
    promote.add_argument("--metadata", required=True)
    promote.add_argument("--candidate-bundle", required=True)
    promote.set_defaults(handler=validate_promotion)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        args.handler(args)
    except CandidatePolicyError as error:
        parser.exit(1, f"release candidate policy rejected input: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
