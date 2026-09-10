# Audited Ollama template fixture

`history-only-tool-template.json` contains the exact active Jinja template returned
by `/api/show` for the installed `deepseek-r1:7b` model, plus a synthetic
`/api/chat` request and its `_debug_render_only` response. Captured with Ollama
0.32.5 on 2026-09-10; no tokens were generated. The rendered prompt had neither
the advertised `read_probe` name nor the unique schema-description marker.
The same probe with a native-capable Qwen template included both markers.

The active template's UTF-8 SHA-256 is
`b6835114b7303ddd78919a82e4d9f7d8c26ed0d7dfc36beeb12d524f6144eab1`.
It is 2,237 UTF-8 bytes. Recognition uses exact bytes, never the model name.
Do not replace this fixture with a current upstream template: that can differ
and must be audited independently.

Ollama's substring-based capability detection and active-template selection:

- https://github.com/ollama/ollama/blob/v0.32.5/server/images.go#L194-L195
- https://github.com/ollama/ollama/blob/v0.32.5/server/routes.go

Template provenance: the installed model's GGUF template, based on DeepSeek's
DeepSeek-R1-Distill-Qwen-7B tokenizer configuration:
https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B/blob/main/tokenizer_config.json

The installed model's `ollama show` Modelfile includes the DeepSeek MIT license;
its notice is preserved in `history-only-tool-template.LICENSE`. The same
copyright and license were independently verified at the official source:
https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B/blob/main/LICENSE

The JSON's diagnostic request, response and proof fields are AgenC-generated
test evidence. The external template is test-only; production retains its hash.
