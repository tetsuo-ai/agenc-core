"""Harbor installed-agent adapter for AgenC Core.

Runs AgenC the way the published Terminal-Bench 2.1 runs did (Harbor Hub jobs
2bf2c84d, 84.5% with release 0.19.24, and 71f39f3b), on any Harbor
environment, with nothing private:

- install: the public one-line installer (https://get.agenc.ag/install.sh)
  pins a release, downloads the runtime tarball named in the release manifest,
  checks its sha256 and writes the ``agenc`` wrapper, which runs the bundled
  Node. When the image lacks ``libatomic.so.1``, the copy shipped in that
  runtime goes into the system loader path, because the daemon starts with a
  sanitized environment that drops the wrapper's ``LD_LIBRARY_PATH``;
- config: ``model_provider``, ``model`` and ``reasoning_effort`` in
  ``$AGENC_HOME/config.toml``, as a user sets them;
- trust: the real TUI trust card is answered once, in a pseudo-terminal
  inside the container, with the runtime's own node-pty
  (``agenc_trust_card.cjs``). The adapter never writes trusted-projects.json;
- run: ``agenc -p --budget max --dangerously-bypass-approvals-and-sandbox
  --output-format stream-json`` with the instruction on stdin, the effort also
  in ``AGENC_EFFORT_LEVEL``, and ``AGENC_DEEPSEEK_WEB_SEARCH=off`` so WebSearch
  uses its own fallback instead of DeepSeek's server-side search;
- deadline: the canonical ``agenc daemon stop`` at the trial's agent deadline
  minus 2 s. Task timeouts are never changed;
- evidence: native rollouts in agent/native-rollouts, an ATIF
  agent/trajectory.json (what Harbor Hub publishes) and tokens plus Core's own
  cost estimate in the trial context.

Model names follow Harbor's ``provider/model`` form, for example
``deepseek/deepseek-flash``. The provider key is read from the runner's
environment and passed only to the agent's processes.

Reproduce the published run (5 attempts per task, official timeouts)::

    export PYTHONPATH=/path/to/agenc-core/runtime/eval/harbor
    DEEPSEEK_API_KEY=... harbor run -d terminal-bench/terminal-bench-2-1 \\
      -a agenc_agent:Agenc -m deepseek/deepseek-flash \\
      --ak version=0.19.24 --ak reasoning_effort=max -k 5

Options (``--ak key=value``):
  version           release to install (default: latest)
  reasoning_effort  max, xhigh, high, medium or low (default: max)
  budget            task token budget for --budget: max, balanced or eco (default: max)
  manifest_url      explicit release manifest (a release candidate mirror)
  runtime_url       runtime tarball from build-runtime-tarball.mjs, for an unreleased commit
  base_url          provider base URL, exported as <PROVIDER>_BASE_URL
  env               extra KEY=VALUE pairs for the agent's processes, comma separated
  add_dirs          extra workspace roots passed as --add-dir (default: none)
  cli_deadline      also pass the budget to AgenC as --deadline (default: false)
  deadline_sec      agent budget in seconds (default: the trial's agent timeout; 0: none)
  deadline_margin_sec  with cli_deadline: seconds between --deadline and the stop
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import shlex
import tempfile
import time
from pathlib import Path

from pydantic import Field

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from agenc_atif import emit as emit_atif
from agenc_atif import rollout_usage
from agenc_deadline import (
    DEFAULT_DEADLINE_MARGIN_SEC,
    deadline_flag,
    resolve_agent_budget_sec,
)

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
EFFORTS = ("max", "xhigh", "high", "medium", "low")
BUDGETS = ("max", "balanced", "eco")
GUARD_MARGIN_SEC = 2
TRUST_SCRIPT = Path(__file__).with_name("agenc_trust_card.cjs")
REMOTE_TRUST_SCRIPT = "/tmp/agenc-trust-card.cjs"
# The installer's wrapper records where it points (base64url JSON); a runtime_url
# install writes a plain `exec "<node>" "<entry>" "$@"` wrapper.
WRAPPER_METADATA = re.compile(r"^# AgenC wrapper metadata v1: ([A-Za-z0-9_-]+)\r?$", re.M)
PLAIN_WRAPPER = re.compile(r'^exec "([^"]+)" "([^"]+)" "\$@"$', re.M)
NODE_DIR_MARKER = "/node_modules/.agenc-node/"


class AgencSetupError(RuntimeError):
    """Install or trust card failed before AgenC ran (infrastructure: safe to retry)."""


class AgencTrustCardError(AgencSetupError):
    """The real TUI trust card did not appear or was not accepted."""


class AgencDeadlineReached(NonZeroAgentExitCodeError):
    """The trial's agent deadline was reached; the daemon was stopped before verification."""


class AgencGuardFailed(RuntimeError):
    """The canonical daemon stop failed, so the agent may still be running (verification is skipped)."""


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
    base_url: str | None = Field(
        default=None,
        description=(
            "Provider base URL exported to the agent as <PROVIDER>_BASE_URL "
            "(DEEPSEEK_BASE_URL for deepseek, XAI_BASE_URL for grok, ...), for "
            "example a local gateway that holds the key for every trial."
        ),
    )
    reasoning_effort: str = Field(
        default="max",
        description=(
            "Reasoning effort: max, xhigh, high, medium or low. Written to "
            "config.toml and AGENC_EFFORT_LEVEL. The Terminal-Bench 2.1 "
            "leaderboard tells runs apart by agent name and this value."
        ),
    )
    effort: str | None = Field(
        default=None,
        description="Older name of reasoning_effort, still accepted.",
    )
    budget: str = Field(
        default="max",
        description="Task token budget passed as --budget: max, balanced or eco.",
    )
    env: str | None = Field(
        default=None,
        description=(
            "Extra KEY=VALUE pairs exported to the agent's processes, comma "
            "separated. They win over the adapter's own values, so a runtime "
            "switch such as AGENC_COMPLETION_CONTRACT=0 is measured against "
            "the default this way."
        ),
    )
    add_dirs: str = Field(
        default="",
        description=(
            "Comma-separated extra workspace roots passed as --add-dir. None "
            "by default, as in the published Terminal-Bench 2.1 runs."
        ),
    )
    cli_deadline: bool = Field(
        default=False,
        description=(
            "Also pass the budget to AgenC as --deadline minus "
            "deadline_margin_sec (#2503), so it can wrap up before the stop. "
            "Off by default: the published runs did not pass it."
        ),
    )
    deadline_sec: float | None = Field(
        default=None,
        description=(
            "Agent budget in seconds for the daemon stop (and --deadline with "
            "cli_deadline). Unset: the trial's agent timeout, derived the way "
            "Harbor computes it. 0: no deadline from the adapter."
        ),
    )
    deadline_margin_sec: float = Field(
        default=DEFAULT_DEADLINE_MARGIN_SEC,
        description="With cli_deadline: seconds kept between --deadline and the stop.",
    )


class Agenc(BaseInstalledAgent):
    """AgenC Core (https://agenc.ag) running headless inside the task container."""

    options_model = AgencOptions

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.resolved_effort not in EFFORTS:
            raise ValueError(f"reasoning_effort must be one of {', '.join(EFFORTS)}")
        if self.options.budget not in BUDGETS:
            raise ValueError(f"budget must be one of {', '.join(BUDGETS)}")
        self._provider_and_model()

    @staticmethod
    def name() -> str:
        return "agenc"

    def version(self) -> str | None:
        return self.options.version or super().version()

    def get_version_command(self) -> str | None:
        return 'export PATH="$HOME/.local/bin:$PATH"; agenc --version'

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().split()[-1] if stdout.strip() else ""

    # ------------------------------------------------------------------ settings
    @property
    def resolved_effort(self) -> str:
        return str(self.options.effort or self.options.reasoning_effort)

    @property
    def env_logs(self) -> str:
        """The agent log directory as the container sees it (Harbor syncs it to logs_dir)."""
        return str(self.environment_logs_dir)

    def _provider_and_model(self) -> tuple[str, str]:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "Model name must be provider/model, e.g. deepseek/deepseek-flash"
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

    def _agent_env(self) -> dict[str, str]:
        provider, _ = self._provider_and_model()
        env = self._key_env(provider)
        if self.options.base_url:
            prefix = PROVIDER_KEY_ENV.get(provider, (f"{provider.upper()}_API_KEY",))[0]
            env[prefix.replace("_API_KEY", "_BASE_URL")] = str(self.options.base_url)
        env.update(
            AGENC_HOME=self.agenc_home,
            AGENC_EFFORT_LEVEL=self.resolved_effort,
            AGENC_ONBOARDING="0",
            AGENC_DEEPSEEK_WEB_SEARCH="off",
        )
        for pair in str(self.options.env or "").split(","):
            if "=" not in pair:
                continue
            name, value = pair.split("=", 1)
            if name.strip():
                env[name.strip()] = value
        return env

    def _note(self, name: str, value: object) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / name).write_text(
            json.dumps(value, indent=2, sort_keys=True, default=str) + "\n"
        )

    async def _stdout(self, environment: BaseEnvironment, command: str, **kwargs) -> str:
        result = await self.exec_as_agent(environment, command=command, **kwargs)
        return (result.stdout or "").strip()

    async def _upload_text(self, environment: BaseEnvironment, text: str, remote_path: str) -> None:
        with tempfile.TemporaryDirectory(prefix="agenc-harbor-") as temp_dir:
            local = Path(temp_dir) / Path(remote_path).name
            local.write_text(text)
            await environment.upload_file(local, remote_path)
        await self.exec_as_root(environment, command=f"chmod a+r {shlex.quote(remote_path)}")

    # ------------------------------------------------------------------ install
    async def install(self, environment: BaseEnvironment) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        timing: dict[str, float] = {"started_at": time.time()}
        try:
            await self.ensure_system_dependencies(environment, ("curl",))
            home = (await self._stdout(environment, 'printf "%s" "$HOME"')).rstrip("/")
            if not home.startswith("/") or "\n" in home:
                raise AgencSetupError("Unexpected $HOME in the task container")
            self.agenc_home = home + "/.agenc"
            self.wrapper = home + "/.local/bin/agenc"
            if self.options.runtime_url:
                await self._install_from_tarball(environment, str(self.options.runtime_url))
            else:
                await self._install_from_public_installer(environment)
            timing["installed_at"] = time.time()
            await self._locate_runtime(environment)
            await self._ensure_libatomic(environment)
            await self._check_version(environment)
            await self._write_config(environment)
            self.cwd = await self._stdout(environment, "pwd -P")
            await self._answer_trust_card(environment)
            timing["trusted_at"] = time.time()
        except (AgencSetupError, asyncio.CancelledError):
            raise
        except Exception as error:
            raise AgencSetupError(f"{type(error).__name__}: {str(error)[:1500]}") from error
        finally:
            timing["finished_at"] = time.time()
            self._note("setup-timing.json", timing)

    async def _install_from_public_installer(self, environment: BaseEnvironment) -> None:
        flags = ["--no-daemon", "--verbose"]
        if self.options.version:
            flags += ["--version", shlex.quote(str(self.options.version))]
        if self.options.manifest_url:
            flags += ["--manifest-url", shlex.quote(str(self.options.manifest_url))]
        log = shlex.quote(self.env_logs + "/install.log")
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {shlex.quote(self.env_logs)}; "
                f"curl -fsSL {INSTALLER_URL} -o /tmp/agenc-install.sh && "
                f"sh /tmp/agenc-install.sh {' '.join(flags)} >{log} 2>&1"
            ),
            env={"AGENC_HOME": self.agenc_home},
            timeout_sec=900,
        )

    async def _install_from_tarball(self, environment: BaseEnvironment, url: str) -> None:
        """Unpack a build-runtime-tarball.mjs artifact and wire an `agenc` wrapper.

        The tarball carries its own Node under node_modules/.agenc-node, so
        nothing else is downloaded.
        """
        root = "$HOME/.agenc-runtime"
        await self.exec_as_agent(
            environment,
            command=(
                f'mkdir -p {root} "$HOME/.local/bin" && '
                f"curl -fsSL {shlex.quote(url)} | tar -xz -C {root} && "
                f'NODE="$(cd {root} && pwd)/node_modules/.agenc-node/bin/node" && '
                f'ENTRY="$(cd {root} && pwd)/node_modules/@tetsuo-ai/runtime/bin/agenc" && '
                '[ -x "$NODE" ] && [ -f "$ENTRY" ] && '
                'printf \'#!/bin/sh\\nexec "%s" "%s" "$@"\\n\' "$NODE" "$ENTRY" > "$HOME/.local/bin/agenc" && '
                'chmod +x "$HOME/.local/bin/agenc"'
            ),
            timeout_sec=900,
        )

    async def _locate_runtime(self, environment: BaseEnvironment) -> None:
        text = await self._stdout(environment, f"cat {shlex.quote(self.wrapper)}")
        node = entry = None
        metadata = WRAPPER_METADATA.search(text)
        if metadata:
            encoded = metadata.group(1)
            values = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            node, entry = values.get("nodeBin"), values.get("runtimeBin")
        else:
            plain = PLAIN_WRAPPER.search(text)
            if plain:
                node, entry = plain.group(1), plain.group(2)
        if not isinstance(node, str) or NODE_DIR_MARKER not in node or not isinstance(entry, str):
            raise AgencSetupError("The agenc wrapper does not name a runtime with a bundled Node")
        self.node = node
        self.runtime_root = node.split(NODE_DIR_MARKER)[0]
        self.pty_dir = self.runtime_root + "/node_modules/node-pty"
        self._note("runtime.json", {"wrapper": self.wrapper, "node": node, "entry": entry,
                                    "runtime_root": self.runtime_root})

    async def _ensure_libatomic(self, environment: BaseEnvironment) -> None:
        """Put the runtime's libatomic in the loader path when the image lacks it.

        The wrapper sets LD_LIBRARY_PATH for its own process, but the daemon is
        spawned with a sanitized environment, so the bundled Node would die
        there with "libatomic.so.1: cannot open shared object file".
        """
        bundled = shlex.quote(self.runtime_root + NODE_DIR_MARKER + "lib/libatomic.so.1")
        await self.exec_as_root(
            environment,
            command=(
                "if ldconfig -p 2>/dev/null | grep -q 'libatomic.so.1 '; then echo present; "
                f"elif [ -f {bundled} ]; then mkdir -p /usr/local/lib && "
                f"install -m 755 {bundled} /usr/local/lib/libatomic.so.1 && (ldconfig || true) && echo installed-from-runtime; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "apt-get update -qq && apt-get install -y -qq libatomic1 && echo installed-from-apt; "
                "else echo missing; fi"
                f" >{shlex.quote(self.env_logs + '/libatomic.txt')}"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
            timeout_sec=600,
        )

    async def _check_version(self, environment: BaseEnvironment) -> None:
        version_file = self.runtime_root + "/node_modules/@tetsuo-ai/runtime/dist/VERSION"
        raw = await self._stdout(environment, f"cat {shlex.quote(version_file)} 2>/dev/null || true")
        try:
            build = json.loads(raw) if raw else {}
        except ValueError:
            build = {"unparsed": raw[:500]}
        reported = await self._stdout(
            environment, f"{shlex.quote(self.wrapper)} --version", env={"AGENC_HOME": self.agenc_home}
        )
        self.build = {"version_output": reported, "dist_version": build}
        self._note("agenc-version.json", self.build)
        wanted = self.options.version
        if wanted and build.get("runtimeVersion") not in (None, wanted):
            raise AgencSetupError(f"Installed runtime {build.get('runtimeVersion')} is not {wanted}")
        if wanted and wanted not in reported:
            raise AgencSetupError(f"agenc --version does not report {wanted}")

    async def _write_config(self, environment: BaseEnvironment) -> None:
        provider, model = self._provider_and_model()
        config = (
            "config_version = 2\n"
            f"model_provider = {json.dumps(provider)}\n"
            f"model = {json.dumps(model)}\n"
            f"reasoning_effort = {json.dumps(self.resolved_effort)}\n"
        )
        home = shlex.quote(self.agenc_home)
        await self.exec_as_agent(environment, command=f"mkdir -p {home} && chmod 700 {home}")
        await self._upload_config_text(
            environment,
            content=config,
            remote_path=self.agenc_home + "/config.toml",
            filename="config.toml",
        )

    async def _answer_trust_card(self, environment: BaseEnvironment) -> None:
        await environment.upload_file(TRUST_SCRIPT, REMOTE_TRUST_SCRIPT)
        await self.exec_as_root(environment, command=f"chmod a+r {REMOTE_TRUST_SCRIPT}")
        out = self.env_logs + "/trust-card"
        env = dict(
            self._agent_env(),
            AGENC_TRUST_WRAPPER=self.wrapper,
            AGENC_TRUST_PTY=self.pty_dir,
            AGENC_TRUST_CWD=self.cwd,
        )
        result = await environment.exec(
            command=" ".join(shlex.quote(part) for part in (self.node, REMOTE_TRUST_SCRIPT, out)),
            env=env,
            timeout_sec=300,
        )
        if result.return_code != 0:
            raise AgencTrustCardError(
                "TUI trust card not answered (exit %s); see agent/trust-card/trust-card.json"
                % result.return_code
            )

    # ------------------------------------------------------------------ run
    def _budget_sec(self) -> float | None:
        explicit = self.options.deadline_sec
        if explicit is not None:
            return explicit if explicit > 0 else None
        return resolve_agent_budget_sec(Path(self.logs_dir).parent)

    async def _collect(self, environment: BaseEnvironment) -> None:
        home = shlex.quote(self.agenc_home)
        dest = shlex.quote(self.env_logs + "/native-rollouts")
        # Copied as the container user into the synced log directory; opened up so
        # the host side can write the ATIF views next to the rollouts.
        await environment.exec(
            command=(
                f"mkdir -p {dest}; n=0; for f in {home}/projects/*/sessions/*/rollout-*.jsonl; do "
                '[ -f "$f" ] || continue; n=$((n+1)); '
                f'cp "$f" {dest}/$(printf %05d $n)-$(basename "$f"); done; '
                f"chmod -R a+rwX {dest} 2>/dev/null; true"
            ),
            timeout_sec=120,
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Harbor's agent clock started with this call.
        started = time.time()
        budget = self._budget_sec()
        deadline = started + budget if budget else None
        record: dict[str, object] = {
            "started_at": started,
            "budget_sec": budget,
            "deadline_at": deadline,
            "guard_margin_seconds": GUARD_MARGIN_SEC,
            "timed_out": False,
            "method": "canonical agenc daemon stop at normal exit or at the deadline minus 2 s",
        }

        def save() -> None:
            self._note("deadline-guard.json", record)

        save()
        argv = [
            self.wrapper, "-p", "--budget", str(self.options.budget),
            "--dangerously-bypass-approvals-and-sandbox", "--output-format", "stream-json",
        ]
        for path in str(self.options.add_dirs or "").split(","):
            if path.strip():
                argv += ["--add-dir", path.strip()]
        if self.options.cli_deadline and budget:
            argv += shlex.split(deadline_flag(budget, self.options.deadline_margin_sec))
        env = dict(self._agent_env(), CI="1")
        self._note("launch.json", {
            "agent": self.name(), "version": self.version(), "argv": argv,
            "prompt_transport": "stdin from instruction.txt", "env_keys": sorted(env),
            "model": self.model_name, "reasoning_effort": self.resolved_effort, "budget": self.options.budget,
        })
        logs = self.env_logs
        await self._upload_text(environment, instruction, logs + "/instruction.txt")
        command = (
            "set +e; " + shlex.join(argv) + " <" + shlex.quote(logs + "/instruction.txt")
            + " >" + shlex.quote(logs + "/agent-stdout.jsonl")
            + " 2>" + shlex.quote(logs + "/agent-stderr.log")
            + '; rc=$?; printf "%s\\n" "$rc" >' + shlex.quote(logs + "/exit-code.txt")
            + '; exit "$rc"'
        )
        cleanup: asyncio.Future | None = None

        async def stop() -> None:
            record["stop_started_at"] = time.time()
            save()
            result = await environment.exec(
                command=shlex.join([self.wrapper, "daemon", "stop"]),
                env={"AGENC_HOME": self.agenc_home},
                timeout_sec=60,
            )
            (self.logs_dir / "daemon-stop.log").write_text(
                (result.stdout or "") + (result.stderr or "")
            )
            record["stop_exit_code"] = result.return_code
            record["stopped_at"] = time.time()
            save()
            try:
                await self._collect(environment)
            except Exception as error:  # evidence only; never masks the run's outcome
                record["collect_error"] = type(error).__name__
                save()
            if result.return_code != 0:
                raise AgencGuardFailed("Canonical daemon stop failed")

        async def cleanup_once() -> None:
            nonlocal cleanup
            if cleanup is None:
                cleanup = asyncio.ensure_future(stop())
            await asyncio.shield(cleanup)

        active = asyncio.ensure_future(self.exec_as_agent(environment, command=command, env=env))
        try:
            wait = None if deadline is None else max(0.0, deadline - GUARD_MARGIN_SEC - time.time())
            done, _ = await asyncio.wait({active}, timeout=wait)
            if active not in done:
                record["timed_out"] = True
                record["guard_fired_at"] = time.time()
                save()
                await cleanup_once()
                try:
                    await asyncio.wait_for(asyncio.shield(active), 15)
                except Exception as error:
                    record["client_terminal_exception"] = type(error).__name__
                    save()
                # The stop itself takes a moment (about 2 s through docker exec). Ending a
                # little after the deadline is recorded, not failed: Harbor verifies after
                # a NonZeroAgentExitCodeError, as it does after its own timeout, while any
                # other error would skip verification and score the trial as an error.
                record["stopped_after_deadline"] = float(record.get("stopped_at") or 0.0) > float(deadline)
                save()
                raise AgencDeadlineReached("Task deadline reached; the daemon was stopped before verification")
            active.result()
        except asyncio.CancelledError:
            record["timed_out"] = True
            record["harbor_cancelled_at"] = time.time()
            save()
            await cleanup_once()
            raise
        finally:
            try:
                await cleanup_once()
            finally:
                if not active.done():
                    active.cancel()
                await asyncio.gather(active, return_exceptions=True)
                record["adapter_finished_at"] = time.time()
                save()

    # ------------------------------------------------------------------ evidence
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Runs on the host after Harbor syncs agent/ back: ATIF trajectory and usage."""
        build = getattr(self, "build", {}) or {}
        dist = build.get("dist_version") if isinstance(build.get("dist_version"), dict) else {}
        agent = {
            "name": self.name(),
            "version": str(dist.get("runtimeVersion") or self.version() or "unknown"),
            "commit": str(dist.get("commit") or "unknown"),
            "model_name": self.model_name,
            "reasoning_effort": self.resolved_effort,
            "budget": self.options.budget,
        }
        try:
            trajectory = emit_atif(self.logs_dir, agent)
        except Exception as error:
            trajectory = {"available": False, "error": type(error).__name__, "detail": str(error)[:300]}
        self._note("trajectory-status.json", trajectory)
        usage = rollout_usage(sorted((self.logs_dir / "native-rollouts").glob("*.jsonl")))
        if usage["calls"]:
            context.n_input_tokens = usage["prompt"]
            context.n_output_tokens = usage["completion"]
            context.n_cache_tokens = usage["cached"]
        if usage["cost_known"] and usage["cost_usd"] > 0:
            context.cost_usd = usage["cost_usd"]
        context.metadata = {
            "product": "AgenC", "version": agent["version"], "commit": agent["commit"],
            "model": self.model_name, "reasoning_effort": self.resolved_effort,
            "budget": self.options.budget, "model_calls": usage["calls"],
            "cost_source": "AgenC session_usage estimate",
        }


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
