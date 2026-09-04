#!/usr/bin/env bash
# Scripted answer for the mock executor: install the finished project so every
# step verifier and the final verifier can be proven against a known-good tree.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -R "$here/solution/." .
printf '%s\n' '{"tokenUsage":{"input":15,"output":15}}'
