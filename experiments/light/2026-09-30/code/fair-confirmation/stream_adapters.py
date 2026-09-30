"""Draft pure adapters for ONE complete provider OUTPUT SSE response.

No filesystem, network, runner integration, history reconstruction or scoring.
The trusted caller must attest output origin/completeness and pin this file hash.
"""
from __future__ import annotations

import hashlib
import json
import re


class InvalidCapture(ValueError):
    pass


def need(condition, reason):
    if not condition:
        raise InvalidCapture(reason)


def integer(value):
    return type(value) is int and value >= 0


def identifier(value):
    return isinstance(value, str) and bool(value)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate_json_key')
        result[key] = value
    return result


def frames(raw):
    """Parse SSE framing, not line-wise JSON or a final-response JSON object."""
    text = raw.decode('utf-8')
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    data, event = [], None
    for line in text.splitlines():
        if line == '':
            if data:
                payload = '\n'.join(data)
                if payload == '[DONE]':
                    yield event, None
                else:
                    value = json.loads(payload, object_pairs_hook=unique_object,
                                       parse_constant=lambda _: need(False, 'nonfinite_json'))
                    need(isinstance(value, dict), 'nonobject_sse_event')
                    yield event, value
            data, event = [], None
        elif line.startswith(':'):
            continue
        else:
            key, colon, value = line.partition(':')
            if value.startswith(' '):
                value = value[1:]
            need(key in ('data', 'event', 'id', 'retry'), 'unsupported_sse_field')
            if key == 'data':
                need(bool(colon), 'malformed_sse_data')
                data.append(value)
            elif key == 'event':
                need(event is None, 'duplicate_sse_event_field')
                event = value
    need(not data and event is None, 'unterminated_sse_frame')


def adapt(raw, adapter_sha256, capture_complete, source, name, decode):
    capture = {'schema_version': 1, 'adapter': name, 'adapter_sha256': adapter_sha256,
               'complete': False, 'stream_order_preserved': False, 'events': []}
    try:
        need(type(raw) is bytes, 'raw_output_bytes_required')
        capture['response_sse_sha256'] = hashlib.sha256(raw).hexdigest()
        need(source == 'provider_response_sse', 'provider_output_origin_required')
        need(capture_complete is True, 'capture_not_complete')
        need(isinstance(adapter_sha256, str) and re.fullmatch('[0-9a-f]{64}', adapter_sha256),
             'pinned_adapter_digest_required')
        response_id, events = decode(list(frames(raw)))
        capture.update(complete=True, stream_order_preserved=True,
                       events=[{'seq': index, 'message_id': response_id, **event}
                               for index, event in enumerate(events, 1)], unknown_reasons=[])
    except InvalidCapture as error:
        capture['unknown_reasons'] = [str(error)]
    except (UnicodeError, json.JSONDecodeError, TypeError, KeyError, AttributeError):
        capture['unknown_reasons'] = ['malformed_provider_capture']
    return capture


def adapt_chat_completions(raw, *, adapter_sha256, capture_complete, source):
    return adapt(raw, adapter_sha256, capture_complete, source, 'chat-output-sse-v1-draft', _chat)


def _chat(records):
    events, tools = [], set()
    response_id = None
    finished = done = False
    for label, chunk in records:
        need(not done, 'event_after_done')
        if chunk is None:
            need(finished, 'done_without_provider_completion')
            done = True
            continue
        need(label in (None, 'message'), 'unexpected_chat_event_label')
        need('error' not in chunk, 'provider_error')
        need(chunk.get('object') == 'chat.completion.chunk', 'not_chat_output_chunk')
        need(identifier(chunk.get('id')), 'missing_response_identity')
        response_id = response_id or chunk['id']
        need(response_id == chunk['id'], 'multiple_logical_responses')
        choices = chunk.get('choices')
        need(isinstance(choices, list), 'missing_choices')
        if not choices:
            need(isinstance(chunk.get('usage'), dict), 'empty_chunk_without_usage')
            continue
        need(not finished, 'choice_after_provider_completion')
        need(len(choices) == 1 and type(choices[0].get('index')) is int and choices[0]['index'] == 0,
             'ambiguous_chat_choices')
        choice = choices[0]
        delta = choice.get('delta')
        need(isinstance(delta, dict), 'missing_chat_delta')
        need(set(delta) <= {'role', 'content', 'refusal', 'tool_calls', 'reasoning_content',
                            'reasoning', 'reasoning_details'}, 'unsupported_chat_delta')
        need(delta.get('role', 'assistant') == 'assistant', 'nonassistant_output')
        text, refusal = delta.get('content'), delta.get('refusal')
        need(text is None or isinstance(text, str), 'unsupported_chat_content')
        need(refusal is None or isinstance(refusal, str), 'unsupported_chat_refusal')
        need(not (text and refusal), 'ambiguous_visible_delta_order')
        visible = text or refusal or ''
        calls = delta.get('tool_calls')
        need(calls is None or isinstance(calls, list), 'invalid_tool_delta')
        calls = [] if calls is None else calls
        starts = False
        for call in calls:
            need(isinstance(call, dict) and integer(call.get('index')), 'invalid_tool_index')
            if call['index'] not in tools:
                tools.add(call['index'])
                starts = True
        # Fields in a JSON object do not establish text-versus-tool chronology.
        need(not (visible and starts), 'ambiguous_text_and_tool_admission_in_chat_chunk')
        if visible:
            events.append({'kind': 'assistant_text_delta', 'text': visible})
        if starts:
            events.append({'kind': 'tool_call_start'})
        finish = choice.get('finish_reason')
        if finish is not None:
            need(finish in ('stop', 'tool_calls'), 'noncomplete_chat_finish_reason')
            need(bool(tools) == (finish == 'tool_calls'), 'chat_finish_tool_inventory_disagreement')
            finished = True
            events.append({'kind': 'assistant_message_end'})
    need(response_id and finished and done, 'missing_chat_completion_or_done')
    return 'chat:' + response_id, events


def adapt_openai_responses(raw, *, adapter_sha256, capture_complete, source):
    return adapt(raw, adapter_sha256, capture_complete, source, 'responses-output-sse-v1-draft', _responses)


def _responses(records):
    events, items, indexes, parts = [], {}, {}, {}
    response_id = None
    opened = completed = done = False
    sequence_mode, previous_sequence = None, None
    hidden_types = {'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
                    'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
                    'response.reasoning_text.delta', 'response.reasoning_text.done'}
    for label, event in records:
        need(not done, 'event_after_done')
        if event is None:
            need(completed, 'done_without_provider_completion')
            done = True
            continue
        need(not completed, 'event_after_provider_completion')
        kind = event.get('type')
        need(identifier(kind) and label in (None, kind), 'event_type_label_mismatch')
        if kind == 'response.created':
            need(not opened, 'duplicate_response_creation')
            opened = True
        else:
            need(opened, 'missing_response_creation')
        numbered = 'sequence_number' in event
        if sequence_mode is None:
            sequence_mode = numbered
        need(sequence_mode == numbered, 'mixed_sequence_number_presence')
        if numbered:
            number = event['sequence_number']
            need(integer(number) and (number in (0, 1) if previous_sequence is None
                 else number == previous_sequence + 1), 'discontinuous_provider_sequence')
            previous_sequence = number
        need(kind not in ('error', 'response.failed', 'response.incomplete', 'response.cancelled')
             and event.get('error') is None, 'provider_error_or_incomplete')
        if kind in ('response.created', 'response.in_progress', 'response.queued', 'response.completed'):
            response = event.get('response')
            need(isinstance(response, dict) and identifier(response.get('id')), 'missing_response_identity')
            response_id = response_id or response['id']
            need(response_id == response['id'], 'multiple_logical_responses')
            need(response.get('error') is None and response.get('status') not in ('failed','incomplete','cancelled'),
                 'provider_error_or_incomplete')
            if kind == 'response.completed':
                need(response.get('status') == 'completed', 'noncomplete_response_status')
                output = response.get('output')
                need(isinstance(output, list) and len(output) == len(items), 'incomplete_output_item_capture')
                need([item.get('id') for item in output] == [indexes[n] for n in sorted(indexes)],
                     'output_item_identity_disagreement')
                for item in output:
                    recorded = items[item['id']]
                    need(recorded['done'] and item.get('type') == recorded['type'], 'missing_output_item_done')
                    if recorded['type'] == 'message':
                        _check_message(item, parts)
                need(all(part['done'] for part in parts.values()), 'missing_content_part_done')
                completed = True
                events.append({'kind': 'assistant_message_end'})
            else:
                need(response.get('status') in ('queued', 'in_progress'), 'invalid_open_response_status')
                need(not response.get('output'), 'unstreamed_initial_output')
            continue
        if kind == 'response.output_item.added':
            item, index = event.get('item'), event.get('output_index')
            need(isinstance(item, dict) and identifier(item.get('id')) and integer(index), 'invalid_output_item')
            need(item['id'] not in items and index == len(indexes), 'duplicate_or_discontinuous_item_admission')
            item_type = item.get('type')
            need(item_type in ('message', 'reasoning', 'function_call'), 'unsupported_output_item_type')
            if item_type == 'message':
                need(item.get('role') == 'assistant' and not item.get('content'), 'unstreamed_or_nonassistant_message')
            items[item['id']] = {'type': item_type, 'done': False}
            indexes[index] = item['id']
            if item_type == 'function_call':
                events.append({'kind': 'tool_call_start'})
            continue
        item_id = event.get('item_id') if kind != 'response.output_item.done' else event.get('item', {}).get('id')
        index = event.get('output_index')
        need(item_id in items and integer(index) and indexes.get(index) == item_id, 'event_without_matching_item_admission')
        item = items[item_id]
        need(not item['done'], 'event_after_item_done')
        if kind == 'response.output_item.done':
            need(event['item'].get('type') == item['type'], 'output_item_type_disagreement')
            if item['type'] == 'message':
                _check_message(event['item'], parts)
            item['done'] = True
        elif kind in hidden_types:
            need(item['type'] == 'reasoning', 'reasoning_event_on_nonreasoning_item')
            # Intentionally retain none of summary/hidden/encrypted reasoning.
        elif kind in ('response.function_call_arguments.delta', 'response.function_call_arguments.done'):
            need(item['type'] == 'function_call', 'arguments_event_on_nontool_item')
            # Arguments (including apparent checklist text) are not visible plans.
        else:
            need(item['type'] == 'message', 'visible_event_on_nonmessage_item')
            content_index = event.get('content_index')
            need(integer(content_index), 'invalid_content_index')
            key = (item_id, content_index)
            if kind == 'response.content_part.added':
                part = event.get('part')
                need(key not in parts and content_index == sum(k[0] == item_id for k in parts), 'discontinuous_content_admission')
                need(isinstance(part, dict) and part.get('type') in ('output_text','refusal'), 'unsupported_content_part')
                field = 'text' if part['type'] == 'output_text' else 'refusal'
                need(part.get(field) == '', 'unstreamed_visible_content')
                parts[key] = {'type': part['type'], 'text': '', 'done': False, 'text_done': False}
            else:
                need(key in parts and not parts[key]['done'], 'event_without_open_content_part')
                part = parts[key]
                prefix = 'response.output_text' if part['type'] == 'output_text' else 'response.refusal'
                if kind == prefix + '.delta':
                    need(not part['text_done'] and isinstance(event.get('delta'), str), 'invalid_visible_delta')
                    part['text'] += event['delta']
                    events.append({'kind': 'assistant_text_delta', 'text': event['delta']})
                elif kind == prefix + '.done':
                    field = 'text' if part['type'] == 'output_text' else 'refusal'
                    need(not part['text_done'] and event.get(field) == part['text'], 'missing_or_mismatched_visible_deltas')
                    part['text_done'] = True
                elif kind == 'response.content_part.done':
                    field = 'text' if part['type'] == 'output_text' else 'refusal'
                    need(part['text_done'] and event.get('part', {}).get('type') == part['type']
                         and event['part'].get(field) == part['text'], 'content_part_disagreement')
                    part['done'] = True
                else:
                    raise InvalidCapture('unsupported_responses_event')
    need(opened and response_id and completed, 'missing_responses_completion')
    return 'responses:' + response_id, events


def _check_message(item, parts):
    need(item.get('role') == 'assistant' and isinstance(item.get('content'), list), 'invalid_message_snapshot')
    expected = [parts[key] for key in sorted(parts) if key[0] == item['id']]
    need(len(item['content']) == len(expected), 'missing_message_content_deltas')
    for observed, part in zip(item['content'], expected):
        field = 'text' if part['type'] == 'output_text' else 'refusal'
        need(observed.get('type') == part['type'] and observed.get(field) == part['text'], 'message_snapshot_disagreement')
