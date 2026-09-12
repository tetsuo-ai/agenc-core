"""Harbor installed-agent adapter for AgenC.

Installs the public AgenC release inside the task container with the same
one-line installer a user runs (https://get.agenc.ag/install.sh), then runs
one headless turn: ``agenc --dangerously-bypass-approvals-and-sandbox
--provider <p> --model <m> -p "<instruction>"`` in the task's working
directory. Model names follow Harbor's ``provider/model`` convention, e.g.
``deepseek/deepseek-v4-pro``. The provider's API key is read from the host
environment and forwarded only into the agent process.

Options (``--ak key=value``):
  version       release to pin (default: latest public release)
  manifest_url  explicit release manifest (a release candidate mirror)
  effort        reasoning effort written to config (default: medium)
"""

from __future__ import annotations

import glob
import json
import os
import shlex
from pathlib import Path

from pydantic import Field

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Provider id (as AgenC names it) -> environment variables that carry its key,
# first match wins. Mirrors runtime/src/llm/registry/provider-info.ts.
PROVIDER_KEY_ENV: dict[str, tuple[str, ...]] = {
    "deepseek": ("DEEPSEEK_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "grok": ("XAI_API_KEY", "GROK_API_KEY"),
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "ollama-cloud": ("OLLAMA_API_KEY",),
    "cerebras": ("CEREBRAS_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "groq": ("GROQ_API_KEY",),
    "minimax": ("MINIMAX_API_KEY",),
    "kimi": ("MOONSHOT_API_KEY", "KIMI_API_KEY"),
    "zai": ("ZAI_API_KEY",),
    "qwen": ("QWEN_API_KEY", "DASHSCOPE_API_KEY"),
    "nvidia-nim": ("NVIDIA_API_KEY",),
    "meta": ("LLAMA_API_KEY",),
}

INSTALLER_URL = "https://get.agenc.ag/install.sh"
AGENT_LOG = "/logs/agent/agenc.txt"


class AgencOptions(InstalledAgentOptions):
    manifest_url: str | None = Field(
        default=None,
        description="Explicit release manifest URL, for a release candidate mirror.",
    )
    runtime_url: str | None = Field(
        default=None,
        description=(
            "URL of a runtime tarball built with packages/agenc/scripts/"
            "build-runtime-tarball.mjs (release layout, embedded Node). When set, "
            "the public installer is skipped and this exact build is installed, "
            "which is how an unreleased commit of main is measured."
        ),
    )
    effort: str = Field(
        default="medium",
        description="reasoning_effort written to the AgenC config before the run.",
    )
    add_dirs: str = Field(
        default="/",
        description=(
            "Comma-separated extra workspace roots passed as --add-dir. AgenC's "
            "shell write policy only lets commands write inside the workspace; "
            "Terminal-Bench tasks configure the whole container, so the default "
            "widens the workspace to the filesystem root, which is what the "
            "other harnesses have implicitly."
        ),
    )
    stop_daemon: bool = Field(
        default=False,
        description=(
            "Stop the AgenC daemon after the turn. Off by default so background "
            "processes the agent started as managed sessions can outlive the turn "
            "until the container is torn down."
        ),
    )


class Agenc(BaseInstalledAgent):
    """AgenC (https://agenc.ag) running headless inside the task container."""

    options_model = AgencOptions

    @staticmethod
    def name() -> str:
        return "agenc"

    def version(self) -> str | None:
        return self.options.version or super().version()

    def get_version_command(self) -> str | None:
        return 'export PATH="$HOME/.local/bin:$PATH"; agenc --version'

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().split()[-1] if stdout.strip() else ""

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        await self._install_libatomic(environment)
        if self.options.runtime_url:
            await self._install_from_tarball(environment, str(self.options.runtime_url))
            return
        await self._install_from_public_installer(environment)

    async def _install_libatomic(self, environment: BaseEnvironment) -> None:
        """The bundled Node links libatomic, which slim Debian and Ubuntu images
        leave out; the daemon then dies at spawn with "libatomic.so.1: cannot
        open shared object file". Install it the way the image's package
        manager knows it (a no-op where it is already present)."""
        await self.exec_as_root(
            environment,
            command=(
                "if ldconfig -p 2>/dev/null | grep -q 'libatomic.so.1'; then exit 0; fi; "
                "if command -v apt-get >/dev/null 2>&1; then "
                "apt-get update -qq && apt-get install -y -qq libatomic1; "
                "elif command -v dnf >/dev/null 2>&1; then dnf install -y libatomic; "
                "elif command -v yum >/dev/null 2>&1; then yum install -y libatomic; "
                "elif command -v apk >/dev/null 2>&1; then apk add --no-cache libatomic; fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
            timeout_sec=600,
        )

    async def _install_from_tarball(self, environment: BaseEnvironment, url: str) -> None:
        """Unpack a build-runtime-tarball.mjs artifact and wire an `agenc` wrapper.

        The tarball already carries its own Node under node_modules/.agenc-node,
        so nothing else is downloaded; the wrapper mirrors what the installer
        writes for a release.
        """
        root = "$HOME/.agenc-runtime"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f'mkdir -p {root} "$HOME/.local/bin" && '
                f"curl -fsSL {shlex.quote(url)} | tar -xz -C {root} && "
                f'NODE="$(cd {root} && pwd)/node_modules/.agenc-node/bin/node" && '
                f'ENTRY="$(cd {root} && pwd)/node_modules/@tetsuo-ai/runtime/bin/agenc" && '
                '[ -x "$NODE" ] && [ -f "$ENTRY" ] && '
                'printf \'#!/bin/sh\\nexec "%s" "%s" "$@"\\n\' "$NODE" "$ENTRY" > "$HOME/.local/bin/agenc" && '
                'chmod +x "$HOME/.local/bin/agenc" && '
                'export PATH="$HOME/.local/bin:$PATH" && agenc --version'
            ),
            timeout_sec=900,
        )

    async def _install_from_public_installer(self, environment: BaseEnvironment) -> None:
        flags = ["--no-daemon", "--verbose"]
        if self.options.version:
            flags += ["--version", shlex.quote(str(self.options.version))]
        if self.options.manifest_url:
            flags += ["--manifest-url", shlex.quote(str(self.options.manifest_url))]
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"curl -fsSL {INSTALLER_URL} -o /tmp/agenc-install.sh && "
                f"sh /tmp/agenc-install.sh {' '.join(flags)} && "
                'export PATH="$HOME/.local/bin:$PATH" && agenc --version'
            ),
            timeout_sec=900,
        )

    def _provider_and_model(self) -> tuple[str, str]:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "Model name must be provider/model, e.g. deepseek/deepseek-v4-pro"
            )
        provider, model = self.model_name.split("/", 1)
        return provider.strip().lower(), model.strip()

    def _key_env(self, provider: str) -> dict[str, str]:
        names = PROVIDER_KEY_ENV.get(provider)
        if names is None:
            raise ValueError(f"No API key mapping for provider {provider!r}")
        for name in names:
            value = os.environ.get(name)
            if value:
                return {name: value}
        raise ValueError(f"No API key found for {provider}: set {' or '.join(names)}")

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider, model = self._provider_and_model()
        env = self._key_env(provider)
        env["HARBOR_INSTRUCTION"] = instruction
        effort = shlex.quote(str(self.options.effort))
        add_dir_flags = " ".join(
            f"--add-dir {shlex.quote(path.strip())}"
            for path in str(self.options.add_dirs).split(",")
            if path.strip()
        )
        trust = (
            '{"version":1,"trustedProjects":[{"path":"\'"$PWD"\'",'
            '"trustedAt":"1970-01-01T00:00:00Z"}]}'
        )
        run_cmd = (
            'export PATH="$HOME/.local/bin:$PATH"; '
            'AH="${AGENC_HOME:-$HOME/.agenc}"; mkdir -p "$AH" /logs/agent; '
            f"printf '%s' '{trust}' > \"$AH/trusted-projects.json\"; "
            f"agenc config set reasoning_effort {effort} >/dev/null; "
            "agenc --dangerously-bypass-approvals-and-sandbox "
            f"{add_dir_flags + ' ' if add_dir_flags else ''}"
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            f'-p "$HARBOR_INSTRUCTION" 2>&1 | stdbuf -oL tee {AGENT_LOG}'
        )
        try:
            await self.exec_as_agent(environment, command=run_cmd, env=env)
        finally:
            # The rollout is the trajectory: copy it out for token accounting,
            # then stop the daemon the one-shot started.
            await self.exec_as_agent(
                environment,
                command=(
                    'export PATH="$HOME/.local/bin:$PATH"; '
                    'AH="${AGENC_HOME:-$HOME/.agenc}"; '
                    'for f in "$AH"/projects/*/sessions/*/rollout-*.jsonl; do '
                    '[ -f "$f" ] && cp "$f" /logs/agent/ || true; done'
                    + ("; agenc daemon stop >/dev/null 2>&1 || true" if self.options.stop_daemon else "")
                ),
                timeout_sec=60,
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        prompt = completion = cached = 0
        cost = 0.0
        seen_cost = False
        for path in glob.glob(str(self.logs_dir / "rollout-*.jsonl")):
            for line in Path(path).read_text(errors="replace").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = event.get("payload") if isinstance(event, dict) else None
                msg = payload.get("msg") if isinstance(payload, dict) else None
                if not isinstance(msg, dict):
                    continue
                body = msg.get("payload") or {}
                if msg.get("type") == "token_count":
                    prompt += int(body.get("promptTokens") or 0)
                    completion += int(body.get("completionTokens") or 0)
                    cached += int(body.get("cachedInputTokens") or 0)
                elif msg.get("type") == "session_usage":
                    seen_cost = True
                    cost = max(cost, float(body.get("costUsd") or 0.0))
        if prompt or completion:
            context.n_input_tokens = prompt
            context.n_output_tokens = completion
            context.n_cache_tokens = cached
        if seen_cost and cost > 0:
            context.cost_usd = cost


# --- Comparison agents -------------------------------------------------------
# Harbor 0.23.0's Hermes adapter ends its install with `hermes version`, a
# subcommand the current Hermes CLI no longer has (argparse lists status,
# doctor, config, ... but no version), so every trial died at setup. Same
# install, same run; only the final check differs.
from harbor.agents.installed.hermes import Hermes as _Hermes  # noqa: E402


class HermesCurrent(_Hermes):
    @staticmethod
    def name() -> str:
        return "hermes"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("curl", "git", "ripgrep", "xz")
        )
        branch_flag = f" --branch {self._version}" if self._version else ""
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup{branch_flag} && "
                'export PATH="$HOME/.local/bin:$PATH" && '
                'export HERMES_HOME="${HERMES_HOME:-/tmp/hermes}" && '
                'mkdir -p "$HERMES_HOME" "$HERMES_HOME/sessions" "$HERMES_HOME/skills" "$HERMES_HOME/memories" && '
                "command -v hermes && (hermes --version 2>/dev/null || hermes --help >/dev/null 2>&1 || true)"
            ),
            timeout_sec=2400,
        )


# Hermes has a native `deepseek` provider (DEEPSEEK_API_KEY), which Harbor's
# adapter table does not list; without it the run falls back to OpenRouter.
import harbor.agents.installed.hermes as _hermes_mod  # noqa: E402

_hermes_mod._NATIVE_PROVIDERS.setdefault("deepseek", ("deepseek", ["DEEPSEEK_API_KEY"]))
