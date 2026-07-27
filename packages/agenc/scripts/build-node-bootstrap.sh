#!/usr/bin/env bash
set -euo pipefail

if test "$#" -ne 2; then
  echo "usage: build-node-bootstrap.sh <linux-x64|linux-arm64> <output.tar.gz>" >&2
  exit 2
fi

slug="$1"
output="$2"
toolchain="${AGENC_RELEASE_TOOLCHAIN:-release-toolchain.json}"
python="${PYTHON:-python3.12}"

case "$slug" in
  linux-x64|linux-arm64) ;;
  *)
    echo "unsupported Node bootstrap target: $slug" >&2
    exit 2
    ;;
esac

if test "${output#/}" = "$output" || test -e "$output"; then
  echo "Node bootstrap output must be a fresh absolute path: $output" >&2
  exit 2
fi
test -f "$toolchain"
test -d "$(dirname "$output")"
test "$(command -v "$python")" = "/usr/bin/python3.12"
test "$(command -v tar)" = "/usr/bin/tar"
test "$(command -v gzip)" = "/usr/bin/gzip"

mapfile -t contract < <(
  "$python" - "$toolchain" "$slug" <<'PY'
import json
import pathlib
import re
import sys

path, slug = sys.argv[1:]
contract = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
bootstrap = contract["nodeBootstrap"]
artifact = bootstrap[slug]
packages = contract["linux"]["builderPackages"]
values = [
    artifact["file"],
    artifact["sha256"],
    str(artifact["bytes"]),
    artifact["librarySha256"],
    str(artifact["libraryBytes"]),
    bootstrap["licenses"]["copying3Sha256"],
    str(bootstrap["licenses"]["copying3Bytes"]),
    bootstrap["licenses"]["runtimeExceptionSha256"],
    str(bootstrap["licenses"]["runtimeExceptionBytes"]),
    packages["libatomic"],
    packages["libgcc"],
    packages["tar"],
    packages["gzip"],
]
if (
    len(values) != 13
    or not re.fullmatch(r"agenc-node-bootstrap-libatomic-linux-(?:x64|arm64)\.tar\.gz", values[0])
    or any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in (values[1], values[3], values[5], values[7]))
    or any(not re.fullmatch(r"[1-9][0-9]*", value) for value in (values[2], values[4], values[6], values[8]))
    or any(not re.fullmatch(r"[A-Za-z0-9+_.-]+-[A-Za-z0-9+_.:-]+", value) for value in values[9:])
):
    raise SystemExit("invalid Node bootstrap release contract")
print(*values, sep="\n")
PY
)
test "${#contract[@]}" -eq 13

expected_file="${contract[0]}"
expected_sha="${contract[1]}"
expected_bytes="${contract[2]}"
library_sha="${contract[3]}"
library_bytes="${contract[4]}"
copying3_sha="${contract[5]}"
copying3_bytes="${contract[6]}"
runtime_exception_sha="${contract[7]}"
runtime_exception_bytes="${contract[8]}"
libatomic_package="${contract[9]}"
libgcc_package="${contract[10]}"
tar_package="${contract[11]}"
gzip_package="${contract[12]}"

test "$(basename "$output")" = "$expected_file"
test "$(rpm -q --qf '%{NAME}-%{VERSION}-%{RELEASE}' libatomic)" = "$libatomic_package"
test "$(rpm -q --qf '%{NAME}-%{VERSION}-%{RELEASE}' libgcc)" = "$libgcc_package"
test "$(rpm -q --qf '%{NAME}-%{VERSION}-%{RELEASE}' tar)" = "$tar_package"
test "$(rpm -q --qf '%{NAME}-%{VERSION}-%{RELEASE}' gzip)" = "$gzip_package"

library="$(readlink -f /usr/lib64/libatomic.so.1)"
copying3=/usr/share/licenses/libgcc/COPYING3
runtime_exception=/usr/share/licenses/libgcc/COPYING.RUNTIME
test -f "$library"
test -f "$copying3"
test -f "$runtime_exception"

"$python" - \
  "$library" "$library_sha" "$library_bytes" \
  "$copying3" "$copying3_sha" "$copying3_bytes" \
  "$runtime_exception" "$runtime_exception_sha" "$runtime_exception_bytes" <<'PY'
import hashlib
import pathlib
import sys

arguments = sys.argv[1:]
for index in range(0, len(arguments), 3):
    path = pathlib.Path(arguments[index])
    expected_sha = arguments[index + 1]
    expected_bytes = int(arguments[index + 2])
    payload = path.read_bytes()
    actual_sha = hashlib.sha256(payload).hexdigest()
    if len(payload) != expected_bytes or actual_sha != expected_sha:
        raise SystemExit(
            f"Node bootstrap component drift for {path}: "
            f"{len(payload)}/{actual_sha} != {expected_bytes}/{expected_sha}"
        )
PY

temporary_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
test "${temporary_root#/}" != "$temporary_root"
test -d "$temporary_root"
work="$(mktemp -d "$temporary_root/agenc-node-bootstrap.XXXXXX")"
cleanup() {
  case "$work" in
    "$temporary_root"/agenc-node-bootstrap.*)
      rm -rf -- "$work"
      ;;
    *)
      echo "refusing to clean unexpected Node bootstrap path: $work" >&2
      return 1
      ;;
  esac
}
trap cleanup EXIT

build_archive() {
  local root="$1"
  local archive="$2"
  install -d -m 0755 "$root" "$root/LICENSES" "$root/lib"
  install -m 0644 "$copying3" "$root/LICENSES/COPYING3"
  install -m 0644 "$runtime_exception" "$root/LICENSES/COPYING.RUNTIME"
  install -m 0644 "$library" "$root/lib/libatomic.so.1"
  (
    cd "$root"
    /usr/bin/tar --sort=name --format=posix --mtime=@0 --owner=0 --group=0 \
      --numeric-owner --pax-option=delete=atime,delete=ctime \
      -cf - LICENSES lib | /usr/bin/gzip -n -9 > "$archive"
  )
}

first="$work/first.tar.gz"
second="$work/second.tar.gz"
build_archive "$work/first" "$first"
build_archive "$work/second" "$second"
"$python" - "$first" "$second" <<'PY'
import pathlib
import sys

first, second = map(pathlib.Path, sys.argv[1:])
if first.read_bytes() != second.read_bytes():
    raise SystemExit("Node bootstrap archive is not byte-reproducible")
PY

"$python" - "$first" "$library_sha" "$copying3_sha" "$runtime_exception_sha" <<'PY'
import hashlib
import pathlib
import stat
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
hashes = {
    "lib/libatomic.so.1": sys.argv[2],
    "LICENSES/COPYING3": sys.argv[3],
    "LICENSES/COPYING.RUNTIME": sys.argv[4],
}
expected = {
    "LICENSES": (tarfile.DIRTYPE, 0o755),
    "LICENSES/COPYING.RUNTIME": (tarfile.REGTYPE, 0o644),
    "LICENSES/COPYING3": (tarfile.REGTYPE, 0o644),
    "lib": (tarfile.DIRTYPE, 0o755),
    "lib/libatomic.so.1": (tarfile.REGTYPE, 0o644),
}
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if [member.name for member in members] != list(expected):
        raise SystemExit("Node bootstrap archive member order or inventory is invalid")
    for member in members:
        kind, mode = expected[member.name]
        if (
            member.type != kind
            or stat.S_IMODE(member.mode) != mode
            or member.uid != 0
            or member.gid != 0
            or member.mtime != 0
        ):
            raise SystemExit(f"Node bootstrap archive metadata is invalid: {member.name}")
        if member.name in hashes:
            extracted = bundle.extractfile(member)
            if extracted is None:
                raise SystemExit(f"Node bootstrap archive member is unreadable: {member.name}")
            actual = hashlib.sha256(extracted.read()).hexdigest()
            if actual != hashes[member.name]:
                raise SystemExit(f"Node bootstrap archive member identity drift: {member.name}")
PY

actual_sha="$(sha256sum "$first" | awk '{print $1}')"
actual_bytes="$(stat -c %s "$first")"
if test "$actual_sha" != "$expected_sha" || test "$actual_bytes" != "$expected_bytes"; then
  echo "Node bootstrap identity drift for ${slug}: ${actual_bytes}/${actual_sha} != ${expected_bytes}/${expected_sha}" >&2
  exit 1
fi

install -m 0644 "$first" "$output"
echo "built ${slug} Node bootstrap (${actual_bytes} bytes, sha256:${actual_sha})"
