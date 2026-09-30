"""Evidence checks over provider messages, independent of the coding grader."""
import json,re

def nested_json(text):
    if isinstance(text,dict):
        yield text
        for v in text.values():yield from nested_json(v)
    elif isinstance(text,list):
        for v in text:yield from nested_json(v)
    elif isinstance(text,str):
        decoder=json.JSONDecoder()
        for m in re.finditer(r'[{\[]',text):
            try:value,_=decoder.raw_decode(text[m.start():])
            except ValueError:continue
            if isinstance(value,(dict,list)):yield from nested_json(value)

def name(value):
    value=re.sub(r'^tool2__','',value)
    value=re.sub(r'_x([0-9a-fA-F]{2})',lambda m:chr(int(m.group(1),16)),value)
    return re.sub('[^a-z0-9]','',value.lower())

def planning_evidence(directory,agent):
    if agent=='pi':return {'required':False,'reason':'Pi has no builtin planning tool'}
    calls={};loaded=False;planned=False;schema=False;initial=None
    for path in sorted(directory.glob('wire-*.json')):
        body=json.loads(path.read_text())['body']
        names=[name(t['function']['name']) for t in body.get('tools',[])]
        if initial is None:initial=names
        schema|='todowrite' in names
        for m in body['messages']:
            for t in m.get('tool_calls',[]):calls[t['id']]=name(t['function']['name'])
            if m['role']!='tool':continue
            called=calls.get(m.get('tool_call_id'))
            content=m.get('content','')
            if called=='systemsearchtools':
                loaded|=any('TodoWrite' in d.get('loaded',[]) for d in nested_json(content))
            if called=='todowrite':
                planned|='Todos have been modified successfully' in str(content)
    discovery=loaded and schema and 'todowrite' not in (initial or [])
    return {'required':True,'plan_call_success':planned,'discovery_success':discovery,'pass':planned and (agent!='light' or discovery)}
