#!/usr/bin/env bash
set -eu
TASK_DIR="$(cd "$(dirname "$0")" && pwd)"
cp -R "$TASK_DIR/solution/." .
printf '%s\n' '{"tokenUsage":{"input":260,"output":84}}'
