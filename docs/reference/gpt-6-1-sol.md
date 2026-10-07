# GPT-6.1 Sol

Verified on 2026-09-29 against OpenAI's [model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 migration guide](https://developers.openai.com/api/docs/guides/latest-model), [pricing](https://developers.openai.com/api/docs/pricing), and authenticated API requests.

The exact model ID is `gpt-6.1-sol`. It accepts text and images, has a 1,050,000-token context window and a 128,000-token output limit. Reasoning efforts are low, medium (the default), high, xhigh and max. None and minimal are unsupported. Tools use Responses; plain Chat Completions is supported. Sampling temperature is omitted for reasoning requests.

Standard prices per million tokens are $2 input, $0.10 cached input, $2.50 cache writes and $10 output. Above 272,000 input tokens, the entire request uses $4, $0.20, $5 and $15 respectively. Fast mode doubles those rates. Batch and Flex are documented at half Standard, but this change adds no Batch/Flex or regional-processing selector.

Tiny live checks passed for all five efforts, streaming, a Responses tool-call/result round trip and plain Chat Completions. None, minimal, ultra, temperature and Chat Completions with tools returned HTTP 400. The ChatGPT subscription also served a plain reply and a tool round trip through the existing proxy in three requests, each sent after observing no established proxy client connection. Account discovery remains authoritative.

The [OpenRouter live catalog](https://openrouter.ai/api/v1/models) lists `openai/gpt-6.1-sol`, with matching limits, image input, tools and the same five efforts. Its catalog prices remain estimates under the existing routed-price policy; this task did not make paid OpenRouter inference calls. No Pro or Batch sibling is added.

GitHub's [supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models) and [CLI model list](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) did not list GPT-6.1 Sol. No Copilot or other unverified provider route is added. An authenticated Copilot list was unavailable.

Context and maximum output limits are documented, not experimentally exhausted. Image input and structured output are documented, not exercised by the tiny live requests. There is no protocol change. Desktop must package a Core revision containing this catalog, pricing and request-routing update; changing Desktop's generated catalog alone is insufficient. Defaults and previous model contracts are unchanged.
