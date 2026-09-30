from pathlib import Path
for folder in ['converge','luna-api']:
 p=Path('bench')/folder/'runner.py';s=p.read_text()
 s=s.replace('import argparse, concurrent.futures,','import shutil\nimport argparse, concurrent.futures,')
 s=s.replace("ap.add_argument('--spend-cap-usd',type=float,default=10)","ap.add_argument('--spend-cap-usd',type=float,default=0,help='0: owner-authorized credit exhaustion, durable accounting retained')")
 s=s.replace("ap.add_argument('--balance-floor-usd',type=float,default=10)","ap.add_argument('--balance-floor-usd',type=float,default=1)")
 start=s.index('    if not (0<args.spend_cap_usd<=');end=s.index('    if not re.fullmatch',start)
 s=s[:start]+"    if args.spend_cap_usd<0 or args.balance_floor_usd<1:\n        raise ValueError('Nonnegative optional spend cap and balance floor >=1 required')\n"+s[end:]
 s=s.replace('SPEND_CAP=args.spend_cap_usd;','SPEND_CAP=args.spend_cap_usd or float("inf");')
 s=s.replace("'spend_cap_usd':SPEND_CAP", "'spend_cap_usd':args.spend_cap_usd or None")
 s=s.replace("    if d.exists():raise RuntimeError('Incomplete attempt preserved; use a new phase: '+rid)","    if d.exists():raise RuntimeError('Incomplete attempt preserved; use a new phase: '+rid)\n    if shutil.disk_usage(ROOT).free < 10*1024**3:raise RuntimeError('Paid batch stopped: less than 10 GiB free')")
 p.write_text(s)
p=Path('bench/luna-api/direct.mjs');s=p.read_text().replace('if (n > taskCap || used + reserve > 10)', 'if (n > taskCap)');s=s.replace("halt('budget_or_call_cap'); throw new Error('Luna durable budget or call limit reached');", "halt('task_call_cap'); throw new Error('Luna per-task call limit reached');")
s=s.replace('halt(`http_${response.status}`);',"const problem = await response.clone().text();\n      const billing = /insufficient_quota|billing|credit_balance|payment_required/i.test(problem);\n      halt(billing ? 'billing_error' : `http_${response.status}`);")
p.write_text(s)
p=Path('bench/run-converged-screen.sh');s=p.read_text();s=s.replace('--models deepseek-flash,deepseek-v4-pro --tasks 03-window-padding,07-source-manifest,09-separator-payload,12-partition-map','--models deepseek-flash');s=s.replace('--spend-cap-usd 25 --balance-floor-usd 10','--spend-cap-usd 0 --balance-floor-usd 1');p.write_text(s)
p=Path('bench/run-luna-api-screen.sh');s=p.read_text().replace('tasks=${3:-03-window-padding,07-source-manifest,09-separator-payload,12-partition-map}','tasks=${3:-01-split-before,02-chunked-even,03-window-padding,04-exception-chaining,05-query-docs,06-json-errors,07-source-manifest,08-expiry-typing,09-separator-payload,10-expiry-boundary,11-compression-marker,12-partition-map}');s=s.replace('--spend-cap-usd 10 --balance-floor-usd 10','--spend-cap-usd 0 --balance-floor-usd 1');p.write_text(s)
