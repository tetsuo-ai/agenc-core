"""Pure fixed-panel request policy. No I/O, transport, accounting or launch API."""
from __future__ import annotations

import hashlib
import json
import math
import re

MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_POLICY_BYTES = 64 * 1024
MAX_DEPTH = 64
MAX_NODES = 100_000
MAX_STRING_CHARS = 1024 * 1024
MAX_CALL_ORDINAL = 1000

# Conservative subset of the reviewed Light/Pi builders; not an API schema.
# All supported controls, including optional fields, require exact independent
# preauthorization. Data fields are not sampling policy or task identity proof.
PROFILES = {
    "fixed-luna-v1": {
        "route": "openai-direct",
        "required": {"model": "gpt-6-luna", "stream": True, "store": False,
                     "max_output_tokens": 8192,
                     "reasoning": {"effort": "low", "summary": "auto"},
                     "include": ["reasoning.encrypted_content"]},
        "data": {"light": {"input", "instructions", "tools"},
                 "pi": {"input", "tools"}},
        "optional": {"light": {"prompt_cache_key", "tool_choice", "parallel_tool_calls"},
                     "pi": {"prompt_cache_key"}},
    },
    "fixed-flash-v1": {
        "route": "deepseek-proxy",
        "required": {"model": "deepseek-flash", "stream": True,
                     "max_tokens": 8192, "reasoning_effort": "high",
                     "thinking": {"type": "enabled"},
                     "stream_options": {"include_usage": True}},
        "data": {"light": {"messages", "tools"}, "pi": {"messages", "tools"}},
        "optional": {"light": {"tool_choice"}, "pi": {"tool_choice"}},
    },
}
POLICY_FIELDS = {"schema_version", "profile", "route", "client", "controls"}


class Refused(ValueError):
    """A static, safe reason; never interpolate captured values."""


def require(ok, reason):
    if not ok:
        raise Refused(reason)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      separators=(",", ":"), allow_nan=False).encode("ascii")


def parse(raw, limit):
    require(type(raw) is bytes, "bytes_required")
    require(0 < len(raw) <= limit, "byte_limit")

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    def integer(value):
        require(len(value) <= 128, "number_length_limit")
        return int(value)

    def constant(_value):
        raise Refused("nonfinite_json")

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                           parse_constant=constant, parse_int=integer)
    except Refused:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise Refused("malformed_json") from None
    stack = [(value, 0)]
    nodes = 0
    while stack:
        current, depth = stack.pop()
        nodes += 1
        require(nodes <= MAX_NODES and depth <= MAX_DEPTH, "structure_limit")
        if type(current) is str:
            require(len(current) <= MAX_STRING_CHARS, "string_limit")
            require(not any(0xD800 <= ord(ch) <= 0xDFFF for ch in current), "invalid_unicode")
        elif type(current) is float:
            require(math.isfinite(current), "nonfinite_json")
        elif type(current) is dict:
            stack.extend((part, depth + 1) for pair in current.items() for part in pair)
        elif type(current) is list:
            stack.extend((part, depth + 1) for part in current)
    require(type(value) is dict, "object_required")
    return value


def validate_policy(policy, route, client):
    require(set(policy) == POLICY_FIELDS and type(policy["schema_version"]) is int
            and policy["schema_version"] == 1, "policy_schema")
    require(type(policy["profile"]) is str and policy["profile"] in PROFILES, "unsupported_profile")
    profile = PROFILES[policy["profile"]]
    require(type(client) is str and client in ("light", "pi") and policy["client"] == client,
            "client_mismatch")
    require(type(route) is str and route == profile["route"] and policy["route"] == route,
            "route_mismatch")
    controls = policy["controls"]
    require(type(controls) is dict, "policy_controls")
    required = profile["required"]
    require(set(required) <= set(controls) <= set(required) | profile["optional"][client],
            "unsupported_policy_controls")
    # Canonical equality preserves boolean/int/float/null distinctions. It never
    # rewrites the outgoing request: the caller must send the original bytes.
    require(canonical({key: controls[key] for key in required}) == canonical(required),
            "unsupported_policy_values")
    for key in set(controls) - set(required):
        value = controls[key]
        if key == "prompt_cache_key":
            require(type(value) is str and re.fullmatch(r"[A-Za-z0-9_.:-]{1,256}", value) is not None,
                    "unsupported_policy_values")
        elif key == "tool_choice":
            require(type(value) is str and value == "auto", "unsupported_policy_values")
        elif key == "parallel_tool_calls":
            require(type(value) is bool, "unsupported_policy_values")
    return profile, controls


def check_request(*, request_bytes, policy_bytes, expected_policy_sha256,
                  route, client, call_ordinal):
    """Check every call against independently minted policy, not observed data.

    The caller owns authenticity of policy digest, route/client and call ordinal.
    Success is only equality within this bounded subset; not replay, task,
    transport, deployment, accounting or cross-client parity verification.
    """
    result = {"policy_verified": False, "reason": None,
              "request_sha256": None, "policy_sha256": None}
    try:
        require(type(request_bytes) is bytes and type(policy_bytes) is bytes, "bytes_required")
        require(0 < len(request_bytes) <= MAX_REQUEST_BYTES and 0 < len(policy_bytes) <= MAX_POLICY_BYTES,
                "byte_limit")
        result["request_sha256"] = digest(request_bytes)
        result["policy_sha256"] = digest(policy_bytes)
        require(type(expected_policy_sha256) is str
                and re.fullmatch(r"[0-9a-f]{64}", expected_policy_sha256) is not None, "expected_policy_digest")
        require(result["policy_sha256"] == expected_policy_sha256, "policy_hash_mismatch")
        require(type(call_ordinal) is int and 1 <= call_ordinal <= MAX_CALL_ORDINAL, "call_ordinal")
        policy = parse(policy_bytes, MAX_POLICY_BYTES)
        profile, controls = validate_policy(policy, route, client)
        body = parse(request_bytes, MAX_REQUEST_BYTES)
        data = profile["data"][client]
        require(set(body) <= set(controls) | data, "unreviewed_request_field")
        actual = {key: value for key, value in body.items() if key not in data}
        require(canonical(actual) == canonical(controls), "request_policy_mismatch")
        history = "input" if route == "openai-direct" else "messages"
        require(type(body.get(history)) is list and len(body[history]) > 0, "history_container")
        require("tools" not in body or type(body["tools"]) is list, "tools_container")
        require("instructions" not in body or type(body["instructions"]) is str, "instructions_container")
        result["policy_verified"] = True
    except Refused as error:
        result["reason"] = str(error)
    return result
