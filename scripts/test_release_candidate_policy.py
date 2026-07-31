#!/usr/bin/env python3
"""Behavior-sensitive tests for the executable candidate release policy."""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable, Mapping, Sequence
from typing import Any


SCRIPT = pathlib.Path(__file__).with_name("release_candidate_policy.py")
REPOSITORY = "tetsuo-ai/agenc-core"
VERSION = "0.13.0"
RUN_ID = "123456789"
RUN_ATTEMPT = "1"
TESTED_SHA = "a" * 40
EVIDENCE_SHA256 = "b" * 64
SLUGS = (
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win-x64",
)


def _write_json(path: pathlib.Path, value: Mapping[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _bundle(
    subjects: Sequence[tuple[str, bytes]],
    *,
    source_sha: str = TESTED_SHA,
    run_attempt: str = RUN_ATTEMPT,
) -> dict[str, Any]:
    statement = {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [
            {
                "name": name,
                "digest": {"sha256": hashlib.sha256(payload).hexdigest()},
            }
            for name, payload in subjects
        ],
        "predicateType": "https://slsa.dev/provenance/v1",
        "predicate": {
            "buildDefinition": {
                "buildType": "https://actions.github.io/buildtypes/workflow/v1",
                "externalParameters": {
                    "workflow": {
                        "ref": "refs/heads/main",
                        "repository": f"https://github.com/{REPOSITORY}",
                        "path": ".github/workflows/release-runtime.yml",
                    }
                },
                "internalParameters": {
                    "github": {
                        "event_name": "workflow_dispatch",
                        "runner_environment": "github-hosted",
                    }
                },
                "resolvedDependencies": [
                    {
                        "uri": (
                            f"git+https://github.com/{REPOSITORY}@refs/heads/main"
                        ),
                        "digest": {"gitCommit": source_sha},
                    }
                ],
            },
            "runDetails": {
                "builder": {
                    "id": (
                        f"https://github.com/{REPOSITORY}/"
                        ".github/workflows/release-runtime.yml@refs/heads/main"
                    )
                },
                "metadata": {
                    "invocationId": (
                        f"https://github.com/{REPOSITORY}/actions/runs/{RUN_ID}"
                        f"/attempts/{run_attempt}"
                    )
                },
            },
        },
    }
    return {
        "mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
        "dsseEnvelope": {
            "payload": base64.b64encode(
                json.dumps(statement, separators=(",", ":")).encode("utf-8")
            ).decode("ascii"),
            "payloadType": "application/vnd.in-toto+json",
            "signatures": [{"keyid": "", "sig": "fixture-signature"}],
        },
        "verificationMaterial": {},
    }


class CandidatePolicyCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="agenc-release-candidate-policy-"
        )
        self.root = pathlib.Path(self.temporary.name)
        self.candidates = self.root / "candidate-artifacts"
        self.downloaded = self.root / "candidate-artifact"
        self.seal = self.root / "candidate-seal"
        self.candidates.mkdir()
        self.downloaded.mkdir()
        self.seal.mkdir()
        for slug in SLUGS:
            archive_name = (
                f"agenc-runtime-{VERSION}-{slug}-node26-abi147.tar.gz"
            )
            archive_path = self.candidates / archive_name
            archive_payload = f"runtime archive fixture for {slug}\n".encode()
            archive_path.write_bytes(archive_payload)
            platform, arch = slug.rsplit("-", 1)
            metadata = {
                "artifact": archive_name,
                "platform": platform,
                "arch": arch,
                "runtimeVersion": VERSION,
                "sourceCommit": TESTED_SHA,
                "sha256": hashlib.sha256(archive_payload).hexdigest(),
                "bytes": len(archive_payload),
                "nodeVersion": "v26.5.0",
                "nodeMajor": 26,
                "nodeModuleAbi": "147",
                "releaseCandidate": {
                    "workflow": "release-runtime.yml",
                    "runId": int(RUN_ID),
                    "runAttempt": int(RUN_ATTEMPT),
                    "runUrl": (
                        f"https://github.com/{REPOSITORY}/actions/runs/{RUN_ID}"
                    ),
                    "phase": "candidate",
                    "sourceRef": "refs/heads/main",
                    "evidenceSha256": EVIDENCE_SHA256,
                },
            }
            metadata_path = self.candidates / f"{archive_name}.meta.json"
            _write_json(metadata_path, metadata)
            _write_json(
                self.candidates / f"{archive_name}.sigstore.json",
                _bundle(
                    (
                        (archive_path.name, archive_path.read_bytes()),
                        (metadata_path.name, metadata_path.read_bytes()),
                    )
                ),
            )
        self.receipt = self.seal / "agenc-runtime-candidate-seal.json"
        self.seal_bundle = self.seal / (
            "agenc-runtime-candidate-seal.json.sigstore.json"
        )
        self.assert_success(self.seal_command())
        selected_prefix = (
            f"agenc-runtime-{VERSION}-linux-x64-node26-abi147.tar.gz"
        )
        for source in self.candidates.iterdir():
            if source.name.startswith(selected_prefix):
                (self.downloaded / source.name).write_bytes(source.read_bytes())
        self.bind_seal_bundle()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def identity_arguments(
        self,
        *,
        tested_sha: str = TESTED_SHA,
        run_attempt: str = RUN_ATTEMPT,
        evidence_sha256: str = EVIDENCE_SHA256,
    ) -> list[str]:
        return [
            "--repository",
            REPOSITORY,
            "--run-id",
            RUN_ID,
            "--run-attempt",
            run_attempt,
            "--tested-sha",
            tested_sha,
            "--evidence-sha256",
            evidence_sha256,
            "--version",
            VERSION,
        ]

    def seal_command(self) -> list[str]:
        return [
            "seal",
            *self.identity_arguments(),
            "--source-dir",
            str(self.candidates),
            "--receipt",
            str(self.receipt),
        ]

    def promotion_command(
        self,
        *,
        tested_sha: str = TESTED_SHA,
        run_attempt: str = RUN_ATTEMPT,
        evidence_sha256: str = EVIDENCE_SHA256,
    ) -> list[str]:
        slug = "linux-x64"
        archive = self.downloaded / (
            f"agenc-runtime-{VERSION}-{slug}-node26-abi147.tar.gz"
        )
        return [
            "promote",
            *self.identity_arguments(
                tested_sha=tested_sha,
                run_attempt=run_attempt,
                evidence_sha256=evidence_sha256,
            ),
            "--slug",
            slug,
            "--receipt",
            str(self.receipt),
            "--seal-bundle",
            str(self.seal_bundle),
            "--artifact",
            str(archive),
            "--metadata",
            str(archive.with_name(f"{archive.name}.meta.json")),
            "--candidate-bundle",
            str(archive.with_name(f"{archive.name}.sigstore.json")),
        ]

    def run_cli(self, arguments: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            check=False,
            capture_output=True,
            encoding="utf-8",
        )

    def assert_success(
        self,
        arguments: Sequence[str],
    ) -> subprocess.CompletedProcess[str]:
        result = self.run_cli(arguments)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def assert_rejected(
        self,
        arguments: Sequence[str],
        expected: str,
    ) -> subprocess.CompletedProcess[str]:
        result = self.run_cli(arguments)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("release candidate policy rejected input", result.stderr)
        self.assertIn(expected, result.stderr)
        return result

    def bind_seal_bundle(self) -> None:
        _write_json(
            self.seal_bundle,
            _bundle(((self.receipt.name, self.receipt.read_bytes()),)),
        )

    def mutate_json(
        self,
        path: pathlib.Path,
        mutate: Callable[[dict[str, Any]], None],
    ) -> None:
        value = json.loads(path.read_text(encoding="utf-8"))
        mutate(value)
        _write_json(path, value)

    def test_accepts_the_exact_sealed_candidate(self) -> None:
        result = self.assert_success(self.promotion_command())
        self.assertIn("validated linux-x64 candidate bytes", result.stdout)

    def test_rejects_a_forged_source_sha(self) -> None:
        self.assert_rejected(
            self.promotion_command(tested_sha="c" * 40),
            "source dependency is detached",
        )

    def test_rejects_a_forged_run_attempt(self) -> None:
        self.assert_rejected(
            self.promotion_command(run_attempt="2"),
            "invocation identity is detached",
        )

    def test_rejects_a_forged_build_type(self) -> None:
        bundle = self.downloaded / (
            f"agenc-runtime-{VERSION}-linux-x64-node26-abi147.tar.gz.sigstore.json"
        )

        def forge_build_type(value: dict[str, Any]) -> None:
            payload = json.loads(
                base64.b64decode(value["dsseEnvelope"]["payload"])
            )
            payload["predicate"]["buildDefinition"]["buildType"] = (
                "https://example.invalid/build"
            )
            value["dsseEnvelope"]["payload"] = base64.b64encode(
                json.dumps(payload, separators=(",", ":")).encode("utf-8")
            ).decode("ascii")

        self.mutate_json(bundle, forge_build_type)
        self.assert_rejected(self.promotion_command(), "wrong build type")

    def test_rejects_a_forged_evidence_digest(self) -> None:
        self.assert_rejected(
            self.promotion_command(evidence_sha256="d" * 64),
            "candidate seal evidenceSha256",
        )

    def test_rejects_a_forged_subject_digest(self) -> None:
        bundle = self.downloaded / (
            f"agenc-runtime-{VERSION}-linux-x64-node26-abi147.tar.gz.sigstore.json"
        )

        def forge_subject(value: dict[str, Any]) -> None:
            payload = json.loads(
                base64.b64decode(value["dsseEnvelope"]["payload"])
            )
            payload["subject"][0]["digest"]["sha256"] = "e" * 64
            value["dsseEnvelope"]["payload"] = base64.b64encode(
                json.dumps(payload, separators=(",", ":")).encode("utf-8")
            ).decode("ascii")

        self.mutate_json(bundle, forge_subject)
        self.assert_rejected(
            self.promotion_command(),
            "subjects do not bind the named candidate bytes",
        )

    def test_rejects_a_forged_subject_name(self) -> None:
        bundle = self.downloaded / (
            f"agenc-runtime-{VERSION}-linux-x64-node26-abi147.tar.gz.sigstore.json"
        )

        def forge_subject(value: dict[str, Any]) -> None:
            payload = json.loads(
                base64.b64decode(value["dsseEnvelope"]["payload"])
            )
            payload["subject"][0]["name"] = "detached-runtime.tar.gz"
            value["dsseEnvelope"]["payload"] = base64.b64encode(
                json.dumps(payload, separators=(",", ":")).encode("utf-8")
            ).decode("ascii")

        self.mutate_json(bundle, forge_subject)
        self.assert_rejected(
            self.promotion_command(),
            "subjects do not bind the named candidate bytes",
        )

    def test_rejects_a_malformed_bundle(self) -> None:
        bundle = self.downloaded / (
            f"agenc-runtime-{VERSION}-linux-x64-node26-abi147.tar.gz.sigstore.json"
        )
        self.mutate_json(
            bundle,
            lambda value: value["dsseEnvelope"].update({"payload": "not base64!"}),
        )
        self.assert_rejected(self.promotion_command(), "DSSE payload is invalid")

    def test_rejects_a_forged_receipt_inventory(self) -> None:
        def drop_artifact(value: dict[str, Any]) -> None:
            del value["artifacts"]["agenc-runtime-win-x64"]

        self.mutate_json(self.receipt, drop_artifact)
        self.bind_seal_bundle()
        self.assert_rejected(
            self.promotion_command(),
            "candidate artifact inventory keys",
        )

    def test_rejects_mutated_metadata_bytes(self) -> None:
        metadata = self.downloaded / (
            f"agenc-runtime-{VERSION}-linux-x64-node26-abi147.tar.gz.meta.json"
        )
        metadata.write_bytes(metadata.read_bytes() + b" ")
        self.assert_rejected(
            self.promotion_command(),
            "subjects do not bind the named candidate bytes",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
