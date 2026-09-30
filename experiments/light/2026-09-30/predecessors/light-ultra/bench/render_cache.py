import json,collections,statistics
from pathlib import Path
root=Path(__file__).resolve().parent.parent
rows=json.loads((root/'evidence/cache-wire.json').read_text());groups=collections.defaultdict(list)
for r in rows:groups[(r['job'],r['model'],r['agent'],r['phase'])].append(r)
lines=['Wire audit treats response-ID continuations as intentional deltas. Remote retained history cannot be reconstructed from those requests alone. Growth is appended request-history characters, not provider tokens. Cache share uses complete-usage runs.', '', '| Job / model / agent / phase | Runs | Raw tokens/run | Uncached/run | Cache share | History growth chars/call | Schema / history / system changes | Response-ID calls |', '| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |']
for k,rs in sorted(groups.items()):
 valid=[r for r in rs if r['input_tokens']];count=collections.Counter();growth=[v for r in rs for v in r['history_growth_chars']]
 for r in rs:count.update(r['change_counts'])
 if not valid:continue
 lines.append('| '+ '/'.join(k)+f' | {len(rs)} | {statistics.mean(r["raw_tokens"] for r in valid):,.0f} | {statistics.mean(r["uncached_tokens"] for r in valid):,.0f} | {sum(r["cached_tokens"] for r in valid)/sum(r["input_tokens"] for r in valid):.1%} | {statistics.mean(growth) if growth else 0:,.0f} | '+ '/'.join(str(count[f]) for f in ['schema_prefix_changed','history_prefix_changed','system_changed'])+f' | {sum(r["response_id_continuations"] for r in rs)} |')
(root/'evidence/cache-wire.md').write_text('\n'.join(lines)+'\n')
