# Vendored transport (MIT)

Files from NousResearch/hermes-plugin-claude-subscription-directsdk
commit f1c1220778c7864fe4c1494baf9b1566e7c95bd2 (v0.3.0).
https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/tree/f1c1220778c7864fe4c1494baf9b1566e7c95bd2

`tools/schema_sanitizer.py` and `agent/reasoning_effort.py` are unmodified
stdlib-only dependencies from NousResearch/hermes-agent commit 07610317671ca161c2e530cdb2858560375ba979.
Their license is HERMES-LICENSE; the transport license is LICENSE.
The upstream mcp__hermes__ prefix is intentionally retained by the prototype.

Local change in `directsdk.py`: accept `parallel_tool_calls=False` and project it
to native `tool_choice.disable_parallel_tool_use`, preserving AgenC's serial
tool policy. Other vendored files remain unmodified.
