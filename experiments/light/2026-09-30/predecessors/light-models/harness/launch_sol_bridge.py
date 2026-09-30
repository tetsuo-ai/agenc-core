import os,sys
from pathlib import Path
os.environ['SOL_PROXY_BEARER']=Path('/Users/tetsuoarena/claude-agenc/chatgpt-oauth/secret').read_text().strip()
os.execv(sys.executable,[sys.executable,'/private/tmp/light-models/harness/sol_bridge.py','relay','--port','8817','--max-requests','600','--ssh-host','paul@192.168.1.218','--ssh-key','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','--remote-script','/home/paul/claude-agenc-work/light-models/harness/sol_bridge.py'])
