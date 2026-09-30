#!/bin/bash
set -euo pipefail
base=/home/paul/claude-agenc-work/light-ultra
target="$base/core-final-a793fdb"
evidence="$base/analysis/final-a793fdb-validation"
expected=a793fdb8560c64226816826d6a0d9e016081f90e
image=sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271
test ! -e "$target"
test ! -e "$evidence"
test -z "$(docker ps -q)"
python3 -c 'import shutil,sys; sys.exit(0 if shutil.disk_usage(sys.argv[1]).free >= 10*1024**3 else 2)' "$base"
mkdir "$evidence"
git clone --quiet --no-hardlinks --no-checkout "$base/core-converge-coldcli-v2" "$target"
git -C "$target" fetch --quiet "$base/analysis/final-integration-a793fdb.bundle" refs/heads/light/final-integration
git -C "$target" checkout --quiet --detach "$expected"
test "$(git -C "$target" rev-parse HEAD)" = "$expected"
test -z "$(git -C "$target" status --porcelain)"
cp "$base/analysis/validate-cold-cli-v2.sh" "$evidence/validate-cold-cli-v2.sh"
cp "$base/analysis/check-sqlite.cjs" "$evidence/check-sqlite.cjs"
# The historical in-container path keeps the exact reviewed validator reusable.
# Its host bind and evidence directory are NEW and exclusive to this commit.
docker run --rm --init --name light-build-final-a793fdb --user "$(id -u):$(id -g)" --cpus=2 --memory=4g \
  -v "$target:/work/core-converge-coldcli-v2" -v "$evidence:/work/analysis" \
  -w /work/core-converge-coldcli-v2 "$image" bash -lc \
  'npm ci --ignore-scripts && npm rebuild better-sqlite3 && npm run build && node /work/analysis/check-sqlite.cjs "$PWD"' \
  > "$evidence/build.log" 2>&1
test -z "$(git -C "$target" status --porcelain)"
docker run --rm --init --network=none --name light-validate-final-a793fdb --user "$(id -u):$(id -g)" --cpus=2 --memory=4g \
  -v "$target:/work/core-converge-coldcli-v2" -v "$evidence:/work/analysis" \
  -w /work/core-converge-coldcli-v2 "$image" bash /work/analysis/validate-cold-cli-v2.sh "$expected" \
  > "$evidence/startup-validation.log" 2>&1
docker run --rm --init --network=none --name light-focus-final-a793fdb --user "$(id -u):$(id -g)" --cpus=2 --memory=4g \
  -v "$target:/work/core-converge-coldcli-v2" -v "$evidence:/work/analysis" \
  -w /work/core-converge-coldcli-v2/runtime "$image" \
  node scripts/run-hermetic-vitest.mjs run tests/tool-registry.test.ts tests/light-cache-wire.test.ts \
  tests/session/run-turn.light-companions.test.ts tests/tools/system/file-write.test.ts \
  tests/tools/system/file-write-session-guard.ihunt.test.ts tests/permissions/file-write-preview.test.ts \
  tests/browser/manager-navigation-failure.test.ts tests/plugins/pattern-worker.test.ts \
  tests/plugins/plugin-settings.test.ts tests/plugins/plugin-secret-authority.test.ts \
  tests/plugins/plugin-config-authority.architecture.test.ts --maxWorkers=2 --reporter=dot --reporter=json \
  --outputFile=/work/analysis/integration-tests.json > "$evidence/integration-validation.log" 2>&1
test "$(git -C "$target" rev-parse HEAD)" = "$expected"
test -z "$(git -C "$target" status --porcelain)"
printf 'Verified candidate %s build, SQLite, typechecks, startup and integration suites passed.\n' "$expected"
