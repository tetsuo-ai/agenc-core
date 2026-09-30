"""Fixed controls before admission; trusted isolated owner, no financial writes."""
from pathlib import Path
from capture import load_source, need

PIN = 'c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf'
_policy = load_source(Path(__file__).resolve().parent.parent / 'all-call-policy-v1' / 'policy.py', PIN)

def check_policy(incoming, forwarded, policy_bytes, policy_sha256, client, ordinal):
    # Do not normalize either side into a match. The original proxy serializes
    # JSON; both exact byte representations must independently pass the policy.
    for request in (incoming, forwarded):
        result = _policy['check_request'](request_bytes=request, policy_bytes=policy_bytes,
            expected_policy_sha256=policy_sha256, client=client,
            route='deepseek-proxy', call_ordinal=ordinal)
        need(result['policy_verified'] is True, 'fixed_policy_refused')
