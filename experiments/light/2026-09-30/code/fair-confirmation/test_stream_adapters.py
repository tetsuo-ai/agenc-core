import copy
import json
import unittest

import protocol
import stream_adapters as subject

PLAN = '- [ ] Implement the change\n- [ ] Run validation\n'
PIN = 'a' * 64  # Synthetic caller attestation, not a claimed production file hash.
KWARGS = dict(adapter_sha256=PIN, capture_complete=True, source='provider_response_sse')


def sse(events, done=False, numbered=False):
    return (''.join('data: ' + json.dumps({**event, **({'sequence_number': index} if numbered else {})})
                    + '\n\n' for index, event in enumerate(events))
            + ('data: [DONE]\n\n' if done else '')).encode()


def chat(delta, finish=None, **overrides):
    return {'id': 'chat-response', 'object': 'chat.completion.chunk',
            'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}], **overrides}


def message(item_id, index, text=PLAN, refusal=False):
    part_type, field = ('refusal', 'refusal') if refusal else ('output_text', 'text')
    part = {'type': part_type, field: text}
    item = {'type': 'message', 'id': item_id, 'role': 'assistant', 'content': [part]}
    common = {'item_id': item_id, 'output_index': index, 'content_index': 0}
    prefix = 'response.refusal' if refusal else 'response.output_text'
    return item, [
        {'type': 'response.output_item.added', 'output_index': index, 'item': {**item, 'content': []}},
        {'type': 'response.content_part.added', **common, 'part': {'type': part_type, field: ''}},
        {'type': prefix + '.delta', **common, 'delta': text},
        {'type': prefix + '.done', **common, field: text},
        {'type': 'response.content_part.done', **common, 'part': part},
        {'type': 'response.output_item.done', 'output_index': index, 'item': item},
    ]


def reasoning(item_id, index):
    item = {'type': 'reasoning', 'id': item_id, 'encrypted_content': 'opaque-private-value',
            'summary': [{'type': 'summary_text', 'text': PLAN}]}
    return item, [
        {'type': 'response.output_item.added', 'output_index': index, 'item': {'type': 'reasoning', 'id': item_id}},
        {'type': 'response.reasoning_summary_text.delta', 'item_id': item_id, 'output_index': index, 'delta': PLAN},
        {'type': 'response.output_item.done', 'output_index': index, 'item': item},
    ]


def tool(item_id, index):
    item = {'type': 'function_call', 'id': item_id, 'call_id': 'call_' + item_id,
            'name': 'exec_command', 'arguments': json.dumps({'cmd': PLAN})}
    return item, [
        {'type': 'response.output_item.added', 'output_index': index, 'item': {**item, 'arguments': ''}},
        {'type': 'response.function_call_arguments.delta', 'item_id': item_id, 'output_index': index, 'delta': item['arguments']},
        {'type': 'response.function_call_arguments.done', 'item_id': item_id, 'output_index': index, 'arguments': item['arguments']},
        {'type': 'response.output_item.done', 'output_index': index, 'item': item},
    ]


def responses(blocks):
    return [{'type': 'response.created', 'response': {'id': 'response-one', 'status': 'in_progress', 'output': []}}] + [
        event for _, events in blocks for event in events] + [
        {'type': 'response.completed', 'response': {'id': 'response-one', 'status': 'completed',
                                                  'output': [item for item, _ in blocks]}}]


class AdapterTests(unittest.TestCase):
    def score(self, capture):
        return protocol.visible_plan_score(capture)['visible_plan_format_pass']

    def chat(self, events, **kwargs):
        return subject.adapt_chat_completions(sse(events, done=True), **{**KWARGS, **kwargs})

    def responses(self, events, **kwargs):
        return subject.adapt_openai_responses(sse(events, numbered=True), **{**KWARGS, **kwargs})

    def unknown(self, capture):
        self.assertIsNone(self.score(capture))
        self.assertIs(capture['complete'], False)
        self.assertIs(capture['stream_order_preserved'], False)
        self.assertEqual(capture['events'], [])
        self.assertTrue(capture['unknown_reasons'])

    def test_chat_split_visible_checklist_before_tool_passes(self):
        capture = self.chat([chat({'role': 'assistant'}), chat({'content': PLAN[:12]}),
                             chat({'content': PLAN[12:]}), chat({'tool_calls': [{'index': 0, 'id': 'tool'}]}),
                             chat({}, 'tool_calls')])
        self.assertIs(self.score(capture), True)
        self.assertEqual([row['kind'] for row in capture['events']],
                         ['assistant_text_delta','assistant_text_delta','tool_call_start','assistant_message_end'])

    def test_chat_first_tool_delta_freezes_before_arguments_complete(self):
        capture = self.chat([chat({'tool_calls': [{'index': 0, 'function': {'arguments': ''}}]}),
                             chat({'content': PLAN}), chat({'tool_calls': [{'index': 0, 'function': {'arguments': '{}'}}]}, 'tool_calls')])
        self.assertIs(self.score(capture), False)

    def test_chat_same_chunk_text_and_tool_admission_is_unknown_in_either_key_order(self):
        for delta in ({'content': PLAN, 'tool_calls': [{'index': 0}]},
                      {'tool_calls': [{'index': 0}], 'content': PLAN}):
            self.unknown(self.chat([chat(delta, 'tool_calls')]))

    def test_chat_hidden_checklist_does_not_pass_or_leak(self):
        capture = self.chat([chat({'reasoning_content': PLAN, 'reasoning_details': 'opaque-private-value'}), chat({}, 'stop')])
        self.assertIs(self.score(capture), False)
        self.assertNotIn(PLAN, str(capture));self.assertNotIn('opaque-private-value', str(capture))

    def test_chat_falsey_nonschema_tool_fields_are_unknown_not_empty_lists(self):
        for value in (0, False, {}, '', 1, True, 'tool'):
            with self.subTest(value=value):
                self.unknown(self.chat([chat({'content':PLAN,'tool_calls':value},'stop')]))
        for value in (None, []):
            self.assertIs(self.score(self.chat([chat({'content':PLAN,'tool_calls':value},'stop')])),True)

    def test_chat_finish_reason_must_match_observed_tool_inventory(self):
        self.unknown(self.chat([chat({'content':PLAN},'tool_calls')]))
        self.unknown(self.chat([chat({'content':PLAN}),chat({'tool_calls':[{'index':0}]},'stop')]))

    def test_chat_usage_only_chunk_after_finish_is_supported(self):
        capture = self.chat([chat({'content': PLAN}, 'stop'), chat({}, choices=[], usage={'completion_tokens': 10})])
        self.assertIs(self.score(capture), True)

    def test_chat_missing_finish_or_done_is_unknown(self):
        self.unknown(self.chat([chat({'content': PLAN})]))
        self.unknown(subject.adapt_chat_completions(sse([chat({'content': PLAN}, 'stop')]), **KWARGS))

    def test_chat_length_filter_error_and_multiple_choices_are_unknown(self):
        for finish in ('length', 'content_filter', 'unexpected'):
            self.unknown(self.chat([chat({'content': PLAN}, finish)]))
        self.unknown(self.chat([{'error': {'message': 'private'}}]))
        self.unknown(self.chat([chat({}, choices=[{'index': 0, 'delta': {}}, {'index': 1, 'delta': {}}])]))

    def test_chat_replayed_message_object_or_input_history_not_accepted(self):
        self.unknown(self.chat([chat({}, choices=[{'index': 0, 'message': {'role': 'assistant', 'content': PLAN}, 'finish_reason': 'stop'}])]))
        self.unknown(self.chat([chat({'role': 'user', 'content': PLAN}, 'stop')]))
        self.unknown(self.chat([chat({'content': PLAN}, 'stop')], source='wire_input'))

    def test_chat_identity_change_or_postcompletion_output_is_unknown(self):
        self.unknown(self.chat([chat({'content': PLAN}), chat({}, 'stop', id='another')]))
        self.unknown(self.chat([chat({'content': PLAN}, 'stop'), chat({'content': 'later'})]))

    def test_responses_all_item_ids_share_one_assistant_response_identity(self):
        capture = self.responses(responses([reasoning('rs',0),message('m',1),tool('fc',2)]))
        self.assertIs(self.score(capture), True)
        self.assertEqual({row['message_id'] for row in capture['events']}, {'responses:response-one'})
        self.assertEqual([row['kind'] for row in capture['events']],
                         ['assistant_text_delta','tool_call_start','assistant_message_end'])
        self.assertNotIn('opaque-private-value', str(capture))

    def test_responses_item_done_does_not_end_logical_message(self):
        capture = self.responses(responses([message('one',0,'- [ ] Implement\n'), message('two',1,'- [ ] Validate\n')]))
        self.assertIs(self.score(capture), True)
        self.assertEqual(sum(row['kind'] == 'assistant_message_end' for row in capture['events']), 1)
        self.assertEqual(capture['events'][-1]['kind'], 'assistant_message_end')

    def test_responses_tool_admission_before_text_but_arguments_done_after_text_fails(self):
        t, m = tool('fc',0), message('m',1)
        events = responses([t,m])
        events[1:-1] = t[1][:1] + m[1] + t[1][1:]
        capture = self.responses(events)
        self.assertIs(self.score(capture), False)
        self.assertEqual(capture['events'][0]['kind'], 'tool_call_start')

    def test_responses_hidden_reasoning_and_tool_arguments_cannot_supply_plan(self):
        self.assertIs(self.score(self.responses(responses([reasoning('rs',0),tool('fc',1)]))), False)

    def test_responses_visible_refusal_prevents_later_checklist_prefix(self):
        self.assertIs(self.score(self.responses(responses([message('r',0,'Cannot comply.\n',True), message('m',1)]))), False)

    def test_responses_final_only_content_is_unknown_not_reconstructed(self):
        events = responses([message('m',0)])
        self.unknown(self.responses([events[0], events[-1]]))
        self.unknown(self.responses([row for row in events if row['type'] != 'response.output_text.delta']))

    def test_responses_missing_item_admission_or_item_done_is_unknown(self):
        for kind in ('response.output_item.added','response.output_item.done','response.content_part.done'):
            self.unknown(self.responses([event for event in responses([message('m',0)]) if event['type'] != kind]))

    def test_responses_missing_completion_failed_or_incomplete_are_unknown(self):
        self.unknown(self.responses(responses([message('m',0)])[:-1]))
        for kind in ('error','response.failed','response.incomplete','response.cancelled'):
            self.unknown(self.responses(responses([message('m',0)])[:-1] + [{'type':kind}]))

    def test_responses_creation_required_once_before_item_admission_even_without_sequence(self):
        events=responses([message('m',0)])
        for numbered in (False,True):
            for altered in (events[1:], [events[0],events[0],*events[1:]],
                            [events[1],events[0],*events[2:]], [events[-1]]):
                with self.subTest(numbered=numbered):
                    self.unknown(subject.adapt_openai_responses(sse(altered,numbered=numbered),**KWARGS))
        wrong=copy.deepcopy(events);wrong[0]['response']['status']='completed'
        self.unknown(self.responses(wrong))

    def test_responses_mismatched_identity_snapshot_or_part_is_unknown(self):
        for mutate in (
                lambda events: events[-1]['response'].update(id='another'),
                lambda events: events[-1]['response']['output'][0]['content'][0].update(text='unstreamed plan'),
                lambda events: events[3].update(item_id='unknown'),
                lambda events: events[3].update(content_index=4)):
            events = copy.deepcopy(responses([message('m',0)]));mutate(events)
            self.unknown(self.responses(events))

    def test_responses_sequence_gaps_mixed_presence_and_duplicates_are_unknown(self):
        events = responses([message('m',0)])
        numbered = [{**event, 'sequence_number': index} for index,event in enumerate(events)]
        for number in (99, True, -1):
            damaged=copy.deepcopy(numbered);damaged[3]['sequence_number']=number
            self.unknown(subject.adapt_openai_responses(sse(damaged), **KWARGS))
        damaged=copy.deepcopy(numbered);del damaged[3]['sequence_number']
        self.unknown(subject.adapt_openai_responses(sse(damaged), **KWARGS))

    def test_responses_unknown_tool_type_or_event_is_unknown(self):
        events=responses([tool('fc',0)]);events[1]['item']['type']='web_search_call'
        self.unknown(self.responses(events))
        events=responses([message('m',0)]);events[3]['type']='response.new_text_protocol'
        self.unknown(self.responses(events))

    def test_responses_optional_done_and_unnumbered_events_supported(self):
        raw=sse(responses([message('m',0)]),done=True)
        self.assertIs(self.score(subject.adapt_openai_responses(raw, **KWARGS)), True)

    def test_extra_event_or_repeated_terminal_is_unknown_for_both_protocols(self):
        raw=sse([chat({'content':PLAN},'stop')],done=True)
        self.unknown(subject.adapt_chat_completions(raw+sse([chat({})]), **KWARGS))
        events=responses([message('m',0)])
        self.unknown(self.responses(events+[events[-1]]))
        self.unknown(subject.adapt_openai_responses(sse(events,done=True)+b'data: [DONE]\n\n', **KWARGS))

    def test_hidden_reasoning_before_visible_plan_is_ignored_in_chat(self):
        capture=self.chat([chat({'reasoning_content': 'opaque-private-value\n'+PLAN}),
                           chat({'content':PLAN},'stop')])
        self.assertIs(self.score(capture),True)
        self.assertNotIn('opaque-private-value',str(capture))

    def test_content_after_text_done_and_snapshot_only_prefix_are_unknown(self):
        events=responses([message('m',0)])
        events.insert(5,copy.deepcopy(events[3]))
        self.unknown(self.responses(events))
        events=responses([message('m',0)])
        events[2]['part']['text']=PLAN
        self.unknown(self.responses(events))

    def test_chat_final_json_and_rendered_output_are_never_stream_evidence(self):
        raw=json.dumps({'id':'chat-response','object':'chat.completion',
                        'choices':[{'message':{'role':'assistant','content':PLAN}}]}).encode()
        self.unknown(subject.adapt_chat_completions(raw, **KWARGS))
        self.unknown(subject.adapt_chat_completions(PLAN.encode(), **KWARGS))

    def test_sse_multiline_crlf_comments_and_event_labels_are_parsed(self):
        raw=sse(responses([message('m',0)]))
        raw=raw.replace(b'data: {',b': keepalive\r\ndata: {').replace(b', "response":',b',\ndata: "response":')
        self.assertIs(self.score(subject.adapt_openai_responses(raw, **KWARGS)), True)
        mismatched=b'event: unrelated\n'+sse(responses([message('m',0)]))
        self.unknown(subject.adapt_openai_responses(mismatched, **KWARGS))

    def test_malformed_truncated_duplicate_key_non_sse_or_invalid_utf8_is_unknown(self):
        for raw in (b'data: {broken}\n\n', b'data: {"a":1,"a":2}\n\n',
                    b'data: {"a":NaN}\n\n',b'\xff',b'{"input":"plan"}',
                    sse(responses([message('m',0)]))[:-1]):
            self.unknown(subject.adapt_openai_responses(raw, **KWARGS))

    def test_output_origin_complete_attestation_and_pinned_digest_are_required(self):
        raw=sse(responses([message('m',0)]))
        for overrides in ({'source':'rendered_logs'},{'source':'replayed_history'},
                          {'capture_complete':False},{'adapter_sha256':'bad'}):
            self.unknown(subject.adapt_openai_responses(raw, **{**KWARGS,**overrides}))

    def test_adapter_is_pure_and_code_completion_stays_separate_when_capture_unknown(self):
        raw=sse([chat({'content':PLAN,'tool_calls':[{'index':0}]},'tool_calls')],done=True)
        a=subject.adapt_chat_completions(raw, **KWARGS)
        self.assertEqual(a,subject.adapt_chat_completions(raw, **KWARGS))
        score=protocol.score_cell(code_artifact_pass=True,normal_exit=True,timed_out=False,
                                  budget_stopped=False,planning_required=True,plan=protocol.visible_plan_score(a))
        self.assertIs(score['code_completion'],True)
        self.assertIsNone(score['visible_plan_format_pass'])
        self.assertIsNone(score['requested_format_contract_pass'])


if __name__ == '__main__':
    unittest.main()
