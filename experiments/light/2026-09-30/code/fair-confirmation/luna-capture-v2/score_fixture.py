"""Synthetic local integration test only; not a runner or trusted inventory."""
import hashlib
import json
import pathlib
import sys

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import fair_cells

root = pathlib.Path(sys.argv[1])
raw = (root / 'capture-receipt-001.json').read_bytes()
receipt = json.loads(raw)
sha = lambda data: hashlib.sha256(data).hexdigest()
spec = {key: receipt[key] for key in ('protocol_id', 'run_id', 'root_turn_id', 'route',
        'task_prompt_sha256', 'observer_source_sha256', 'request_body_sha256')}
spec['receipt_sha256'] = sha(raw)
print(json.dumps(fair_cells.score_fair_cell(
    spec=spec, receipt_bytes=raw, request_bytes=(root/'capture-request-001.json').read_bytes(),
    response_bytes=(root/'capture-response-001.sse').read_bytes(),
    source_pins={'adapter_sha256':sha((HERE.parent/'stream_adapters.py').read_bytes()),
                 'grader_sha256':sha((HERE.parent/'protocol.py').read_bytes())},
    planning_required=True, code_artifact_pass=True, normal_exit=True, timed_out=False,
    budget_stopped=False)))
