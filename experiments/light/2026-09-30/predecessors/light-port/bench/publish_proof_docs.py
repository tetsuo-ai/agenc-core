"""Copy reviewable numeric proof into the branch, excluding raw model text."""
import json,shutil
from pathlib import Path
r=Path(__file__).resolve().parent.parent
target=r/'core/docs/eval';target.mkdir(parents=True,exist_ok=True)
report=(r/'REPORT.md').read_text()
report=report.replace('[STATUS.md](STATUS.md)','[per-task decomposition](light-independent-status.md)')
report=report.replace('`evidence/decomposition-fair.json`','[numeric per-run evidence](light-independent-data.json)')
report=report.replace('The old report is [REPORT.before-fair.md](REPORT.before-fair.md).','The earlier full report remains in the retained benchmark archive.')
report=report.replace('Launch shared balance was $29.26. ','')
report += '\nThe raw traces, control harness and detailed scan logs remain in the benchmark archive. This document and its linked numeric tables contain no captured prompt or response text.\n'
(target/'light-independent.md').write_text(report)
status=(r/'STATUS.md').read_text();begin=status.index('<!-- decomposition-start -->');end=status.index('<!-- decomposition-end -->',begin)+len('<!-- decomposition-end -->')
(target/'light-independent-status.md').write_text('# Independent Light measurement tables\n\nFrozen production source: `3c954ea5591c683aa9b14a0219345e11051b06dd`. The `port/candidate-eq` rows are the new equal-guard confirmation. Older observations remain separate. See [results and limitations](light-independent.md).\n\n'+status[begin:end]+'\n')
data=json.loads((r/'evidence/decomposition-fair.json').read_text())
encode=lambda value:json.dumps(value,ensure_ascii=False,separators=(',',':'))
sections=[]
for key,value in data.items():
    body='[\n'+',\n'.join(encode(row) for row in value)+'\n]' if isinstance(value,list) else encode(value)
    sections.append(encode(key)+':'+body)
(target/'light-independent-data.json').write_text('{\n'+',\n'.join(sections)+'\n}\n')
assert json.loads((target/'light-independent-data.json').read_text())==data
print(json.dumps({'published_documents':3,'production_source_changed':False}))
