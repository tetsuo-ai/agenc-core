import json,re,subprocess
from pathlib import Path
root=Path('/private/tmp/light-ultra');s=(root/'core-converged/runtime/src/tools/light-presentation.ts').read_text()
summary=dict((m.group(1).strip('"'),m.group(2)) for m in re.finditer(r'^  ([\w."]+): "(.*)",$',s,re.M))
fields={m.group(1).strip('"'):json.loads(m.group(2)) for m in re.finditer(r'^  ([\w."]+): (\[.*\]),$',s,re.M)}
w=(root/'core-converged/runtime/src/prompts/light-workflow.ts').read_text()
workflow=[]
for line in w.splitlines():
 line=line.strip()
 if line.startswith('"') and line.endswith('",'):
  line=line.replace('" + UNTRUSTED_TOOL_RESULT_BOUNDARY + "', '===== AGENC UNTRUSTED TOOL RESULT DATA =====')
  workflow.append(json.loads(line[:-1]))
spec={'summary':summary,'fields':fields,'workflow':'\n\n'.join(workflow)}
code='SPEC='+repr(spec)+'''\nimport json,pathlib
root=pathlib.Path.home()/'claude-agenc-work/light-ultra'
p=next((root/'runs').glob('candidate-api-p-*-light-r1/wire-001.json'))
b=json.loads(p.read_text())['body']
for t in b['tools']:
 name=t['name'].replace('tool2__system_x2esearchTools','system.searchTools')
 t['description']=SPEC['summary'].get(name,t.get('description'))
 schema=t['parameters']
 if name in SPEC['fields']:
  schema['properties']={k:v for k,v in schema['properties'].items() if k in SPEC['fields'][name]}
  for k,v in list(schema['properties'].items()):
   choices=[x for x in v.get('anyOf',[]) if x.get('type')==('string' if k=='select' else 'number')]
   if choices:schema['properties'][k]=choices[0]
b['instructions']=b['instructions'].split('\\n\\n')[0]+'\\n\\n'+SPEC['workflow']
for m in b['input']:
 if m.get('role') in ['system','developer']:
  for c in m.get('content',[]):
   if c.get('type')=='input_text':c['text']=c['text'].split('\\n')[0]+'\\n\\nPermissions: bypassPermissions. Honor runtime refusals.'
print(json.dumps({'system':len(b['instructions'])+sum(len(json.dumps(m.get('content',''))) for m in b['input'] if m.get('role') in ['system','developer']), 'schemas':len(json.dumps(b['tools'])),'tools':{t['name']:len(json.dumps(t)) for t in b['tools']}}))
'''
output=subprocess.check_output(['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218','python3 -'],input=code.encode())
print(output.decode())
