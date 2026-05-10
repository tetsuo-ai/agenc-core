# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0]

### Added
- Daemon-backed CLI and Ink TUI (`agenc`, `agenc --yolo`).
- Slash command surface: `/help`, `/status`, `/permissions`, `/effort`,
  `/usage`, `/context`, `/diff`, `/files`, `/cache-stats`, `/agents`,
  `/clear`, `/keybindings`, `/release-notes`, `/resume`, `/rewind`,
  `/history`, `/cost`, `/model`, `/init`, plus the typeahead picker.
- Bracketed-paste handling for large pasted payloads with chip-collapse.
- `@`-mention file picker with Unicode/CJK support.
- Cross-session prompt history (Up-arrow / Ctrl+R).
- Provider routing for chat-completions-style endpoints (xAI, lmstudio, etc.).
- MCP server integration; per-session permission mode registry.

### Changed
- Runtime artifact now ships as `@tetsuo-ai/runtime`; CLI wrapper
  installs as `@tetsuo-ai/agenc`.

