# Upstream Prompt Source Notes

The auto-mode classifier prompt payloads were extracted from the official
`@anthropic-ai/claude-code-linux-x64@2.1.123` npm platform package, file
`package/claude`.

Package binary SHA-256:
`5a78139b679a86a88a0ac5476c706a64c3105bf6a6d435ba10f3aa3fb635bdb2`

Extraction markers:
- `var IJ7=n((...exports=\`...\`))` -> `auto_mode_system_prompt.txt`
- `var SJ7=n((...exports=\`...\`))` -> `permissions_external.txt`
- `jW_=""` -> `permissions_anthropic.txt`

Extracted raw SHA-256 values before AgenC branding:
- `auto_mode_system_prompt.txt`: `d64e592c108021545b57c58a1142e420268dee7b8c2a67a9c02c6fe84bbb8f75`
- `permissions_external.txt`: `da4f7ffcd1a0154c24f3f7cb3c5ecc615eb2931154bcf15264b7e493eb6c111d`
- `permissions_anthropic.txt`: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

AgenC branding changes are limited to user-facing product/config names such as
`~/.agenc`, `.agenc`, `AGENTS.md`, and `AgenC`.
