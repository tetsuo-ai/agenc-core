#!/usr/bin/env bash

set -euo pipefail

AGENC_PROJECT_ROOT="${AGENC_PROJECT_ROOT:-/home/paul/agenc-core}"
AGENC_GRAPHICS_TERMINAL_ROOT="${AGENC_GRAPHICS_TERMINAL_ROOT:-/home/paul/.agenc/terminals/kitty-0.45.0}"
AGENC_GRAPHICS_TERMINAL="${AGENC_GRAPHICS_TERMINAL_ROOT}/usr/bin/kitty"
AGENC_GRAPHICS_DISPLAY_SERVER="${AGENC_GRAPHICS_DISPLAY_SERVER:-auto}"
AGENC_TUI_ENTRYPOINT="${AGENC_PROJECT_ROOT}/scripts/launch-hybrid-preview.sh"

if [[ ! -x "${AGENC_GRAPHICS_TERMINAL}" ]]; then
  printf 'AgenC graphics terminal is missing: %s\n' "${AGENC_GRAPHICS_TERMINAL}" >&2
  exit 1
fi

if [[ ! -x "${AGENC_TUI_ENTRYPOINT}" ]]; then
  printf 'AgenC TUI launcher is missing: %s\n' "${AGENC_TUI_ENTRYPOINT}" >&2
  exit 1
fi

exec "${AGENC_GRAPHICS_TERMINAL}" \
  --class agenc-tui \
  --config NONE \
  --detach \
  --start-as=maximized \
  --working-directory "${AGENC_PROJECT_ROOT}" \
  --override 'background=#000000' \
  --override 'foreground=#ffffff' \
  --override 'cursor=#ffffff' \
  --override 'cursor_text_color=#000000' \
  --override 'selection_background=#ffffff' \
  --override 'selection_foreground=#000000' \
  --override 'background_opacity=1.0' \
  --override 'window_padding_width=0' \
  --override "linux_display_server=${AGENC_GRAPHICS_DISPLAY_SERVER}" \
  --override 'color0=#000000' \
  --override 'color1=#ffffff' \
  --override 'color2=#ffffff' \
  --override 'color3=#ffffff' \
  --override 'color4=#ffffff' \
  --override 'color5=#ffffff' \
  --override 'color6=#ffffff' \
  --override 'color7=#ffffff' \
  --override 'color8=#707070' \
  --override 'color9=#ffffff' \
  --override 'color10=#ffffff' \
  --override 'color11=#ffffff' \
  --override 'color12=#ffffff' \
  --override 'color13=#ffffff' \
  --override 'color14=#ffffff' \
  --override 'color15=#ffffff' \
  "${AGENC_TUI_ENTRYPOINT}" "$@"
