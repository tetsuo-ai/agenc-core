"""Aggregate recorded SSE output without emitting captured text or arguments.

Run locally against copied fixtures or send this source to `ssh ... python3 -`.
Reads evidence only. Byte totals are UTF-8 lengths, NOT token estimates.
"""
import collections
import difflib
import hashlib
import json
import pathlib
import re


def byte_count(value):
    return len(value.encode('utf-8')) if isinstance(value, str) else 0


def parse_response(text):
    """Reassemble indexed tool arguments; separate reasoning/content streams."""
    reasoning = []
    content = []
    calls = {}
    usage = None
    malformed_events = 0
    unknown_delta_fields = set()
    for line in text.splitlines():
        if not line.startswith('data:'):
            continue
        payload = line[5:].strip()
        if payload == '[DONE]':
            continue
        try:
            event = json.loads(payload)
        except ValueError:
            malformed_events += 1
            continue
        if isinstance(event.get('usage'), dict):
            usage = event['usage']
        for choice in event.get('choices', []):
            delta = choice.get('delta', {})
            unknown_delta_fields.update(set(delta) - {'role', 'content', 'reasoning_content', 'tool_calls'})
            if isinstance(delta.get('reasoning_content'), str):
                reasoning.append(delta['reasoning_content'])
            if isinstance(delta.get('content'), str):
                content.append(delta['content'])
            for call in delta.get('tool_calls', []):
                key = (choice.get('index', 0), call.get('index', 0))
                target = calls.setdefault(key, {'name': '', 'arguments': ''})
                fn = call.get('function', {})
                target['name'] += fn.get('name', '') or ''
                target['arguments'] += fn.get('arguments', '') or ''
    return {'reasoning': ''.join(reasoning), 'content': ''.join(content),
            'calls': list(calls.values()), 'usage': usage,
            'malformed_events': malformed_events,
            'unknown_delta_field_count': len(unknown_delta_fields)}


def tool_category(name):
    lowered = name.lower().split('__')[-1]
    if lowered in {'multiedit', 'fileedit', 'edit'}:
        return 'edit'
    if lowered in {'filewrite', 'write'}:
        return 'write'
    if lowered in {'fileread', 'read'}:
        return 'read'
    if lowered in {'exec_command', 'bash', 'shell', 'write_stdin'}:
        return 'shell'
    if lowered in {'searchtools', 'search_tools'}:
        return 'discovery'
    return 'other'


def edit_stats(arguments):
    """Measure payload components for both common edit schemas, never their text."""
    out = collections.Counter()
    try:
        args = json.loads(arguments)
    except ValueError:
        return collections.Counter({
            'unparsed_arguments': 1,
            'unparsed_argument_bytes': byte_count(arguments),
            'unparsed_actual_newlines': arguments.count('\n'),
            'unparsed_escaped_newlines': arguments.count('\\n'),
            # Lexical diagnostic only: this does not repair/validate JSON.
            'unparsed_empty_old_literal': int(bool(re.search(r'"old_string"\s*:\s*""', arguments))),
        })
    if not isinstance(args, dict):
        return collections.Counter({'unparsed_arguments': 1})
    edits = args.get('edits', [args])
    if not isinstance(edits, list):
        return collections.Counter({'unparsed_arguments': 1})
    for edit in edits:
        if not isinstance(edit, dict):
            continue
        old = edit.get('old_string', edit.get('oldText'))
        new = edit.get('new_string', edit.get('newText'))
        if not isinstance(old, str) or not isinstance(new, str):
            continue
        out['edits'] += 1
        out['old_bytes'] += byte_count(old)
        out['new_bytes'] += byte_count(new)
        if old == '':
            out['creation_edits'] += 1
            out['creation_new_bytes'] += byte_count(new)
        # Equal line blocks measure unchanged old code repeated in replacement.
        old_lines, new_lines = old.splitlines(keepends=True), new.splitlines(keepends=True)
        matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
        out['unchanged_line_bytes_in_new'] += sum(
            byte_count(''.join(old_lines[a:a+n])) for a, _, n in matcher.get_matching_blocks())
    return out


def aggregate_response(parsed):
    metrics = collections.Counter({
        'reasoning_bytes': byte_count(parsed['reasoning']),
        'content_bytes': byte_count(parsed['content']),
        'final_content_bytes': byte_count(parsed['content']) if not parsed['calls'] else 0,
        'with_tools_content_bytes': byte_count(parsed['content']) if parsed['calls'] else 0,
        'tool_calls': len(parsed['calls']),
        'malformed_events': parsed['malformed_events'],
        'unknown_delta_field_count': parsed['unknown_delta_field_count'],
    })
    for call in parsed['calls']:
        category = tool_category(call['name'])
        metrics['tool_argument_bytes'] += byte_count(call['arguments'])
        metrics[category + '_argument_bytes'] += byte_count(call['arguments'])
        metrics[category + '_calls'] += 1
        if category == 'edit':
            metrics.update(edit_stats(call['arguments']))
    usage = parsed['usage'] or {}
    if isinstance(usage.get('completion_tokens'), int):
        metrics['reported_output_tokens'] = usage['completion_tokens']
    details = usage.get('completion_tokens_details') or {}
    if isinstance(details.get('reasoning_tokens'), int):
        metrics['reported_reasoning_tokens'] = details['reasoning_tokens']
        metrics['reasoning_token_split_available_calls'] = 1
        if isinstance(usage.get('completion_tokens'), int):
            metrics['reported_nonreasoning_tokens'] = usage['completion_tokens'] - details['reasoning_tokens']
    return metrics


def analyze_run(path):
    result = json.loads((path / 'result.json').read_text())
    total = collections.Counter()
    calls = []
    digest = hashlib.sha256()
    for source in sorted(path.glob('response-*.txt')):
        raw = source.read_bytes()
        digest.update(source.name.encode())
        digest.update(hashlib.sha256(raw).digest())
        metric = aggregate_response(parse_response(raw.decode()))
        total.update(metric)
        calls.append({'call': int(source.stem.split('-')[-1]), **dict(metric)})
    allowed = ['agent_revision', 'model_calls', 'output_tokens', 'input_tokens',
               'uncached_tokens', 'cached_tokens', 'usage_complete', 'pass', 'wall_seconds']
    return {'run': path.name, 'result': {k: result.get(k) for k in allowed},
            'response_count': len(calls), 'response_digest': digest.hexdigest(),
            'output_usage_reconciles': total['reported_output_tokens'] == result.get('output_tokens'),
            'response_count_reconciles': len(calls) == result.get('model_calls'),
            'totals': dict(total), 'calls': calls}


def main():
    root = pathlib.Path('/home/paul/claude-agenc-work/light-ultra/runs')
    task_ids = ['03-window-padding', '04-count-by', '07-source-manifest', '12-partition-map']
    rows = []
    for task in task_ids:
        for phase, agent in [('candidate-c16', 'light'), ('baseline', 'pi')]:
            rows.append(analyze_run(root / f'{phase}-deepseek-flash-{task}-{agent}-r1'))
    print(json.dumps({'schema': 1, 'unit': 'UTF-8 bytes, not tokens', 'runs': rows}, indent=2))


if __name__ == '__main__':
    main()
