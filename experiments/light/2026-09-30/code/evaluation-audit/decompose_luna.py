#!/usr/bin/env python3
"""Read finalized benchmark artifacts; emit scalar-only timing/output evidence.

No provider calls, credential/environment reads, imported benchmark code or writes.
Request-open time includes network/provider/local stream consumption, not pure
provider compute. Residual wall time is unattributed and interval containment in
CLI wall is unverified because no absolute CLI start/end stamps were recorded.
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

PHASE = "candidate-api-fixedconfig"
BASELINES = ("candidate-api-b", "candidate-api-p")
ID = re.compile(r"[A-Za-z0-9_.-]{1,220}")
SECRET = re.compile(r"sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|PRIVATE KEY")
TIME_KEYS = ("request_start_at", "headers_at", "first_token_at", "last_token_at", "stream_end_at")
STAGES = ("request_to_headers", "headers_to_first_delta", "first_to_last_delta", "last_delta_to_stream_end")

def number(value):
    return type(value) in (int, float) and math.isfinite(value)

def integer(value):
    return type(value) is int and value >= 0

def safe_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value) or SECRET.search(value):
        raise ValueError("invalid metadata identifier; content withheld")
    return value

def interval_union(intervals):
    """Returns union/sum/span/overlap; callers must account for missing intervals."""
    if any(not number(a) or not number(b) or b < a for a,b in intervals):
        raise ValueError("invalid interval")
    if not intervals:
        return {"sum": 0, "union": 0, "span": 0, "overlap": 0, "gaps": 0}
    ordered = sorted(intervals)
    begin, end = ordered[0]
    union = 0
    for a,b in ordered[1:]:
        if a > end:
            union += end-begin
            begin,end = a,b
        else:
            end = max(end,b)
    union += end-begin
    total = sum(b-a for a,b in intervals)
    span = max(b for _,b in intervals)-min(a for a,_ in intervals)
    return {"sum": total, "union": union, "span": span,
            "overlap": max(0,total-union), "gaps": max(0,span-union)}

def timing_record(record):
    timing = record.get("timing") or {}
    stamps = [timing.get(k) for k in TIME_KEYS]
    start,headers,first,last,end = stamps
    result = {"interval": None, "stage_seconds": None, "issues": []}
    if number(start) and number(end) and end >= start:
        result["interval"] = [start,end]
        seconds = record.get("seconds")
        if not number(seconds) or not math.isclose(seconds,end-start,abs_tol=1e-5,rel_tol=1e-8):
            result["issues"].append("recorded_seconds_mismatch")
    else:
        result["issues"].append("missing_or_invalid_request_interval")
    if all(number(x) for x in stamps) and all(a<=b for a,b in zip(stamps,stamps[1:])):
        result["stage_seconds"] = dict(zip(STAGES,[b-a for a,b in zip(stamps,stamps[1:])]))
    else:
        result["issues"].append("missing_or_unordered_stage_stamps")
    return result

def timing_summary(records, wall, expected_calls=None):
    expected_calls = len(records) if expected_calls is None else expected_calls
    checked=[timing_record(r) for r in records]
    known=[x["interval"] for x in checked if x["interval"] is not None]
    metrics=interval_union(known)
    complete=len(known)==expected_calls and len(records)==expected_calls and bool(records)
    stages=[x["stage_seconds"] for x in checked if x["stage_seconds"] is not None]
    issue_counts=Counter(i for x in checked for i in x["issues"])
    result={"calls":expected_calls,"observed_records":len(records),"known_request_intervals":len(known),
        "complete_request_intervals":complete,"known_request_interval_sum_seconds":metrics["sum"],
        "request_interval_sum_seconds":metrics["sum"] if complete else None,
        "request_interval_union_seconds":metrics["union"] if complete else None,
        "request_interval_overlap_seconds":metrics["overlap"] if complete else None,
        "first_start_to_last_end_seconds":metrics["span"] if complete else None,
        "between_request_gaps_seconds":metrics["gaps"] if complete else None,
        "stage_timing_known_calls":len(stages),
        "known_stage_sums_seconds":{k:sum(x[k] for x in stages) for k in STAGES},
        "stage_sums_seconds":{k:sum(x[k] for x in stages) for k in STAGES} if len(stages)==expected_calls and len(records)==expected_calls and records else None,
        "stage_sums_additive_to_union":complete and len(stages)==expected_calls and metrics["overlap"]<1e-6,
        "wall_minus_union_seconds":None,"wall_minus_request_span_seconds":None,
        "cli_interval_containment_verified":False,"issues":dict(issue_counts)}
    if complete and number(wall):
        if wall >= metrics["span"]-1e-6:
            result["wall_minus_union_seconds"]=wall-metrics["union"]
            result["wall_minus_request_span_seconds"]=wall-metrics["span"]
        else:
            result["issues"]["request_span_exceeds_cli_wall"]=1
    return result

def parse_sse(raw):
    """Parse Responses SSE frames, including multiline data. Never export data."""
    events=[]
    try:
        text=raw.decode("utf-8").replace("\r\n","\n").replace("\r","\n")
        if not text.endswith("\n\n"):
            return None,"unterminated_sse_frame"
        for frame in text.split("\n\n"):
            data="\n".join(line[5:].lstrip(" ") for line in frame.split("\n") if line.startswith("data:"))
            if not data or data=="[DONE]":
                continue
            event=json.loads(data)
            if not isinstance(event,dict):
                return None,"non_object_sse_event"
            events.append(event)
    except (UnicodeDecodeError,ValueError):
        return None,"malformed_sse"
    return events,None

def response_record(raw, record):
    result={"category":None,"tool_names":{},"tool_argument_chars_by_name":{},"output_item_types":{},
        "visible_text_chars":None,"tool_argument_chars":None,"reasoning_summary_chars":None,
        "reasoning_tokens":None,"non_reasoning_output_tokens":None,
        "runtime_transition_attribution":None,"issues":[]}
    events,error=parse_sse(raw)
    if error:
        result["issues"].append(error);return result
    if any(e.get("type") in ("error","response.failed","response.incomplete","response.cancelled")
           or e.get("error") or (isinstance(e.get("response"),dict) and e["response"].get("error")) for e in events):
        result["issues"].append("upstream_error_event")
    terminals=[e.get("response") for e in events if e.get("type")=="response.completed"]
    if len(terminals)!=1 or not isinstance(terminals[0],dict) or terminals[0].get("status")!="completed":
        result["issues"].append("invalid_completed_terminal");return result
    terminal=terminals[0]
    if terminal.get("usage")!=record.get("usage"):
        result["issues"].append("terminal_usage_mismatch")
    if record.get("usage_missing") is not False or record.get("error") is not None:
        result["issues"].append("incomplete_or_errored_usage")
    output=terminal.get("output")
    if not isinstance(output,list) or not all(isinstance(x,dict) for x in output):
        result["issues"].append("invalid_output_items");return result
    types=Counter();tools=Counter();argument_sizes=Counter();visible=args=summary=0
    try:
        for item in output:
            typ=safe_id(item.get("type"));types[typ]+=1
            if typ=="function_call":
                tools[safe_id(item.get("name"))]+=1
                if not isinstance(item.get("arguments"),str):
                    raise ValueError("invalid tool argument shape")
                args+=len(item["arguments"])
                argument_sizes[item["name"]]+=len(item["arguments"])
            elif typ=="message":
                content=item.get("content")
                if not isinstance(content,list):
                    raise ValueError("invalid message content")
                for c in content:
                    if c.get("type")=="output_text" and isinstance(c.get("text"),str):visible+=len(c["text"])
                    elif c.get("type")=="refusal" and isinstance(c.get("refusal"),str):visible+=len(c["refusal"])
                    else:raise ValueError("unsupported message content")
            elif typ=="reasoning":
                for c in item.get("summary",[]):
                    if c.get("type")=="summary_text" and isinstance(c.get("text"),str):summary+=len(c["text"])
                    else:raise ValueError("unsupported reasoning summary")
            else:
                raise ValueError("unsupported output item")
    except (ValueError,TypeError,AttributeError):
        result["issues"].append("unsupported_or_invalid_output_shape");return result
    # Only complete, error-free parsed evidence can supply a call category.
    if not result["issues"]:
        result["category"]=("text_and_tools" if visible and tools else "tools_without_visible_text" if tools
            else "visible_text_without_tools" if visible else "reasoning_only" if types.get("reasoning") else "empty")
        result.update(tool_names=dict(tools),tool_argument_chars_by_name=dict(argument_sizes),output_item_types=dict(types),
            visible_text_chars=visible,tool_argument_chars=args,reasoning_summary_chars=summary)
    usage=record.get("usage",{})
    out=usage.get("output_tokens")
    reasoning=usage.get("output_tokens_details",{}).get("reasoning_tokens")
    if integer(out) and integer(reasoning) and reasoning<=out:
        result["reasoning_tokens"]=reasoning
        result["non_reasoning_output_tokens"]=out-reasoning
    else:
        result["issues"].append("missing_or_invalid_reasoning_usage")
    return result

def response_summary(records, expected_calls=None):
    expected_calls = len(records) if expected_calls is None else expected_calls
    categories=Counter(x["category"] for x in records if x["category"] is not None)
    tools=Counter();types=Counter();argument_sizes=Counter()
    for x in records:
        tools.update(x["tool_names"]);types.update(x["output_item_types"]);argument_sizes.update(x["tool_argument_chars_by_name"])
    result={"calls":expected_calls,"observed_records":len(records),"known_categories":sum(categories.values()),"call_categories":dict(categories),
        "tool_names":dict(tools),"tool_argument_chars_by_name":dict(argument_sizes),"output_item_types":dict(types),
        "runtime_transition_attribution":"unavailable_from_output_SSE_alone",
        "issues":dict(Counter(i for x in records for i in x["issues"]))}
    for k in ("visible_text_chars","tool_argument_chars","reasoning_summary_chars","reasoning_tokens","non_reasoning_output_tokens"):
        values=[x[k] for x in records if x[k] is not None]
        result[k]={"known_calls":len(values),"observed_sum":sum(values),"sum":sum(values) if len(values)==expected_calls and len(records)==expected_calls else None}
    return result

def tool_runtime_summary(raw, agent):
    """Agent-reported tool durations are not interval unions or provider timing."""
    calls=[];non_json=0
    for line in raw.decode("utf-8").splitlines():
        try:entry=json.loads(line)
        except ValueError:
            non_json+=1;continue
        if not isinstance(entry,dict):continue
        if agent=="light":
            for notification in entry.get("events",[]):
                event=notification.get("params",{}).get("event",{})
                if event.get("type")!="tool_call_completed":continue
                calls.append(event.get("payload",{}))
        elif entry.get("type")=="tool_execution_end":
            calls.append(entry)
    names=Counter();errors=Counter();durations=[];known=[];issues=[]
    ids=set()
    for index,call in enumerate(calls,1):
        try:name=safe_id(call.get("toolName"))
        except ValueError:
            issues.append("invalid_tool_name");continue
        identity=call.get("callId",call.get("toolCallId"))
        if not isinstance(identity,str) or not identity or identity in ids:
            issues.append("missing_or_duplicate_tool_identity")
        ids.add(identity)
        names[name]+=1
        failed=call.get("isError")
        if type(failed) is not bool:issues.append("unknown_tool_outcome")
        elif failed:errors[name]+=1
        value=call.get("durationMs")
        if number(value) and value>=0:
            known.append(value/1000)
            durations.append({"ordinal":index,"tool":name,"is_error":failed,"reported_seconds":value/1000})
    return {"reported_tool_completions":len(calls),"tool_names":dict(names),
        "reported_error_counts":dict(errors),"known_duration_completions":len(known),
        "observed_duration_sum_seconds":sum(known),
        "duration_sum_seconds":sum(known) if len(known)==len(calls) and calls else None,
        "maximum_reported_duration_seconds":max(known) if known else None,
        "duration_records":durations,"non_json_log_lines":non_json,"issues":issues,
        "limitation":"Reported tool duration sums may overlap and lack absolute interval boundaries; never subtract from request union/residual as disjoint time."}

def collect(root, agents=("light","pi")):
    watched={};issues=[];cells=[]
    initial=sorted(p for p in root.iterdir() if p.is_dir() and any(p.name.startswith(x+"-gpt-6-luna-") for x in (PHASE,*BASELINES)))
    def read(p):
        raw=p.read_bytes();watched[p]=hashlib.sha256(raw).hexdigest();return raw
    for d in initial:
        match=re.fullmatch(r"(.+)-gpt-6-luna-(\d{2}-[a-z-]+)-(light|pi)-r1",d.name)
        if not match:continue
        phase,task,agent=match.groups()
        if agent not in agents:continue
        if (phase==PHASE)!=(agent=="light"):continue
        identity={"id":safe_id(d.name),"task":safe_id(task),"phase":safe_id(phase),"agent":agent}
        if not (d/"result.json").is_file():
            cells.append({**identity,"finalized":False,"issues":["missing_final_result"]});continue
        result=json.loads(read(d/"result.json"))
        if any(result.get(k)!=v for k,v in identity.items()):raise ValueError("identity mismatch")
        n=result["model_calls"]
        expected=[f"usage-{i:03}.json" for i in range(1,n+1)]
        usage_files=sorted(d.glob("usage-*.json"))
        cell_issues=[]
        if [p.name for p in usage_files]!=expected:cell_issues.append("usage_inventory_mismatch")
        records=[];responses=[]
        for p in usage_files:
            u=json.loads(read(p));records.append(u)
            if u.get("run")!=identity["id"]:cell_issues.append("usage_identity_mismatch")
            response=d/p.name.replace("usage-","response-").replace(".json",".txt")
            try:responses.append(response_record(read(response),u))
            except OSError:
                cell_issues.append("missing_response")
                # Preserve this call's ordinal instead of pairing a later
                # response with the wrong request/timing record.
                responses.append(response_record(b"",u))
        if len(responses)!=n:cell_issues.append("response_inventory_mismatch")
        call_scalars=[];previous_end=None
        for i,(u,response) in enumerate(zip(records,responses),1):
            timing=timing_record(u)
            interval=timing["interval"]
            gap=max(0,interval[0]-previous_end) if interval is not None and previous_end is not None else None
            if interval is not None:previous_end=max(interval[1],previous_end or interval[1])
            call_scalars.append({"call":i,"request_open_seconds":interval[1]-interval[0] if interval else None,
                "gap_before_seconds":gap,"stage_seconds":timing["stage_seconds"],
                "category":response["category"],"tool_names":response["tool_names"],
                "reasoning_tokens":response["reasoning_tokens"],"non_reasoning_output_tokens":response["non_reasoning_output_tokens"],
                "tool_argument_chars":response["tool_argument_chars"],"visible_text_chars":response["visible_text_chars"]})
        try:tool_runtime=tool_runtime_summary(read(d/"agent.log"),agent)
        except OSError:tool_runtime={"issues":["missing_agent_log"],"duration_sum_seconds":None}
        cells.append({**identity,"finalized":True,"source_result_sha256":watched[d/"result.json"],
            **{k:result.get(k) for k in ("pass","coding_pass","usage_complete","wall_seconds","model_calls","tool_calls","input_tokens","cached_tokens","uncached_tokens","output_tokens","cost_usd")},
            "task12_planning_comparable":not task.startswith("12-"),
            "timing":timing_summary(records,result.get("wall_seconds"),n),
            "responses":response_summary(responses,n),"calls":call_scalars,"tool_runtime":tool_runtime,"issues":cell_issues})
    if sorted(p for p in root.iterdir() if p.is_dir() and any(p.name.startswith(x+"-gpt-6-luna-") for x in (PHASE,*BASELINES)))!=initial:
        issues.append("directory_inventory_changed")
    for p,h in watched.items():
        if hashlib.sha256(p.read_bytes()).hexdigest()!=h:issues.append("artifact_changed_during_snapshot")
    return {"schema_version":1,"collected_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "selection":{"candidate_phase":PHASE,"baseline_phases":BASELINES,"repeat":1,"agents":list(agents)},
        "cells":cells,"snapshot_issues":issues,
        "artifact_sha256":{str(p.relative_to(root)):h for p,h in watched.items()},
        "limitations":["Historical settings/harness and task12 contracts differ; development N=1 cannot establish causality.",
            "Observed request intervals include transport/provider and local stream consumption; not pure provider compute.",
            "CLI wall uses monotonic timing; request stages use wall-clock stamps, so clock changes may confound decomposition.",
            "No absolute CLI boundary timestamps: wall-minus-union is conditional/unattributed, not measured tool/runtime time.",
            "first_token_at/last_token_at observe any nonempty .delta, including tool arguments or reasoning; not just visible tokens.",
            "Tool names identify model-selected outputs, not tool duration or reason for the next runtime request.",
            "Character totals measure serialized output strings, not token allocation or semantic utility.",
            "Missing/error evidence stays unknown; known partial sums are not full totals."]}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,default=Path("/home/paul/claude-agenc-work/light-ultra/runs"))
    parser.add_argument("--compact",action="store_true",help="Emit the artifact manifest digest instead of its full hash map")
    parser.add_argument("--agent",choices=("light","pi"),help="Emit just one explicitly selected arm")
    args=parser.parse_args()
    result=collect(args.root,(args.agent,) if args.agent else ("light","pi"))
    if args.compact:
        hashes=result.pop("artifact_sha256")
        result["artifact_count"]=len(hashes)
        result["artifact_manifest_sha256"]=hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    encoded=json.dumps(result,indent=2,allow_nan=False)
    if SECRET.search(encoded):raise ValueError("credential-pattern rejection")
    print(encoded)

if __name__=="__main__":
    main()
