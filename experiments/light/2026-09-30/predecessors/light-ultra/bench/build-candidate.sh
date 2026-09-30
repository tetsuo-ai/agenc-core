#!/bin/bash
set -euo pipefail
# Run on Linux; each candidate owns a frozen checkout and build log.
label=$1
revision=$2
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo "A frozen full commit SHA is required" >&2; exit 2; }
branch=$3
prior=$4
root="$HOME/claude-agenc-work/light-ultra"
python3 -c 'import shutil,sys; sys.exit(0 if shutil.disk_usage(sys.argv[1]).free >= 5*1024**3 else "Build needs 5 GiB free in this task filesystem")' "$root"
target="$root/core-$label"
test ! -e "$target"
# A shallow independent checkout avoids shared-object chain limits and makes
# every frozen build reproducible at the container mount path.
git clone --quiet --depth 1 --single-branch --branch "$branch" https://github.com/tetsuo-ai/agenc-core.git "$target"
[[ "$(git -C "$target" rev-parse HEAD)" == "$revision" ]] || { echo "Branch moved before frozen build" >&2; exit 2; }
docker run --rm --init --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$root:/work" -w "/work/core-$label" node:26.5.0-bookworm bash -lc 'npm ci --ignore-scripts && npm rebuild better-sqlite3 && npm run build && node /work/analysis/check-sqlite.cjs "$PWD"' > "$root/build-$label.log" 2>&1
