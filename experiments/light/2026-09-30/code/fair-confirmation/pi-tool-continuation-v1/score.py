"""Post-run call-1 output scoring only; no finalization or financial authority."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import stat
import sys

HERE = Path(__file__).resolve().parent
FAIR = HERE.parent


def read(path, maximum=2 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError('artifact_refused')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(maximum + 1)
        if len(raw) != info.st_size or len(raw) > maximum:
            raise ValueError('artifact_refused')
        return raw
    finally:
        os.close(fd)


def main():
    root = Path(sys.argv[1])
    selection = json.loads(read(HERE / 'selection.json'))
    source = FAIR / 'shared-score-v1/fair_cells.py'
    raw = read(source)
    if hashlib.sha256(raw).hexdigest() != selection['dependencies']['shared-score-v1/fair_cells.py']:
        raise ValueError('score_source_refused')
    namespace = {'__file__': str(source), '__name__': '_owned_diagnostic_score'}
    exec(compile(raw, str(source), 'exec'), namespace)
    # Inventory is written only by parent after both ordered publications and
    # child close. It is diagnostic provenance, not a deployed finalizer token.
    inventory = json.loads(read(root / 'score-input.json'))
    meta = json.loads(read(root / 'metadata.json'))
    expected = meta['binding']['expected']
    ack = inventory['first_ack']
    spec = {key: expected[key] for key in ('client', 'protocol_id', 'run_id', 'root_turn_id', 'route', 'task_prompt_sha256')}
    spec.update(binding_profile_id='pi-luna-v0731-shared-v1',
                observer_source_sha256=selection['dependencies']['luna-observer-v6/direct.mjs'],
                request_body_sha256=ack['request_body_sha256'], receipt_sha256=ack['receipt_sha256'])
    result = namespace['score_fair_cell'](
        spec=spec, receipt_bytes=read(root / 'capture-receipt-001.json', 32768),
        request_bytes=read(root / 'capture-request-001.json'),
        response_bytes=read(root / 'capture-response-001.sse'),
        source_pins={'adapter_sha256': selection['dependencies']['stream_adapters.py'],
                     'grader_sha256': selection['dependencies']['protocol.py']},
        contract_bytes=read(root / 'contract.json'), binding_expected=expected,
        deployed_source_pins=meta['binding']['deployed_source_pins'],
        planning_required=True, code_artifact_pass=None,
        normal_exit=inventory['normal_exit'], timed_out=False, budget_stopped=False)
    keys = ('binding_verified', 'capture_verified', 'adapter_capture_complete',
            'visible_plan_format_pass', 'plan_reason', 'evidence_unknown_reason',
            'code_completion', 'plan_semantic_quality')
    print(json.dumps({key: result.get(key) for key in keys}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"score_error":"diagnostic_score_refused"}')
        sys.exit(1)
