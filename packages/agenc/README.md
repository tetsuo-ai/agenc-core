# AgenC Core

Our goal is to multiply model capability per dollar of inference. AgenC is an
open source framework that improves how any model plans, uses tools and checks
its work.

AgenC Core is a coding agent for your terminal. It works with any model
provider: 25 are built in, including OpenAI, Anthropic, xAI Grok, Gemini,
DeepSeek, Venice and local models through Ollama or LM Studio.

With DeepSeek V4.1 Flash it scored 84.5% on Terminal-Bench 2.1 for $27.
[Results](https://get.agenc.ag/terminal-bench/)

## Install

```bash
npm install -g @tetsuo-ai/agenc
agenc onboard
```

This package needs Node.js 26.5 or a later 26.x. Without Node, use the
standalone installer, which brings its own runtime:

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh
```

## Use

```bash
agenc                                            # terminal UI in your project
agenc -p "run the tests and fix what fails"      # headless, for scripts and CI
agenc --provider ollama --model qwen3-coder:30b  # a local model
```

## Links

- Website: https://get.agenc.ag
- Source and docs: https://github.com/tetsuo-ai/agenc-core
- Model providers: https://get.agenc.ag/providers/
- Verify your download: https://get.agenc.ag/verify/

MIT licensed.
