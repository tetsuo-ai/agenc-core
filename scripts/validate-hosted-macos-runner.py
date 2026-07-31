#!/usr/bin/env python3
"""Validate one GitHub-hosted macOS runner against its reviewed image profile."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import platform
import subprocess
from collections.abc import Mapping
from typing import Any


def _capture(*command: str) -> str:
    return subprocess.check_output(
        command,
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()


def _fail(message: str) -> None:
    raise SystemExit(message)


def _require_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(f"{label} must be a non-empty string")
    return value


def _select_image_profile(
    contract: Mapping[str, Any],
    image_version: str,
    slug: str,
) -> Mapping[str, Any]:
    profiles = contract.get("imageProfiles")
    if not isinstance(profiles, list) or not profiles:
        _fail(f"hosted runner contract for {slug} has no reviewed image profiles")
    versions: list[str] = []
    selected: Mapping[str, Any] | None = None
    for index, profile in enumerate(profiles):
        if not isinstance(profile, Mapping):
            _fail(f"hosted runner image profile {slug}[{index}] must be an object")
        version = _require_text(
            profile.get("imageVersion"),
            f"hosted runner image profile {slug}[{index}].imageVersion",
        )
        if version in versions:
            _fail(f"duplicate hosted runner image profile for {slug}: {version}")
        versions.append(version)
        if version == image_version:
            selected = profile
    if selected is None:
        _fail(
            f"hosted runner drift for {slug} imageVersion: "
            f"{image_version!r} not in {versions!r}"
        )
    return selected


def _write_report(path: pathlib.Path | None, report: Mapping[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _assert_exact(label: str, actual: str | None, expected: object) -> None:
    expected_text = _require_text(expected, f"reviewed {label}")
    if actual != expected_text:
        _fail(f"{label} drift: {actual!r} != {expected_text!r}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--report",
        type=pathlib.Path,
        help="Write the complete observed runner inventory before validation.",
    )
    args = parser.parse_args()

    repository_root = pathlib.Path(__file__).resolve().parent.parent
    with (repository_root / "release-toolchain.json").open(encoding="utf-8") as source:
        toolchain = json.load(source)

    slug = _require_text(os.environ.get("AGENC_RELEASE_SLUG"), "AGENC_RELEASE_SLUG")
    contracts = toolchain.get("hostedRunners")
    if not isinstance(contracts, Mapping) or not isinstance(
        contracts.get(slug),
        Mapping,
    ):
        _fail(f"missing hosted runner contract for {slug}")
    contract = contracts[slug]

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "slug": slug,
        "runnerLabel": os.environ.get("AGENC_RUNNER_LABEL"),
        "imageOS": os.environ.get("ImageOS"),
        "imageVersion": os.environ.get("ImageVersion"),
        "runnerArch": os.environ.get("RUNNER_ARCH"),
        "machine": platform.machine(),
    }
    try:
        report.update(
            {
                "xcode": _capture("xcodebuild", "-version"),
                "macosSdkVersion": _capture(
                    "xcrun",
                    "--sdk",
                    "macosx",
                    "--show-sdk-version",
                ),
                "macosSdkPath": _capture(
                    "xcrun",
                    "--sdk",
                    "macosx",
                    "--show-sdk-path",
                ),
                "clangVersion": _capture(
                    "xcrun",
                    "--sdk",
                    "macosx",
                    "clang",
                    "--version",
                ).splitlines()[0],
                "cc": _capture("xcrun", "--sdk", "macosx", "--find", "clang"),
                "cxx": _capture("xcrun", "--sdk", "macosx", "--find", "clang++"),
            }
        )
    except BaseException as error:
        report["captureError"] = str(error)
        _write_report(args.report, report)
        raise
    _write_report(args.report, report)

    expected_slug = {
        "arm64": "darwin-arm64",
        "x86_64": "darwin-x64",
    }.get(report["machine"])
    if expected_slug is None:
        _fail(f"unsupported macOS runner architecture: {report['machine']!r}")
    if slug != expected_slug:
        _fail(f"runner architecture resolves to {expected_slug}, not {slug}")

    _assert_exact("runner label", report["runnerLabel"], contract.get("runnerLabel"))
    _assert_exact("ImageOS", report["imageOS"], contract.get("imageOS"))
    _assert_exact("RUNNER_ARCH", report["runnerArch"], contract.get("runnerArch"))
    image_version = _require_text(report["imageVersion"], "ImageVersion")
    profile = _select_image_profile(contract, image_version, slug)

    expected_xcode = (
        f"Xcode {_require_text(profile.get('xcodeVersion'), 'reviewed Xcode version')}\n"
        f"Build version {_require_text(profile.get('xcodeBuild'), 'reviewed Xcode build')}"
    )
    _assert_exact("Xcode", report["xcode"], expected_xcode)
    _assert_exact(
        "macOS SDK",
        report["macosSdkVersion"],
        profile.get("macosSdkVersion"),
    )
    _assert_exact(
        "Apple clang",
        report["clangVersion"],
        profile.get("clangVersion"),
    )

    sdk_path = pathlib.Path(report["macosSdkPath"])
    functional = sdk_path / "usr" / "include" / "c++" / "v1" / "functional"
    if not functional.is_file():
        _fail(f"reviewed macOS SDK is missing libc++ functional: {functional}")
    probe_environment = os.environ.copy()
    probe_environment["SDKROOT"] = str(sdk_path)
    subprocess.run(
        [report["cxx"], "-x", "c++", "-std=c++20", "-fsyntax-only", "-"],
        input="#include <functional>\nint main() { return 0; }\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=probe_environment,
        check=True,
    )

    builder = ":".join(
        (
            "github-hosted",
            contract["runnerLabel"],
            contract["imageOS"],
            image_version,
            contract["runnerArch"],
        )
    )
    github_environment = os.environ.get("GITHUB_ENV")
    if not github_environment:
        _fail("GITHUB_ENV is required to activate the reviewed macOS toolchain")
    with open(github_environment, "a", encoding="utf-8", newline="\n") as environment:
        environment.write(f"AGENC_BUILDER_ID={builder}\n")
        environment.write(f"SDKROOT={sdk_path}\n")
        environment.write(f"CC={report['cc']}\n")
        environment.write(f"CXX={report['cxx']}\n")
    print(f"approved hosted runner and Xcode contract for {slug}")


if __name__ == "__main__":
    main()
