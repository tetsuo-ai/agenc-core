from pathlib import Path
import json,hashlib
R=Path('/private/tmp/light-models')
p=R/'harness/sol_bridge.py'
s=p.read_text().replace('gpt-6-luna','gpt-6-sol').replace('LUNA_PROXY','SOL_PROXY').replace('luna_bridge','sol_bridge').replace('Luna bridge','Sol bridge')
s=s.replace('requests = 0',"admissions = Path('/private/tmp/light-models/evidence/sol-relay-admissions.jsonl')\n    requests = len(admissions.read_text().splitlines()) if admissions.exists() else 0")
s=s.replace('import uuid','import uuid\nimport time\nfrom pathlib import Path')
s=s.replace('requests += 1',"requests += 1\n                    with admissions.open('a') as log:\n                        log.write(json.dumps({'ordinal':requests,'id':frame.get('id'),'time':time.time()})+'\\n');log.flush();os.fsync(log.fileno())")
p.write_text(s)
b=Path('/private/tmp/router-bench-2/harness/grok_native.mjs').read_text()
prefix=b[:b.rindex('// harness/grok_native.mts')]
(R/'harness/grok_credentials.mjs').write_text(prefix+'\nexport { resolveHomeContext, refreshXaiOauthCredentialsIfNeeded };\n')
(R/'STATUS.md').write_text('''# Light models benchmark\n\nPreparation in progress. No generation requests yet. Read main and port status, frozen packaged Luna runner, Luna transport documentation, and router-bench-2 credential routes. Source snapshots retained in evidence/.\n\nSelected candidates: main 11e51dcc132dac8f413b59cc745135592f90dfed; port 3c954ea5591c683aa9b14a0219345e11051b06dd. Pi 0.73.1. Brief df0f47246 is unselected by its owner job. Own PC copies only; no AgenC source changes.\n\nSettings: 12 frozen tasks/graders, 300-second task deadlines, 8192 output ceiling, maximum 45 calls per task as source harness. Grok and Sol low reasoning. MiniMax adaptive default thinking, standard service tier. One request and one task at a time per provider. Repeat one before repeat two, maximum two repeats. Grok 800 requests; Sol 600 with durable admission; MiniMax $6 including unresolved reservations. No DeepSeek requests.\n\nSol generation is gated on completion of the main Luna matrix and absence of active Luna runner. Initial inventory observed main Luna runner PID217957 and relay PID292400; other job processes preserved. PC copies/preparation overlap that main Luna work and port final confirmation. Per-run host overlap snapshots will be retained.\n''')
