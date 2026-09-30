#!/usr/bin/env python3
"""Offline, Linux-only gate diagnostics. No network, credential or repository reads.

Inputs are completed run folders, or a runs root filtered with --glob. Output is
JSON metadata only. --calls adds per-request metadata, never captured text/args.
The first final is a completed response with nonempty assistant text and no tool
calls. Tokens through that call include its final answer; after excludes it.
Null totals mean incomplete evidence; observed totals are lower bounds.
Execution receipts count completed dispatches (including denied/failed tools),
not proof that a command ran or a filesystem effect occurred. Missing/truncated
logs cannot establish an exact execution count.
"""
from __future__ import annotations

import argparse
from collections import Counter
import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import sys


TOKEN_FIELDS = ('input_tokens', 'cached_tokens', 'uncached_tokens', 'output_tokens')


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (ValueError, OSError, UnicodeError):
        return None


def compact(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ''.join(p.get('text', '') for p in content if isinstance(p, dict) and isinstance(p.get('text'), str))
    return ''


def response(path):
    """Parse SSE without exposing text. Keep IDs privately for receipt correlation."""
    try:
        lines = path.read_text().splitlines()
    except (OSError, UnicodeError):
        return {'present': False, 'complete': False, 'final_answer': False, '_tools': []}
    events, pending, malformed, done = [], [], 0, False
    for line in [*lines, '']:
        if line.startswith('data:'):
            pending.append(line[5:].lstrip(' '))
        elif not line and pending:
            data = '\n'.join(pending); pending = []
            if data == '[DONE]':
                done = True
                continue
            try:
                item = json.loads(data)
                if isinstance(item, dict): events.append(item)
                else: malformed += 1
            except ValueError:
                malformed += 1
    kind, text, finish, terminal, failed = None, '', None, False, False
    tools, response_items = {}, {}
    for event in events:
        if 'choices' in event:
            kind = 'chat_completions'
            for choice in event.get('choices', []):
                if choice.get('index', 0) != 0: continue
                delta = choice.get('delta') or choice.get('message') or {}
                text += content_text(delta.get('content'))
                if choice.get('finish_reason') is not None:
                    finish = choice['finish_reason']; terminal = True
                for call in delta.get('tool_calls', []):
                    key = call.get('index', call.get('id', len(tools)))
                    tool = tools.setdefault(key, {'id': '', 'name': '', 'arguments': '', 'done': False})
                    if call.get('id'): tool['id'] = call['id']
                    function = call.get('function') or {}
                    tool['name'] += function.get('name') or ''
                    tool['arguments'] += function.get('arguments') or ''
        event_type = event.get('type', '')
        if event_type.startswith('response.'):
            kind = 'responses'
            if event_type == 'response.output_text.delta': text += event.get('delta') or ''
            if event_type in ('response.output_item.added', 'response.output_item.done'):
                item = event.get('item') or {}
                key = item.get('id', event.get('output_index'))
                response_items[key] = item
                if item.get('type') == 'function_call':
                    tool = tools.setdefault(key, {'id': '', 'name': '', 'arguments': '', 'done': False})
                    tool.update(id=item.get('call_id') or tool['id'], name=item.get('name') or tool['name'])
                    if item.get('arguments') is not None: tool['arguments'] = item['arguments']
                    if event_type.endswith('.done'): tool['done'] = True
            if event_type == 'response.function_call_arguments.delta':
                key = event.get('item_id', event.get('output_index'))
                tool = tools.setdefault(key, {'id': '', 'name': '', 'arguments': '', 'done': False})
                tool['arguments'] += event.get('delta') or ''
            if event_type == 'response.function_call_arguments.done':
                key = event.get('item_id', event.get('output_index'))
                tool = tools.setdefault(key, {'id': '', 'name': '', 'arguments': '', 'done': False})
                tool['arguments'] = event.get('arguments', tool['arguments'])
                tool['name'] = event.get('name', tool['name']); tool['done'] = True
            if event_type in ('response.completed', 'response.incomplete', 'response.failed'):
                final = event.get('response') or {}
                terminal = True; failed = event_type != 'response.completed' or final.get('status', 'completed') != 'completed'
                finish = event_type.removeprefix('response.')
                for index, item in enumerate(final.get('output') or []):
                    key = item.get('id', index); response_items[key] = item
                    if item.get('type') == 'function_call':
                        tools[key] = {'id': item.get('call_id', ''), 'name': item.get('name', ''),
                                      'arguments': item.get('arguments', ''), 'done': not failed}
        if 'error' in event or event_type == 'error': failed = True
    if kind == 'responses' and not text:
        text = ''.join(content_text(item.get('content')) for item in response_items.values() if item.get('type') == 'message')
    complete = terminal and not failed and malformed == 0 and finish not in ('length', 'content_filter')
    valid_tools = []
    for tool in tools.values():
        try:
            valid_args = isinstance(json.loads(tool['arguments']), dict)
        except (ValueError, TypeError):
            valid_args = False
        valid = bool(tool['name']) and valid_args and (tool['done'] or kind == 'chat_completions' and complete)
        valid_tools.append({'id': tool['id'], 'name': tool['name'], 'complete': valid})
    return {'present': True, 'api': kind, 'complete': complete, 'terminal_observed': terminal,
            'done_sentinel': done, 'malformed_events': malformed, 'finish_reason': finish,
            'assistant_text_chars': len(text), 'tool_calls_started_observed': len(tools),
            'tool_calls_emitted_complete': sum(t['complete'] for t in valid_tools),
            'final_answer': complete and bool(text.strip()) and not tools, '_tools': valid_tools}


def execution_receipts(path, clean_completion):
    receipts, terminal, structured = {}, False, 0
    def visit(value):
        nonlocal terminal, structured
        if isinstance(value, list):
            for item in value: visit(item)
        elif isinstance(value, dict):
            event_type = value.get('type')
            if event_type in ('result', 'agent_end'): terminal = True
            if event_type in ('tool_call_completed', 'tool_execution_end'):
                payload = value.get('payload', value)
                call_id = payload.get('callId', payload.get('toolCallId'))
                name = payload.get('toolName')
                if isinstance(call_id, str) and isinstance(name, str):
                    # Pi combines Responses call_id and item_id with a pipe.
                    receipts[(call_id.split('|', 1)[0], name)] = payload.get('isError')
            # Only walk containers, never parse embedded result/argument strings.
            for child in value.values():
                if isinstance(child, (dict, list)): visit(child)
    try:
        with path.open() as stream:
            for line in stream:
                try: item = json.loads(line)
                except ValueError: continue  # CLI banners are not execution events.
                structured += 1; visit(item)
    except (OSError, UnicodeError):
        pass
    exact = bool(structured and terminal and clean_completion)
    return receipts, exact


def token_totals(calls):
    complete = all(c['usage_complete'] for c in calls)
    observed = {key: sum(c['usage'][key] for c in calls if c['usage_complete']) for key in TOKEN_FIELDS}
    observed['total_tokens'] = observed['input_tokens'] + observed['output_tokens']
    return {'complete': complete, 'calls': len(calls), 'known_usage_calls': sum(c['usage_complete'] for c in calls),
            'tokens': observed if complete else None, 'observed_tokens': observed}


def analyze(directory, include_calls=False):
    result = read_json(directory / 'result.json')
    if result is None: return None
    clean = result.get('exit_code') == 0 and not any(result.get(k) for k in ('timeout', 'budget_stop', 'provider_unavailable'))
    indices = {int(m.group(1)) for path in directory.iterdir()
               if (m := re.fullmatch(r'(?:wire|response|usage)-(\d+)\.(?:json|txt)', path.name))}
    reported = result.get('model_calls')
    if isinstance(reported, int) and not isinstance(reported, bool) and 0 <= reported <= 100000:
        indices.update(range(1, reported + 1))
    calls, heads, schemas, last_history, rewrites = [], set(), set(), None, 0
    receipts, receipts_exact = execution_receipts(directory / 'agent.log', clean)
    for index in sorted(indices):
        wire = read_json(directory / f'wire-{index:03}.json')
        body = wire.get('body') if wire else None
        call = {'call': index, 'request_complete': isinstance(body, dict)}
        if isinstance(body, dict):
            messages = body.get('messages', body.get('input', []))
            messages = messages if isinstance(messages, list) else []
            system = [m for m in messages if isinstance(m, dict) and m.get('role') in ('system', 'developer')]
            history = [m for m in messages if m not in system]
            head = [body.get('instructions'), *system]
            schema = body.get('tools', [])
            heads.add(hashlib.sha256(compact(head).encode()).hexdigest())
            schemas.add(hashlib.sha256(compact(schema).encode()).hexdigest())
            if last_history is not None: rewrites += history[:len(last_history)] != last_history
            last_history = history
            call.update(request_body_chars=len(compact(body)), schema_json_chars=len(compact(schema)),
                        system_text_chars=len(content_text(body.get('instructions'))) + sum(len(content_text(m.get('content'))) for m in system),
                        advertised_tools=len(schema))
        parsed = response(directory / f'response-{index:03}.txt')
        private_tools = parsed.pop('_tools')
        call['response'] = parsed
        call['execution_receipts_matched'] = sum((t['id'], t['name']) in receipts for t in private_tools)
        usage = read_json(directory / f'usage-{index:03}.json')
        call['usage_complete'] = bool(usage and usage.get('usage_missing') is False and all(number(usage.get(k)) for k in TOKEN_FIELDS))
        call['usage'] = {k: usage[k] for k in TOKEN_FIELDS} if call['usage_complete'] else None
        call['provider_error_recorded'] = bool(usage and usage.get('error'))
        calls.append(call)
    finals = [c['call'] for c in calls if c['response']['final_answer']]
    first = finals[0] if finals else None
    boundary_known = all(c['response']['complete'] for c in calls if first is None or c['call'] <= first)
    through = [c for c in calls if first is not None and c['call'] <= first]
    after = [c for c in calls if first is not None and c['call'] > first]
    artifact = result.get('check_pass')
    effective = bool(result.get('pass') and artifact and clean) if isinstance(artifact, bool) and isinstance(result.get('pass'), bool) else None
    summary = {k: result.get(k) for k in ('id', 'phase', 'task', 'agent', 'model', 'repeat', 'agent_revision', 'wall_seconds')}
    summary.update(artifact_pass=artifact, clean_completion=clean, effective_pass=effective,
        timeout=bool(result.get('timeout')), reported_usage_complete=result.get('usage_complete'),
        reported_model_calls=reported, captured_call_slots=len(calls),
        final_answer_calls=finals, first_final_call=first, first_final_boundary_known=boundary_known,
        all_streams_complete=all(c['response']['complete'] for c in calls),
        all_requests_complete=all(c['request_complete'] for c in calls),
        usage=token_totals(calls),
        through_first_final=token_totals(through) if first is not None and boundary_known else None,
        after_first_final=token_totals(after) if first is not None and boundary_known else None,
        tool_calls_started_observed=sum(c['response'].get('tool_calls_started_observed', 0) for c in calls),
        tool_calls_emitted_complete=sum(c['response'].get('tool_calls_emitted_complete', 0) for c in calls),
        execution_receipts_observed=len(receipts), execution_receipts_exact=len(receipts) if receipts_exact else None,
        execution_errors_observed=sum(v is True for v in receipts.values()),
        first_request={k: calls[0].get(k) for k in ('system_text_chars', 'schema_json_chars', 'request_body_chars', 'advertised_tools')} if calls else None,
        system_versions=len(heads), schema_versions=len(schemas), history_rewrite_events=rewrites)
    if include_calls: summary['calls'] = calls
    return summary


def main():
    if sys.platform != 'linux': raise SystemExit('Offline trace analysis executes only on Linux')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths', nargs='+', type=Path, help='Completed run directories or their parent runs root')
    parser.add_argument('--glob', default='*', help='Child run-name filter when a runs root is supplied')
    parser.add_argument('--calls', action='store_true', help='Include per-call metadata')
    args = parser.parse_args()
    directories = set()
    for path in args.paths:
        if (path / 'result.json').is_file(): directories.add(path)
        elif path.is_dir(): directories.update(p for p in path.glob(args.glob) if p.is_dir() and (p / 'result.json').is_file())
    runs = [r for path in sorted(directories) if (r := analyze(path, args.calls)) is not None]
    print(json.dumps({'snapshot_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'completed_result_files': len(runs), 'runs': runs}, indent=2))


if __name__ == '__main__':
    main()
