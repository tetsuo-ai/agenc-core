import json
import unittest

from analyze_output import aggregate_response, edit_stats, parse_response, tool_category


def event(delta, **extra):
    return 'data: ' + json.dumps({'choices': [{'index': 0, 'delta': delta}], **extra})


class OutputAnalysisTest(unittest.TestCase):
    def test_interleaved_indexed_arguments_reassemble(self):
        rows = [event({'tool_calls': [
            {'index': 0, 'function': {'name': 'MultiEdit', 'arguments': '{"edits":'}},
            {'index': 1, 'function': {'name': 'exec_command', 'arguments': '{"cmd":'}}]}),
            event({'tool_calls': [
                {'index': 1, 'function': {'arguments': '"true"}'}},
                {'index': 0, 'function': {'arguments': '[]}'}}]}), 'data: [DONE]']
        parsed = parse_response('\n'.join(rows))
        self.assertEqual([json.loads(c['arguments']) for c in parsed['calls']],
                         [{'edits': []}, {'cmd': 'true'}])

    def test_separate_streams_and_unicode_byte_lengths(self):
        parsed = parse_response('\n'.join([event({'reasoning_content': 'think'}),
            event({'content': 'é'}), event({}, usage={'completion_tokens': 9})]))
        metrics = aggregate_response(parsed)
        self.assertEqual(metrics['reasoning_bytes'], 5)
        self.assertEqual(metrics['final_content_bytes'], 2)
        self.assertEqual(metrics['reported_output_tokens'], 9)
        self.assertNotIn('reported_reasoning_tokens', metrics)

    def test_tools_content_is_not_final(self):
        parsed = parse_response(event({'content': 'working', 'tool_calls': [
            {'index': 0, 'function': {'name': 'read', 'arguments': '{}'}}]}))
        self.assertEqual(aggregate_response(parsed)['final_content_bytes'], 0)
        self.assertEqual(aggregate_response(parsed)['with_tools_content_bytes'], 7)

    def test_old_and_unchanged_are_distinct(self):
        metric = edit_stats(json.dumps({'edits': [{'old_string': 'a\nb\n',
                                                  'new_string': 'a\nc\n'}]}))
        self.assertEqual(metric['old_bytes'], 4)
        self.assertEqual(metric['new_bytes'], 4)
        self.assertEqual(metric['unchanged_line_bytes_in_new'], 2)

    def test_creation_has_no_old_payload(self):
        metric = edit_stats(json.dumps({'edits': [{'old_string': '', 'new_string': 'new'}]}))
        self.assertEqual(metric['creation_edits'], 1)
        self.assertEqual(metric['old_bytes'], 0)
        self.assertEqual(metric['creation_new_bytes'], 3)

    def test_pi_schema_measured_without_copying_behavior(self):
        metric = edit_stats(json.dumps({'oldText': 'old', 'newText': 'new'}))
        self.assertEqual(metric['old_bytes'], 3)

    def test_malformed_and_unknown_are_visible(self):
        parsed = parse_response('data: malformed\n' + event({'unknown': 'redacted'}))
        metric = aggregate_response(parsed)
        self.assertEqual(metric['malformed_events'], 1)
        self.assertEqual(metric['unknown_delta_field_count'], 1)
        self.assertEqual(edit_stats('bad')['unparsed_arguments'], 1)

    def test_explicit_reasoning_token_split_only(self):
        metric = aggregate_response(parse_response(event({}, usage={
            'completion_tokens': 9, 'completion_tokens_details': {'reasoning_tokens': 7}})))
        self.assertEqual(metric['reported_reasoning_tokens'], 7)
        self.assertEqual(metric['reported_nonreasoning_tokens'], 2)
        self.assertEqual(metric['reasoning_token_split_available_calls'], 1)

    def test_malformed_creation_diagnostic_does_not_repair(self):
        argument = '{"old_string":"","new_string":"literal\nnewline"}'
        metric = edit_stats(argument)
        self.assertEqual(metric['unparsed_arguments'], 1)
        self.assertEqual(metric['unparsed_empty_old_literal'], 1)
        self.assertEqual(metric['unparsed_actual_newlines'], 1)
        self.assertNotIn('new_bytes', metric)

    def test_unknown_names_never_emitted(self):
        self.assertEqual(tool_category('secret-bearing-name'), 'other')
        parsed = parse_response(event({'tool_calls': [{'index': 0, 'function': {
            'name': 'secret-bearing-name', 'arguments': '{"secret":"value"}'}}]}))
        self.assertNotIn('secret', json.dumps(aggregate_response(parsed)))


if __name__ == '__main__':
    unittest.main()
