#!/bin/sh

set -eu

runtime_root="/home/paul/.agenc/runtime/0.11.2/linux-x64-glibc-node-abi-147-sha256-f72a3dadf3f7bad44bfe952302a976e5b71f34fd8732879acb0db668b661e563"
sandbox_exe="$runtime_root/node_modules/@tetsuo-ai/runtime/bin/agenc-linux-sandbox"

if [ ! -x "$sandbox_exe" ]; then
  echo "AgenC sandbox helper is missing or not executable: $sandbox_exe" >&2
  exit 1
fi

# Paint the terminal itself, not only rendered TUI cells. This keeps unused
# rows, cleared regions, and the alternate-screen canvas consistently black.
printf '\033]11;#000000\007'
printf '\033]10;#FFFFFF\007'
printf '\033[2J\033[H'

export PATH="$runtime_root/node_modules/.agenc-node/bin:/usr/local/bin:/usr/bin:/bin"
export LD_LIBRARY_PATH="$runtime_root/node_modules/.agenc-node/lib"
export AGENC_LINUX_SANDBOX_EXE="$sandbox_exe"

exec "$runtime_root/node_modules/.agenc-node/bin/node" \
  /home/paul/agenc-core/runtime/bin/agenc "$@"
