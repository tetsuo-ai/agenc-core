"""One explicit real probe case, root-owned Docker boundary; no retries or providers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

BASE = Path('/home/paul/claude-agenc-work/light-ultra')
IMAGE = 'sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271'
CASES = ('normal', 'owner-exit-before-readiness', 'authenticated-identity-refusal')

def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

parser = argparse.ArgumentParser()
parser.add_argument('case', choices=CASES)
parser.add_argument('selection_sha256')
args = parser.parse_args()
assert re.fullmatch('[0-9a-f]{64}', args.selection_sha256)
stage = BASE/'analysis/real-parent-probes-v2'
selection = stage/'selection.json'
assert digest(selection) == args.selection_sha256
# Refuse any concurrent container rather than disturbing another job/timing cell.
assert subprocess.check_output(['docker','ps','-q'], text=True).strip() == ''
parent = BASE/'analysis/real-parent-probes-v2-results'
parent.mkdir(exist_ok=True, mode=0o700)
result = parent/args.case
result.mkdir(mode=0o700)  # Never reuse, overwrite or repeat a completed case.
scratch = result/'tmp'
scratch.mkdir(mode=0o700)
identity = uuid.uuid4().hex
name = 'light-canonical-'+identity
cidfile = result/'container-id'
command = ['docker','run','--rm','--name',name,'--cidfile',str(cidfile),
    '--label','light.probe.launch='+identity,'--network','none','--cpus','2',
    '--memory','4g','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--user','1000:1000',
    '-v',str(BASE/'core-converge-coldcli-v2')+':/work/core-converge-coldcli-v2:ro',
    '-v',str(BASE/'analysis/real-parent-bridge-build-v1')+':/work/bridge-build:ro',
    '-v',str(stage)+':/work/probes:ro','-v',str(result)+':/work/results',
    '-v',str(scratch)+':/tmp',IMAGE,'env','-i','PATH=/usr/local/bin:/usr/bin:/bin',
    'LANG=C','LC_ALL=C','HOME=/tmp/parent','/usr/local/bin/node',
    '/work/probes/real-parent-canonical-probe-v2/probe.mjs',
    '/work/probes/selection.json',args.selection_sha256,args.case,'/work/results/probe']
save(result/'launch.json', {'case':args.case,'command':command,'image':IMAGE,
    'selection_sha256':args.selection_sha256,'launcher_sha256':digest(Path(__file__)),
    'outer_timeout_seconds':90,'logs_and_fixture_retained_under':str(scratch)})
started = time.monotonic()
process = None
timed_out = False
containment = []
stdout, stderr = '', ''
outer_errors = []
remaining = None

def docker(args):
    try:
        checked = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=10)
        return {'status':checked.returncode,'stdout':checked.stdout}
    except Exception as error:
        outer_errors.append({'operation':args[0],'error_type':type(error).__name__})
        return {'status':None,'stdout':''}

def owned_ids(running_only=False):
    query = docker(['ps','-q' if running_only else '-aq','--no-trunc',
        '--filter','label=light.probe.launch='+identity,'--filter','name=^/'+name+'$'])
    if query['status'] != 0:
        return None
    ids = query['stdout'].split()
    if any(not re.fullmatch('[0-9a-f]{64}', item) for item in ids) or len(ids)>1:
        outer_errors.append({'operation':'owned_query','error_type':'InvalidIdentitySet'})
        return None
    return ids

def contain_owned():
    # Prefer exact unique label/name even when creation failed before cidfile.
    ids = owned_ids()
    if ids is None:
        try:
            saved = cidfile.read_text().strip()
            ids = [saved] if re.fullmatch('[0-9a-f]{64}', saved) else []
        except Exception as error:
            ids = []
            outer_errors.append({'operation':'read_owned_cid','error_type':type(error).__name__})
    for cid in ids:
        inspected = docker(['inspect',cid])
        if inspected['status'] != 0:
            containment.append({'action':'inspect_exact_container','status':inspected['status']})
            continue
        try:
            item = json.loads(inspected['stdout'])[0]
            valid = (item['Id']==cid and item['Name']=='/'+name and
                item['Config']['Labels'].get('light.probe.launch')==identity)
            running = item['State']['Running'] is True
        except Exception as error:
            valid, running = False, False
            outer_errors.append({'operation':'parse_owned_inspect','error_type':type(error).__name__})
        if not valid:
            containment.append({'action':'refuse_unverified_identity'})
        elif running:
            killed = docker(['kill',cid])
            containment.append({'action':'kill_exact_container','status':killed['status']})

try:
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stdout, stderr = process.communicate(timeout=90)
except subprocess.TimeoutExpired:
    timed_out = True
except BaseException as error:
    outer_errors.append({'operation':'docker_client','error_type':type(error).__name__})
finally:
    # Control-plane errors are uncertainty, never permission to claim teardown.
    # Every cleanup command is bounded; a failed command cannot skip the record.
    try:
        current = owned_ids(running_only=True)
        if timed_out or outer_errors or current is None or current:
            contain_owned()
    except Exception as error:
        outer_errors.append({'operation':'outer_containment','error_type':type(error).__name__})
    finally:
        # Client reaping cannot be skipped by inspect/kill/control-plane errors.
        if process is not None:
            try:
                if process.poll() is None:
                    stdout, stderr = process.communicate(timeout=15)
            except Exception as error:
                outer_errors.append({'operation':'join_docker_client','error_type':type(error).__name__})
                try:
                    process.kill()
                    containment.append({'action':'kill_owned_docker_client'})
                except Exception as error:
                    outer_errors.append({'operation':'kill_docker_client','error_type':type(error).__name__})
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except Exception as error:
                    outer_errors.append({'operation':'reap_docker_client','error_type':type(error).__name__})
    try:
        current = owned_ids(running_only=True)
        # Creation can lag the first query while the CLI is being terminated.
        # One final bounded, verified containment pass handles that exact launch.
        if current:
            contain_owned()
            current = owned_ids(running_only=True)
        remaining = None if current is None else bool(current)
    except Exception as error:
        outer_errors.append({'operation':'outer_cleanup','error_type':type(error).__name__})
        remaining = None
record = {'case':args.case,'returncode':process.returncode if process else None,'timed_out':timed_out,
    'wall_seconds':time.monotonic()-started,'stdout':stdout,'stderr':stderr,
    'containment':containment,'outer_errors':outer_errors,'owned_container_still_running':remaining}
save(result/'outer-result.json',record)
print(json.dumps(record),flush=True)
if process is None or process.returncode != 0 or timed_out or remaining is not False or outer_errors:
    raise SystemExit(2)
