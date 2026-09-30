import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import decompose_luna as d

def usage(start=1,end=5):
    return {"seconds":end-start,"timing":dict(zip(d.TIME_KEYS,[start,start+.5,start+1,end-.5,end])),
        "usage":{"input_tokens":10,"output_tokens":9,"output_tokens_details":{"reasoning_tokens":2}},
        "usage_missing":False,"error":None}

def sse(items=None,record=None,prior=None):
    record=record or usage()
    event={"type":"response.completed","response":{"status":"completed","usage":record["usage"],
        "output":items if items is not None else [{"type":"message","content":[{"type":"output_text","text":"visible"}]}]}}
    return b"".join(("data: "+json.dumps(e)+"\n\n").encode() for e in [*(prior or []),event])

class TimingTests(unittest.TestCase):
    def test_serial_intervals_and_gaps(self):
        r=d.timing_summary([usage(1,5),usage(7,10)],12)
        self.assertEqual(r["request_interval_sum_seconds"],7)
        self.assertEqual(r["request_interval_union_seconds"],7)
        self.assertEqual(r["between_request_gaps_seconds"],2)
        self.assertEqual(r["wall_minus_request_span_seconds"],3)
        self.assertEqual(r["wall_minus_union_seconds"],5)
        self.assertFalse(r["cli_interval_containment_verified"])
        self.assertTrue(r["stage_sums_additive_to_union"])

    def test_overlaps_use_union_and_do_not_double_count(self):
        r=d.timing_summary([usage(1,5),usage(3,7)],9)
        self.assertEqual(r["request_interval_sum_seconds"],8)
        self.assertEqual(r["request_interval_union_seconds"],6)
        self.assertEqual(r["request_interval_overlap_seconds"],2)
        self.assertEqual(r["wall_minus_union_seconds"],3)
        self.assertFalse(r["stage_sums_additive_to_union"])

    def test_touching_nested_and_unsorted_intervals(self):
        self.assertEqual(d.interval_union([[6,8],[1,4],[2,3],[4,6]]),
            {"sum":8,"union":7,"span":7,"overlap":1,"gaps":0})

    def test_missing_timing_retains_known_partial_not_full(self):
        r=d.timing_summary([usage(),{}],10)
        self.assertEqual(r["known_request_interval_sum_seconds"],4)
        self.assertIsNone(r["request_interval_sum_seconds"])
        self.assertIsNone(r["wall_minus_union_seconds"])
        self.assertIsNone(r["stage_sums_seconds"])

    def test_missing_records_not_false_complete(self):
        r=d.timing_summary([usage()],10,2)
        self.assertFalse(r["complete_request_intervals"])
        self.assertIsNone(r["stage_sums_seconds"])

    def test_missing_first_delta_keeps_request_interval(self):
        x=usage();x["timing"]["first_token_at"]=None
        r=d.timing_summary([x],10)
        self.assertEqual(r["request_interval_union_seconds"],4)
        self.assertIsNone(r["stage_sums_seconds"])

    def test_clock_inversion_and_bool_rejected(self):
        for bad in (-1,False,float("nan")):
            x=usage();x["timing"]["stream_end_at"]=bad
            self.assertIsNone(d.timing_record(x)["interval"])

    def test_span_exceeding_wall_not_negative_runtime(self):
        r=d.timing_summary([usage(1,5)],2)
        self.assertIsNone(r["wall_minus_union_seconds"])
        self.assertIn("request_span_exceeds_cli_wall",r["issues"])

    def test_seconds_mismatch_retained(self):
        x=usage();x["seconds"]=100
        self.assertIn("recorded_seconds_mismatch",d.timing_record(x)["issues"])

    def test_zero_call_no_latency_measurement(self):
        self.assertIsNone(d.timing_summary([],0)["request_interval_union_seconds"])

class ResponseTests(unittest.TestCase):
    def test_text_only_and_explicit_reasoning(self):
        r=d.response_record(sse(),usage())
        self.assertEqual(r["category"],"visible_text_without_tools")
        self.assertEqual(r["visible_text_chars"],7)
        self.assertEqual(r["reasoning_tokens"],2)
        self.assertEqual(r["non_reasoning_output_tokens"],7)
        self.assertIsNone(r["runtime_transition_attribution"])

    def test_tools_summary_and_no_sensitive_export(self):
        items=[{"type":"reasoning","summary":[{"type":"summary_text","text":"hidden words"}],"encrypted_content":"opaque secret"},
            {"type":"function_call","name":"write","arguments":"private file content"}]
        r=d.response_record(sse(items),usage())
        self.assertEqual(r["category"],"tools_without_visible_text")
        self.assertEqual(r["tool_names"],{"write":1})
        self.assertEqual(r["tool_argument_chars_by_name"],{"write":20})
        self.assertEqual(r["reasoning_summary_chars"],12)
        self.assertNotIn("private",json.dumps(r));self.assertNotIn("opaque",json.dumps(r))
        self.assertNotIn("hidden words",json.dumps(r))

    def test_text_and_tools_category(self):
        items=[{"type":"message","content":[{"type":"output_text","text":"ok"}]},
               {"type":"function_call","name":"bash","arguments":"{}"}]
        self.assertEqual(d.response_record(sse(items),usage())["category"],"text_and_tools")

    def test_reasoning_only_category(self):
        self.assertEqual(d.response_record(sse([{"type":"reasoning","summary":[]}]),usage())["category"],"reasoning_only")

    def test_missing_reasoning_not_zero(self):
        u=usage();del u["usage"]["output_tokens_details"]
        r=d.response_record(sse(record=u),u)
        self.assertIsNone(r["reasoning_tokens"]);self.assertIsNone(r["non_reasoning_output_tokens"])

    def test_invalid_reasoning_range_or_bool(self):
        for invalid in (10,-1,True):
            u=usage();u["usage"]["output_tokens_details"]["reasoning_tokens"]=invalid
            self.assertIsNone(d.response_record(sse(record=u),u)["reasoning_tokens"])

    def test_earlier_error_blocks_category_even_complete_usage(self):
        r=d.response_record(sse(prior=[{"type":"error","error":{"message":"secret"}}]),usage())
        self.assertIsNone(r["category"]);self.assertIn("upstream_error_event",r["issues"])
        self.assertNotIn("secret",json.dumps(r))

    def test_missing_duplicate_and_truncated_terminal(self):
        for raw in (b"data: {}\n\n",sse()+sse(),sse()[:-1]):
            self.assertIsNone(d.response_record(raw,usage())["category"])

    def test_cancelled_usage_not_success(self):
        u=usage();u["error"]={"type":"cancelled"}
        self.assertIsNone(d.response_record(sse(record=u),u)["category"])

    def test_usage_mismatch_blocks_category(self):
        u=usage();u["usage"]["output_tokens"]=8
        self.assertIsNone(d.response_record(sse(),u)["category"])

    def test_bad_json_and_utf8_unknown(self):
        for raw in (b"data: {bad}\n\n",b"data: \xff\n\n"):
            self.assertEqual(d.response_record(raw,usage())["issues"],["malformed_sse"])

    def test_sse_crlf_comments_and_multiline(self):
        raw=b': comment\r\ndata: {"type":\r\ndata: "hello"}\r\n\r\n'
        self.assertEqual(d.parse_sse(raw),([{"type":"hello"}],None))

    def test_unsafe_tool_name_never_exported(self):
        r=d.response_record(sse([{"type":"function_call","name":"sk-"+"a"*40,"arguments":"{}"}]),usage())
        self.assertIsNone(r["category"]);self.assertNotIn("sk-",json.dumps(r))

    def test_unknown_output_item_not_silently_empty(self):
        r=d.response_record(sse([{"type":"computer_call"}]),usage())
        self.assertIsNone(r["category"])

    def test_missing_response_retains_unknown_totals(self):
        r=d.response_summary([d.response_record(sse(),usage())],2)
        self.assertIsNone(r["reasoning_tokens"]["sum"])
        self.assertEqual(r["reasoning_tokens"]["observed_sum"],2)

class CollectorTests(unittest.TestCase):
    def test_missing_response_does_not_shift_later_call_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);rid=d.PHASE+"-gpt-6-luna-01-chunked-strict-light-r1"
            folder=root/rid;folder.mkdir()
            result={"id":rid,"task":"01-chunked-strict","phase":d.PHASE,"agent":"light","model_calls":2,"wall_seconds":10}
            (folder/"result.json").write_text(json.dumps(result))
            for i,(start,end) in enumerate(((1,3),(4,6)),1):
                u=usage(start,end);u["run"]=rid
                (folder/f"usage-{i:03}.json").write_text(json.dumps(u))
                if i==2:(folder/f"response-{i:03}.txt").write_bytes(sse(record=u))
            cell=d.collect(root)["cells"][0]
            self.assertIn("missing_response",cell["issues"])
            self.assertIsNone(cell["calls"][0]["category"])
            self.assertEqual(cell["calls"][1]["category"],"visible_text_without_tools")
            self.assertIsNone(cell["responses"]["reasoning_tokens"]["sum"])

    def test_reported_tool_durations_not_fabricated_for_pi(self):
        raw=json.dumps({"type":"tool_execution_end","toolName":"bash","toolCallId":"x","isError":False,"result":{"content":"SECRET_RESULT"}}).encode()
        r=d.tool_runtime_summary(raw,"pi")
        self.assertEqual(r["reported_tool_completions"],1)
        self.assertIsNone(r["duration_sum_seconds"])
        self.assertNotIn("SECRET_RESULT",json.dumps(r))

    def test_light_reported_duration_errors_and_duplicate_ids(self):
        event={"params":{"event":{"type":"tool_call_completed","payload":{"callId":"x","toolName":"MultiEdit","isError":True,"durationMs":50,"result":"SECRET_RESULT"}}}}
        raw=json.dumps({"events":[event,event]}).encode()
        r=d.tool_runtime_summary(raw,"light")
        self.assertAlmostEqual(r["observed_duration_sum_seconds"],.1)
        self.assertEqual(r["reported_error_counts"],{"MultiEdit":2})
        self.assertIn("missing_or_duplicate_tool_identity",r["issues"])
        self.assertNotIn("SECRET_RESULT",json.dumps(r))

    def test_finalized_only_no_mutations_no_text_export(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            rid=d.PHASE+"-gpt-6-luna-01-chunked-strict-light-r1"
            folder=root/rid;folder.mkdir()
            result={"id":rid,"task":"01-chunked-strict","phase":d.PHASE,"agent":"light",
                "model_calls":1,"wall_seconds":7,"pass":True}
            u=usage();u["run"]=rid
            (folder/"result.json").write_text(json.dumps(result))
            (folder/"usage-001.json").write_text(json.dumps(u))
            (folder/"response-001.txt").write_bytes(sse([{ "type":"message", "content":[{"type":"output_text","text":"PRIVATE_FIXTURE_OUTPUT"}]}],record=u))
            active=root/(d.PHASE+"-gpt-6-luna-02-split-limit-light-r1");active.mkdir()
            (active/"response-001.txt").write_text("ACTIVE SECRET")
            paths=list(root.rglob("*"));before={p:p.read_bytes() for p in paths if p.is_file()}
            output=d.collect(root)
            self.assertEqual(len(output["cells"]),2)
            self.assertFalse(output["cells"][1]["finalized"])
            self.assertEqual(output["snapshot_issues"],[])
            self.assertNotIn("ACTIVE SECRET",json.dumps(output))
            self.assertNotIn("PRIVATE_FIXTURE_OUTPUT",json.dumps(output))
            self.assertEqual(before,{p:p.read_bytes() for p in before})

if __name__=="__main__":
    unittest.main()
