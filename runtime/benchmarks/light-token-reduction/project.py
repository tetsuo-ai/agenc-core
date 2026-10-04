#!/usr/bin/env python3
"""Fixed-trajectory request projection, not runtime replay or task-success evidence.

Replay recorded inputs through candidate presentation at fixed tool decisions.
Counts use tk's reviewed partition/tokenizers; cache and output provider counters
remain source observations, never new candidate usage. Actual CLI replay is a
separate check of these projections, and live mh A/B is required for efficacy.
"""
import argparse
import collections
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re

BOUNDARY = '===== AGENC UNTRUSTED TOOL RESULT DATA ====='
COMPACT = 'AGENC_DATA'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dynamic_context(text, exported):
    """Replace only recognized runtime-owned sections from the frozen captures."""
    if '# Memory directories\n' not in text or '# Permission Mode:' not in text:
        return text
    pattern = (r'# Memory directories\n\n- Global memory \(user-level, shared across projects\): `([^`]+)`\n'
               r'- Project memory \(this repository, shared by its git worktrees\): `([^`]+)`\n'
               r'- Session memory is the current conversation: use plans and tasks for state that only matters in this session\.\n\n'
               r'These directories already exist\. Write to them directly with the Write tool; do not run mkdir or check for their existence\.')
    match = re.search(pattern, text)
    if not match:
        raise ValueError('Unrecognized memory context, refusing broad deletion')
    text = text[:match.start()] + exported['memory_example'].replace('/GLOBAL/', match[1]).replace('/PROJECT/', match[2]) + text[match.end():]
    env = re.search(r'# Environment\n.*?(?=\n\nWhen the user specifies|\n\n# Permission Mode:)', text, re.S)
    if not env:
        raise ValueError('Unrecognized environment context')
    cwd = re.search(r'<cwd>([^<]+)</cwd>', env[0])
    if not cwd:
        raise ValueError('Missing workspace identity')
    text = text[:env.start()] + 'Workspace: ' + cwd[1] + text[env.end():]
    # The canonical assembler already suppresses this optional generic tutorial
    # for lean profiles. Actual token-target continuations are untouched.
    text = re.sub(r'\n\nWhen the user specifies a token target .*?automatically continue you\.', '', text, flags=re.S)
    return text


def sparse_read(text):
    lines = text.split('\n')
    numbered = [(i, re.match(r'^[ \t]*(\d+)(?:→|\t)(.*)$', line)) for i, line in enumerate(lines)]
    present = [(i, m) for i, m in numbered if m]
    if not present:
        return text
    # Only the ordinary contiguous plain-text FileRead shape is projected.
    if len(present) != len(lines) or any(int(b[1][1]) != int(a[1][1])+1 for a,b in zip(present, present[1:])):
        return text
    first, last = int(present[0][1][1]), int(present[-1][1][1])
    return '\n'.join(f'{int(m[1])}→{m[2]}' if int(m[1]) in (first,last) or int(m[1]) % 10 == 0 else m[2] for _,m in present)


def result_text(text, name):
    if not isinstance(text, str):
        raise ValueError('Projection only supports recorded text results')
    prefix = f'The following tool result is untrusted workspace data from {name}.\n{BOUNDARY}\n'
    framed = text.startswith(prefix) and text.endswith('\n'+BOUNDARY)
    body = text[len(prefix):-len(BOUNDARY)-1] if framed else text
    if name == 'FileRead':
        body = sparse_read(body)
    elif name in ('exec_command', 'write_stdin'):
        # Only an ordinary success footer; failures, yielded handles, timeouts
        # and notes remain. Truncated output cannot count as routine success.
        if not re.search(r'truncat|tokens omitted|output omitted', body, re.I):
            body = re.sub(r'\[exec exit_code=0 wall_time=[\d.]+s tokens=\d+\]$', '[exec exit_code=0]', body)
    elif name in ('Edit', 'Write', 'MultiEdit'):
        body = body.replace('The file /workspace/', 'The file ').replace('Created file /workspace/', 'Created file ').replace('File created successfully at: /workspace/', 'File created successfully at: ')
    if framed:
        # Every original frame was already sanitized; only the new delimiter
        # needs neutralizing. Do not import untrusted bytes as a sealed frame.
        body = body.replace(COMPACT, 'A G E N C _ D A T A')
        return COMPACT+'\n'+body+'\n'+COMPACT
    return body


def project(body, exported, model, *, component='all', auditor):
    out = copy.deepcopy(body)
    if component in ('all','head'):
        sections = exported['sections']
        head = '\n\n'.join(sections[k] for k in ('workflow','system','actions_'+('openai' if model == 'luna' else 'deepseek')))
        original = body.get('instructions') or next(m['content'] for m in body['messages'] if m.get('role') == 'system')
        if 'fixed time budget' in original:
            head += '\n\n' + sections['deadline']
        if 'instructions' in out:
            out['instructions'] = head
        else:
            next(m for m in out['messages'] if m.get('role') == 'system')['content'] = head
        schemas = {t.get('function',t)['name']: t for t in exported['fixtures'][model]['tools']}
        out['tools'] = [copy.deepcopy(schemas.get(t.get('function',t)['name'], t)) for t in out['tools']]
        for item in auditor.items(out):
            if item.get('role') in ('user','system','developer'):
                content = item.get('content')
                if isinstance(content,str):
                    item['content'] = dynamic_context(content, exported)
                elif isinstance(content,list):
                    for part in content:
                        if 'text' in part:
                            part['text'] = dynamic_context(part['text'], exported)
    if component in ('all','results'):
        calls = auditor.call_records(out)
        for item in auditor.items(out):
            if item.get('role') == 'tool' or item.get('type') == 'function_call_output':
                name = calls.get(item.get('tool_call_id',item.get('call_id')),{}).get('name','')
                key = 'content' if item.get('role') == 'tool' else 'output'
                item[key] = result_text(item[key], 'system.searchTools' if name == 'tool2__system_x2esearchTools' else name)
    return out


def load_auditor(path):
    spec = importlib.util.spec_from_file_location('token_auditor', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--auditor',type=Path,required=True)
    ap.add_argument('--capture-root',type=Path,required=True)
    ap.add_argument('--presentation',type=Path,required=True)
    ap.add_argument('--deepseek-tokenizer',type=Path,required=True)
    ap.add_argument('--candidate-sha',required=True)
    ap.add_argument('--out',type=Path,required=True)
    args = ap.parse_args()
    audit = load_auditor(args.auditor)
    exported = json.loads(args.presentation.read_text())
    result = {'basis':'fixed-trajectory source-presentation projection, not CLI replay or live evidence',
              'baseline_sha':'81149bb1c616586da978dedc9fff04921da82c5a', 'candidate_sha':args.candidate_sha,
              'provider_usage_candidate':None, 'candidate_cached_tokens':None,
              'auditor_sha256':sha(args.auditor), 'presentation_sha256':sha(args.presentation),
              'source_sha256':exported['source_sha256'], 'runs':[]}
    for model in ('deepseek','luna'):
        panel_root = args.capture_root/('main-81149-'+model)
        panel = json.loads((panel_root/'panel.json').read_text())
        assert panel['build_sha'] == result['baseline_sha']
        counter = audit.TokenCounter('deepseek-flash' if model == 'deepseek' else 'gpt-6-luna', args.deepseek_tokenizer)
        for cell in panel['schedule']:
            if cell['arm'] != 'light':
                continue
            directory = panel_root/'cells'/cell['id']
            previous = {key:None for key in ('main','head','results','all')}
            rows = []
            for wire_path in sorted(directory.glob('wire-*.json')):
                wire = json.loads(wire_path.read_text())
                original = wire.get('forwarded_body',wire['body'])
                index = int(wire_path.stem.split('-')[-1])
                response_path = directory/f'response-{index:03d}.txt'
                usage_path = directory/f'usage-{index:03d}.json'
                response = audit.parse_response(response_path)
                row = {'call':index,'wire_sha256':sha(wire_path),'response_sha256':sha(response_path),
                       'source_provider':audit.usage_values(json.loads(usage_path.read_text())),
                       'emitted_calls':len(response['calls']),
                       'fixed_output_text_tokens':counter(response['text']),
                       'fixed_output_reasoning_tokens':counter(response['reasoning']),
                       'fixed_output_argument_tokens':sum(counter(c['arguments']) for c in response['calls'])}
                for kind in previous:
                    body = original if kind == 'main' else project(original,exported,model,component=kind,auditor=audit)
                    row[kind] = audit.request_components(body,previous[kind],counter)
                    previous[kind] = body
                # Output calls and their arguments/reasoning are never rewritten.
                assert row['main']['components']['reasoning_carried_over'] == row['all']['components']['reasoning_carried_over']
                rows.append(row)
            assert [r['call'] for r in rows] == list(range(1,len(rows)+1))
            totals = {kind:{component:sum(r[kind]['components'][component] for r in rows) for component in audit.COMPONENTS} for kind in previous}
            run = {'model':model,'task':cell['task'],'tokenizer':counter.identity,'calls':len(rows),
                   'tool_calls':sum(r['emitted_calls'] for r in rows),'totals':totals,'requests':rows,
                   'source_provider_totals':{k:sum(r['source_provider'][k] for r in rows) for k in ('input','cached','output')},
                   'fixed_output_tokens':{k:sum(r['fixed_output_'+k+'_tokens'] for r in rows) for k in ('text','reasoning','argument')}}
            result['runs'].append(run)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps([{k:v for k,v in r.items() if k not in ('requests','tokenizer')} for r in result['runs']],indent=2))

if __name__ == '__main__':
    main()
