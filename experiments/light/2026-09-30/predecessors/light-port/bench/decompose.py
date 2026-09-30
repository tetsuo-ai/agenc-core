"""Count retained traces without emitting prompts, source, or response text."""
import argparse, collections, functools, hashlib, json, math, statistics
from pathlib import Path
from tokenizers import Tokenizer

p = argparse.ArgumentParser()
p.add_argument('--roots', nargs='+', type=Path, required=True)
p.add_argument('--tokenizer', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
p.add_argument('--phases', nargs='*', default=[])
p.add_argument('--retained', type=Path)
a = p.parse_args()
tokenizer = Tokenizer.from_file(str(a.tokenizer))

@functools.lru_cache(maxsize=4096)
def tokens(text):
    return len(tokenizer.encode(text, add_special_tokens=False).ids)

def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

def mean(rows, key):
    values = [r[key] for r in rows]
    return statistics.mean(values) if values and all(v is not None for v in values) else None

def cohort(r, root):
    if root.name == 'light-ultra' and r['phase'] in ('candidate-batch-subset', 'candidate-selected-new', 'candidate-selected-repeat2'):
        return 'main-selected-9e7'
    name = r['phase'] + ('-' + r['agent'] if r['phase'] == 'baseline' else '')
    if r['phase'] == 'baseline':
        return name
    return ('main/' if root.name == 'light-ultra' else 'port/') + name

rows = json.loads(a.retained.read_text())['runs'] if a.retained else []
if a.phases:
    rows = [r for r in rows if r['cohort'].split('/')[-1] not in a.phases]
for root in a.roots:
    paths = list((root / 'runs').glob('*/result.json'))
    paths += [p for p in (root / 'runs').glob('*/aborted.json') if not (p.parent / 'result.json').exists()]
    for path in sorted(paths):
        if a.phases and not any(path.parent.name.startswith(phase+'-deepseek-') for phase in a.phases):continue
        aborted = path.name == 'aborted.json'
        if aborted:
            parts = path.parent.name.split('-deepseek-', 1)
            suffix = parts[1].rsplit('-light-r', 1)
            model_task = suffix[0].split('-', 1)
            if model_task[0] == 'v4':
                model_task = suffix[0].split('-', 2)
                model, task = 'deepseek-v4-pro', model_task[2]
            else:
                model, task = 'deepseek-' + model_task[0], model_task[1]
            r = dict(id=path.parent.name, phase=parts[0], agent='light', model=model, task=task,
                     repeat=int(suffix[1]), pass_=False, wall_seconds=None, usage_complete=False,
                     input_tokens=0, output_tokens=0, cost_usd=0, cached_tokens=0, uncached_tokens=0)
            r['pass'] = False
        else:
            r = json.loads(path.read_text())
        if r.get('provider', 'deepseek') != 'deepseek' or r['agent'] == 'normal':
            continue
        calls = sorted([json.loads(f.read_text()) for f in path.parent.glob('usage-*.json')], key=lambda x: x['call'])
        observed_calls = list(calls)
        if aborted:
            known = {c['call'] for c in calls}
            calls += [dict(call=int(f.stem.split('-')[1]), seconds=0, usage_missing=True)
                      for f in path.parent.glob('wire-*.json') if int(f.stem.split('-')[1]) not in known]
            calls.sort(key=lambda c: c['call'])
            r['cost_usd'] = sum(c.get('cost_usd', 0) for c in observed_calls)
        if not calls:
            if root.name in ('light-port', 'light-ultra'):
                log = (path.parent / 'agent.log').read_text() if (path.parent / 'agent.log').exists() else ''
                socket_path = '/work/runs/'+r['id']+'/home/agenc/daemon.sock'
                socket_failure = len(socket_path.encode()) >= 108 and 'connect EINVAL' in log and r.get('exit_code') == 1
                row = dict(id=r['id'], origin=root.name, cohort=cohort(r,root), model=r['model'], task=r['task'],
                           repeat=r['repeat'], pass_=r['pass'], wall=r['wall_seconds'], P=None, largest_results=[], largest_messages=[],
                           agent_revision=r.get('agent_revision'), check_pass=r.get('check_pass'), timeout=r.get('timeout'),
                           stop_reason=r.get('stop_reason'), deferred_evidence=r.get('deferred_evidence'),
                           infrastructure='unix_socket_path_limit' if socket_failure else 'zero_provider_calls',
                           partial=False, prefix_versions=0, catalog_versions=0, cost=r.get('cost_usd',0),
                           cached=0, uncached=0, observed_usage_calls=0, observed_input=0, observed_output=0, observed_reasoning=0)
                for key in ['N','NP','schema_delta','H','O','reasoning','visible','tokens','request_seconds','ttft',
                            'generation','tools','guard','reasoning_replay_raw','tool_errors','proxy_arrival_to_upstream']:
                    row[key] = 0
                for key in ['overhead','runtime_overhead','tools_overhead']:
                    row[key] = r['wall_seconds']
                rows.append(row)
            continue
        ps, top, seen, reasoning_replay = [], [], set(), 0
        message_top, seen_messages = [], set()
        tool_signatures = set()
        system_signatures = set()
        for call in calls:
            body = json.loads((path.parent / f"wire-{call['call']:03}.json").read_text())['body']
            messages = body['messages']
            system = '\n\n'.join(m.get('content', '') for m in messages if m['role'] in ('system', 'developer'))
            schemas = compact(body.get('tools', []))
            ps.append(tokens(system) + tokens(schemas))
            system_signatures.add(hashlib.sha256(system.encode()).hexdigest())
            tool_signatures.add(hashlib.sha256(schemas.encode()).hexdigest())
            for position, m in enumerate(messages):
                if m.get('reasoning_content'):
                    reasoning_replay += tokens(m['reasoning_content'])
                if m['role'] not in ('system', 'developer'):
                    message_id = hashlib.sha256(compact(m).encode()).hexdigest()
                    if message_id not in seen_messages:
                        seen_messages.add(message_id)
                        # Diagnostic payload sizing, excluding protocol envelope.
                        parts = [m.get('content') or '', m.get('reasoning_content') or '']
                        arguments = m.get('tool_calls') or []
                        size = sum(tokens(part if isinstance(part, str) else compact(part)) for part in parts)
                        if arguments:
                            size += tokens(compact(arguments))
                        message_top.append(dict(tokens=size, role=m['role'], first_request=call['call'],
                                                message_position=position, replay_weight=len(calls)-call['call']+1,
                                                reasoning_tokens=tokens(m.get('reasoning_content') or '')))
                if m['role'] != 'tool':
                    continue
                identity = m.get('tool_call_id') or hashlib.sha256(compact(m).encode()).hexdigest()
                if identity in seen:
                    continue
                seen.add(identity)
                text = m.get('content', '')
                size = tokens(text if isinstance(text, str) else compact(text))
                top.append({'tokens': size, 'first_request': call['call'], 'message_position': position,
                            'replay_weight': len(calls) - call['call'] + 1})
        complete = r['usage_complete'] and all(not c.get('usage_missing') for c in calls)
        reason = [c.get('usage', {}).get('completion_tokens_details', {}).get('reasoning_tokens') for c in calls]
        reasoning = sum(reason) if all(x is not None for x in reason) else None
        request_seconds = sum(c['seconds'] for c in calls)
        timing = [c.get('timing', {}) for c in calls]
        raw_guard = sum(t['proxy_guard_seconds'] for t in timing) if all('proxy_guard_seconds' in t for t in timing) else None
        # Usage.seconds starts at usage.time. Exclude the small overlapping
        # serialization interval from the arrival-to-upstream guard span.
        guard = sum(c['time']-t['request_received_at'] for c,t in zip(calls,timing)) if raw_guard is not None else None
        timed = all(t.get('first_token_at') is not None for t in timing)
        ttft = sum(t['first_token_at'] - t['upstream_start_at'] for t in timing) if timed else None
        generation = sum(t['last_token_at'] - t['first_token_at'] for t in timing) if timed else None
        tool_seconds, tool_count, tool_errors = 0, 0, 0
        if r['agent'] != 'pi':
            completed_tools = {}
            for line in (path.parent / 'agent.log').read_text().splitlines():
                try:
                    log = json.loads(line)
                except ValueError:
                    continue
                for event in log.get('events', []):
                    event = event.get('params', {}).get('event', {})
                    if event.get('type') == 'tool_call_completed':
                        payload = event['payload']
                        completed_tools[payload['callId']] = payload
            # The CLI's final JSON can be absent on timeout; durable records still
            # contain completed tool receipts. Read only this run's isolated home.
            if not completed_tools:
                for rollout in (path.parent / 'home').rglob('rollout-*.jsonl'):
                    for line in rollout.read_text().splitlines():
                        try:
                            event = json.loads(line).get('payload', {}).get('msg', {})
                        except (ValueError, AttributeError):
                            continue
                        if event.get('type') == 'tool_call_completed':
                            payload = event['payload']
                            completed_tools[payload['callId']] = payload
            for payload in completed_tools.values():
                tool_count += 1
                tool_seconds += payload.get('durationMs', 0) / 1000
                tool_errors += bool(payload.get('isError'))
        # Old Pi JSON events have no tool start/end clock; do not infer an exact split.
        if not tool_count:
            tool_seconds = None
        output = r['output_tokens'] if complete else None
        row = dict(id=r['id'], origin=root.name, cohort=cohort(r, root), model=r['model'], task=r['task'], repeat=r['repeat'],
                   pass_=r['pass'], wall=r['wall_seconds'], N=len(calls), P=ps[0], NP=len(calls)*ps[0],
                   schema_delta=sum(ps)-len(calls)*ps[0],
                   H=r['input_tokens']-sum(ps) if complete else None,
                   O=output, reasoning=reasoning, visible=output-reasoning if output is not None and reasoning is not None else None,
                   tokens=r['input_tokens']+r['output_tokens'] if complete else None,
                   largest_results=sorted(top,key=lambda x:x['tokens'],reverse=True)[:3],
                   largest_messages=sorted(message_top,key=lambda x:x['tokens'],reverse=True)[:3],
                   reasoning_replay_raw=reasoning_replay, request_seconds=request_seconds,
                   ttft=ttft, generation=generation, tools=tool_seconds,
                   guard=guard, proxy_arrival_to_upstream=raw_guard,
                   runtime_overhead=r['wall_seconds']-request_seconds-tool_seconds-guard if r['wall_seconds'] is not None and tool_seconds is not None and guard is not None else None,
                   overhead=r['wall_seconds']-request_seconds-tool_seconds if r['wall_seconds'] is not None and tool_seconds is not None else None,
                   tools_overhead=r['wall_seconds']-request_seconds if r['wall_seconds'] is not None else None, tool_errors=tool_errors,
                   prefix_versions=len(system_signatures), catalog_versions=len(tool_signatures),
                   cost=r['cost_usd'], cached=r['cached_tokens'], uncached=r['uncached_tokens'])
        row['partial'] = not complete
        row['agent_revision'] = r.get('agent_revision')
        row['check_pass'] = r.get('check_pass')
        row['timeout'] = r.get('timeout')
        row['stop_reason'] = r.get('stop_reason')
        row['deferred_evidence'] = r.get('deferred_evidence')
        row['observed_usage_calls'] = len(observed_calls)
        row['observed_input'] = sum(c.get('usage', {}).get('prompt_tokens', 0) for c in observed_calls)
        row['observed_output'] = sum(c.get('usage', {}).get('completion_tokens', 0) for c in observed_calls)
        row['observed_reasoning'] = sum(c.get('usage', {}).get('completion_tokens_details', {}).get('reasoning_tokens', 0) for c in observed_calls)
        if aborted:
            row['request_seconds'] = None
        rows.append(row)

metrics = ['N', 'P', 'NP', 'schema_delta', 'H', 'O', 'reasoning', 'visible', 'tokens', 'wall', 'request_seconds',
           'ttft', 'generation', 'tools', 'overhead', 'tools_overhead', 'reasoning_replay_raw', 'guard', 'runtime_overhead', 'proxy_arrival_to_upstream']
groups = []
for key in sorted({(r['cohort'], r['model'], r['task']) for r in rows}):
    rs = [r for r in rows if (r['cohort'],r['model'],r['task']) == key]
    g = dict(zip(('cohort','model','task'),key), runs=len(rs), passed=sum(r['pass_'] for r in rs))
    g.update({m:mean(rs,m) for m in metrics})
    g['largest_results'] = sorted([dict(x,run=r['id']) for r in rs for x in r['largest_results']],key=lambda x:x['tokens'],reverse=True)[:3]
    g['largest_messages'] = sorted([dict(x,run=r['id']) for r in rs for x in r['largest_messages']],key=lambda x:x['tokens'],reverse=True)[:3]
    groups.append(g)
for g in groups:
    pi = next((x for x in groups if x['cohort']=='baseline-pi' and x['model']==g['model'] and x['task']==g['task']),None)
    g['delta_pi'] = {m:g[m]-pi[m] if pi and g[m] is not None and pi[m] is not None else None for m in metrics}

summary = []
for key in sorted({(r['cohort'],r['model']) for r in rows}):
    rs = [r for r in rows if (r['cohort'],r['model']) == key]
    wall=sorted(r['wall'] for r in rs if r['wall'] is not None)
    summary.append(dict(cohort=key[0],model=key[1],runs=len(rs),passed=sum(r['pass_'] for r in rs),
                        median=statistics.median(wall) if len(wall)==len(rs) else None,p90=wall[math.ceil(.9*len(wall))-1] if len(wall)==len(rs) else None,
                        **{m:mean(rs,m) for m in metrics if m != 'wall'},cost=sum(r['cost'] for r in rs)))
notes = ('P is exact raw system text + compact schema JSON tokens from the retained official V4 tokenizer, not a provider framing allocation. '
         'N*P + schema_delta + H + O equals billed totals: H is billed input residual after raw prefixes and includes message framing. '
         'O visible includes tool arguments; reasoning is the provider detail, already included in O. Largest results are exact raw content tokens at their first request (1-based). '
         'Historic Pi TTFT/generation and tool/overhead splits were not recorded; null is unavailable, never zero. '
         'Tool durations sum completed execution spans (CLI events or surviving durable receipts) and may overlap; overhead is a residual including startup/shutdown, proxy balance checks and persistence, not an exact nonoverlapping clock partition. '
         'New traces separate the pre-request proxy guard from residual runtime overhead; guard ends at usage.time so it does not overlap usage.seconds. The raw arrival-to-upstream proxy span is also retained. Old job screening overhead includes an unmeasured per-call balance guard absent in retained Pi. '
         'Recorded request spans start before local reservation/serialization, so they are not a pure upstream network clock. The full arrival-to-upstream interval includes that preparation; it overlaps request_seconds, while guard ends before it. Fair live balance checks happen before task wall time. '
         'Raw reasoning replay is diagnostic and not added to totals. Failed runs stay included. '
         'main/ and port/ distinguish independently named cohorts. An aborted cell has attempted N and exact captured prefixes; unknown billed totals and wall time stay null. '
         'Observed usage lower bounds are retained separately in the per-run JSON. '
         'Zero-provider-call startup failures have N/output/history=0 and unsent P=null; they remain explicit infrastructure records, not evidence of token efficiency. '
         'Largest messages additionally rank user/assistant/tool payloads including reasoning and serialized tool calls, excluding protocol envelopes; sizes are diagnostic raw tokens, with role and reasoning size retained.')
a.out.parent.mkdir(parents=True,exist_ok=True)
a.out.write_text(json.dumps(dict(notes=notes, tokenizer_sha256=hashlib.sha256(a.tokenizer.read_bytes()).hexdigest(),summary=summary,tasks=groups,runs=rows),indent=2)+'\n')
print(json.dumps({'runs':len(rows),'tasks':len(groups),'output':str(a.out)}))
