#!/usr/bin/env python3
"""Linux-only deterministic checker validation, with no LLM requests.

Usage: python3 self_validate.py SOURCE_ROOT VALIDATION_ROOT
SOURCE_ROOT contains more-itertools and itsdangerous git clones at pinned HEADs.
VALIDATION_ROOT must not exist. All created files stay under that directory.
"""
import json
from pathlib import Path
import subprocess
import sys
from task_support import HERE, TASKS
assert sys.platform.startswith('linux'), 'Validation runs only on Linux'
sources=Path(sys.argv[1]).resolve(); destination=Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=False)
results=[]
for task in TASKS.values():
    task_id=task['id']; repo=destination/task_id
    source=sources/('more-itertools' if task['source_key']=='more' else 'itsdangerous')
    subprocess.run(['git','clone','--quiet',str(source),str(repo)],check=True)
    subprocess.run([sys.executable,str(HERE/task['setup_script']),str(repo)],check=True,capture_output=True,text=True)
    before=subprocess.run([sys.executable,str(HERE/task['check_script']),str(repo)],capture_output=True,text=True)
    subprocess.run([sys.executable,str(HERE/'reference.py'),task_id,str(repo)],check=True,capture_output=True,text=True)
    after=subprocess.run([sys.executable,str(HERE/task['check_script']),str(repo)],capture_output=True,text=True)
    # Test tampering must invalidate an otherwise correct solution.
    tracked=subprocess.check_output(['git','-C',str(repo),'ls-files','tests'],text=True).splitlines()[0]
    testfile=repo/tracked; original=testfile.read_bytes(); testfile.write_bytes(original+b'\n# tampered\n')
    tampered=subprocess.run([sys.executable,str(HERE/task['check_script']),str(repo)],capture_output=True,text=True)
    testfile.write_bytes(original)
    result={'task':task_id,'unsolved_rejected':before.returncode!=0,'reference_accepted':after.returncode==0,'tamper_rejected':tampered.returncode!=0}
    if after.returncode:
        result['reference_error']=after.stderr
    results.append(result)
    print(json.dumps(result),flush=True)
(destination/'results.json').write_text(json.dumps(results,indent=2)+'\n')
assert all(r['unsolved_rejected'] and r['reference_accepted'] and r['tamper_rejected'] for r in results), 'checker self-validation failed'
