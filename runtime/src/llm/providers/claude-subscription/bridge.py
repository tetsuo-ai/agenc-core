"""One request over NDJSON. Auth belongs exclusively to the official Claude CLI."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
from directsdk import Client
from directsdk_setup import _resolve, _child_env


def emit(value):
    print(json.dumps(value), flush=True)


def check_environment():
    names = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
             "ANTHROPIC_FOUNDRY_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_TOKEN")
    conflicts = [name for name in names if os.environ.get(name)]
    conflicts += [name for name in ("CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")
                  if os.environ.get(name, "").lower() not in ("", "0", "false", "no", "off")]
    if conflicts:
        raise ValueError("Remove conflicting environment variables: " + ", ".join(conflicts))


def status():
    check_environment()
    command = _resolve(None, os.environ)
    if command is None:
        return {"available": False, "loggedIn": False, "subscription": False}
    result = subprocess.run(command + ["auth", "status"], stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=20, env=_child_env(os.environ))
    auth = json.loads(result.stdout)
    # Deliberately omit account email, organization, and all credential material.
    return {"available": True, "loggedIn": auth.get("loggedIn") is True,
            "subscription": auth.get("authMethod") == "claude.ai",
            "plan": auth.get("subscriptionType")}


def main():
    client = None
    try:
        if "--status" in sys.argv:
            emit(status())
            return
        request = json.loads(sys.stdin.readline())
        auth = status()
        if not auth["available"]:
            raise ValueError("Install the official Claude Code CLI first.")
        if not auth["loggedIn"] or not auth["subscription"]:
            raise ValueError("Run `claude auth login` with your Claude subscription first.")
        client = Client()

        def cancel(_signum, _frame):
            client.cancel()
            raise SystemExit(130)

        signal.signal(signal.SIGTERM, cancel)
        signal.signal(signal.SIGINT, cancel)
        stream = client.create(**request, stream=True)
        completed = False
        try:
            for chunk in stream:
                if hasattr(chunk, "_response"):
                    emit({"type": "response", "response": chunk._response.model_dump()})
                    completed = True
                else:
                    delta = chunk.choices[0].delta
                    if delta.content:
                        emit({"type": "text", "text": delta.content})
            if not completed:
                raise RuntimeError("Transport ended without a complete response")
        finally:
            stream.close()
    except Exception as exc:
        # Do not print exception tracebacks or raw native stdout/stderr.
        safe = str(exc) if isinstance(exc, ValueError) else type(exc).__name__ + ": Claude transport failed; no tools were released."
        emit({"type": "error", "message": safe})
        raise SystemExit(1)
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    main()
