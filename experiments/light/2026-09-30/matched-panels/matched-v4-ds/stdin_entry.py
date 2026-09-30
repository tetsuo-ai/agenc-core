import os, runpy, sys
from pathlib import Path
if sys.platform != 'linux': raise SystemExit('Linux required')
credential=sys.stdin.readline().rstrip('\r\n')
if not credential: raise SystemExit('Missing API credential')
os.environ['DEEPSEEK_API_KEY']=credential
credential=''
runpy.run_path(str(Path(__file__).with_name('runner.py')),run_name='__main__')
