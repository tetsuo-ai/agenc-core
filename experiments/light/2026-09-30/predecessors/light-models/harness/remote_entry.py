import os,sys,json
row=json.loads(sys.stdin.readline())
if row.get('key'):os.environ['MINIMAX_API_KEY']=row.pop('key')
os.execv(sys.executable,[sys.executable,'/work/harness/runner-v2.py',*row['args']])
