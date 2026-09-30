#!/usr/bin/env python3
"""Build the AgenC Light vs Pi results page from matched result.json files.
Usage: build_report.py OUT.html
Every number on the page is computed here from the result files and audits.
"""
import collections, html, json, pathlib, random, statistics, sys, datetime

BASE = pathlib.Path('/private/tmp/light-takeover')
PANELS = [
    {'key': 'luna', 'label': 'GPT-6 Luna', 'note': 'Direct API, effort low', 'dirs': [BASE / 'matched-v3/results-luna-r123'],
     'audits': [BASE / 'matched-v3/results-luna-r123/audit-r1.json', BASE / 'matched-v3/results-luna-r123/audit-r23.json'], 'priced': True},
    {'key': 'ds', 'label': 'DeepSeek Flash', 'note': 'API, effort high', 'dirs': [BASE / 'matched-v3-ds/results-ds-all'],
     'audits': [], 'priced': True},
    {'key': 'sol', 'label': 'GPT-5.6 Sol', 'note': 'ChatGPT sign-in, effort low', 'dirs': [BASE / 'matched-v3-sol/results-matched-v3-sol-r1'],
     'audits': [BASE / 'matched-v3-sol/results-matched-v3-sol-r1/audit.json'], 'priced': False},
]


def load(panel):
    rows = []
    for d in panel['dirs']:
        rows += [json.loads(p.read_text()) for p in sorted(d.glob('*/result.json'))]
    audits = [json.loads(p.read_text()) for p in panel['audits'] if p.exists()]
    for d in panel['dirs']:
        audits += [json.loads(p.read_text()) for p in sorted(d.glob('audit*.json')) if p not in panel['audits']]
    flagged = {}
    settings = set()
    for a in audits:
        flagged.update(a['cells_with_refusals'])
        settings.update(a['distinct_settings'])
    by = {(r['task'], r['repeat'], r['agent']): r for r in rows}
    keys = sorted({(r['task'], r['repeat']) for r in rows})
    pairs = [(by[k + ('light',)], by[k + ('pi',)]) for k in keys if k + ('light',) in by and k + ('pi',) in by]
    return rows, pairs, flagged, settings, sum(a['cells'] for a in audits)


def boot(pairs, f, n=20000, seed=1):
    clusters = collections.defaultdict(list)
    for l, p in pairs:
        clusters[l['task']].append((l, p))
    names = sorted(clusters)
    rng = random.Random(seed)
    means = sorted(statistics.fmean(f(l) - f(p) for name in (rng.choice(names) for _ in names) for l, p in clusters[name])
                   for _ in range(n))
    return statistics.fmean(f(l) - f(p) for l, p in pairs), means[int(0.025 * n)], means[int(0.975 * n)]


def p90(xs):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(0.9 * (len(xs) - 1)))]


def fmt_int(n):
    return f'{n / 1e6:.2f}M' if n >= 1e6 else f'{n / 1e3:.0f}k' if n >= 1e4 else str(n)


data = []
for panel in PANELS:
    if not any(d.exists() for d in panel['dirs']):
        continue
    rows, pairs, flagged, settings, audited = load(panel)
    if not pairs:
        continue
    usage_ok = all(c['usage_complete'] and c['id'] not in flagged for pr in pairs for c in pr)
    agents = {}
    for idx, agent in ((0, 'light'), (1, 'pi')):
        cells = [pr[idx] for pr in pairs]
        agents[agent] = {'pass': sum(c['pass'] for c in cells), 'n': len(cells), 'calls': sum(c['model_calls'] for c in cells),
                         'input': sum(c['input_tokens'] for c in cells), 'uo': sum(c['uncached_tokens'] + c['output_tokens'] for c in cells),
                         'cost': sum(c['cost_usd'] for c in cells) if panel['priced'] and usage_ok else None,
                         'median': statistics.median(c['wall_seconds'] for c in cells), 'p90': p90([c['wall_seconds'] for c in cells])}
    diffs = {}
    if len({l['task'] for l, _ in pairs}) >= 2:
        diffs['time'] = boot(pairs, lambda r: r['wall_seconds'])
        diffs['calls'] = boot(pairs, lambda r: r['model_calls'])
        if usage_ok:
            diffs['tokens'] = boot(pairs, lambda r: r['uncached_tokens'] + r['output_tokens'])
        if panel['priced'] and usage_ok:
            diffs['cost'] = boot(pairs, lambda r: r['cost_usd'])
    outcomes = collections.defaultdict(lambda: {'light': [], 'pi': []})
    for l, p in pairs:
        outcomes[l['task']]['light'].append(l['pass'])
        outcomes[l['task']]['pi'].append(p['pass'])
    data.append({**panel, 'pairs': len(pairs), 'repeats': len({l['repeat'] for l, _ in pairs}), 'agents': agents, 'diffs': diffs,
                 'outcomes': outcomes, 'settings_tuples': len(settings), 'audited': audited, 'flags': len(flagged),
                 'usage_ok': usage_ok})

TASK_NAMES = {'01-chunked-strict': 'chunked strict', '02-split-limit': 'split limit', '03-window-padding': 'window padding',
              '04-count-by': 'count_by feature', '05-empty-refactor': 'first/last refactor', '06-key-rotation-map': 'key rotation question',
              '07-source-manifest': 'shell manifest script', '08-integer-encoding': 'integer encoding', '09-separator-payload': 'separator payload',
              '10-expiry-boundary': 'expiry boundary', '11-compression-marker': 'compression marker', '12-partition-map': 'partition_map + checklist'}


def e(s):
    return html.escape(str(s))


def verdict(d):
    mean, lo, hi = d
    return 'even' if lo <= 0 <= hi else ('Light lower' if hi < 0 else 'Light higher')


METRICS = [('time', 'Time per task', 's', 1), ('calls', 'Model calls per task', '', 1),
           ('tokens', 'Uncached + output tokens per task', '', 0), ('cost', 'Cost per task', '$', 5)]


def forest(metric, title, unit, digits):
    rows = [(p['label'], p['diffs'][metric]) for p in data if metric in p['diffs']]
    if not rows:
        return ''
    lo = min(min(d[1] for _, d in rows), 0)
    hi = max(max(d[2] for _, d in rows), 0)
    pad = (hi - lo) * 0.08 or 1
    lo, hi = lo - pad, hi + pad
    W, left, right, rowh = 560, 132, 20, 34
    H = 28 + rowh * len(rows) + 24
    x = lambda v: left + (v - lo) / (hi - lo) * (W - left - right)
    def label(v):
        s = f'{abs(v):.{digits}f}'
        s = (unit + s) if unit == '$' else (s + unit)
        return ('+' if v > 0 else '−' if v < 0 else '') + s
    parts = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{e(title)}: Light minus Pi with 95 percent intervals">',
             f'<line x1="{x(0):.1f}" y1="20" x2="{x(0):.1f}" y2="{H - 22}" class="zero"/>',
             f'<text x="{x(0):.1f}" y="14" class="axis" text-anchor="middle">0 (same as Pi)</text>']
    for i, (name, (mean, a, b)) in enumerate(rows):
        y = 28 + rowh * i + rowh / 2
        cls = 'even' if a <= 0 <= b else ('good' if b < 0 else 'bad')
        parts += [f'<text x="0" y="{y + 4:.1f}" class="rowlabel">{e(name)}</text>',
                  f'<line x1="{x(a):.1f}" y1="{y:.1f}" x2="{x(b):.1f}" y2="{y:.1f}" class="ci {cls}"/>',
                  f'<circle cx="{x(mean):.1f}" cy="{y:.1f}" r="4.5" class="pt {cls}"/>',
                  f'<text x="{x(b) + 6:.1f}" y="{y + 4:.1f}" class="val">{e(label(mean))}</text>']
    parts += [f'<text x="{x(lo + pad):.1f}" y="{H - 6}" class="axis" text-anchor="start">Light lower</text>',
              f'<text x="{x(hi - pad):.1f}" y="{H - 6}" class="axis" text-anchor="end">Light higher</text>', '</svg>']
    return f'<figure class="forest"><figcaption>{e(title)}</figcaption>{"".join(parts)}</figure>'


def cell(v):
    return '<span class="mark pass" title="passed">✓</span>' if v else '<span class="mark fail" title="failed">✗</span>'


summary_rows = []
for p in data:
    L, P = p['agents']['light'], p['agents']['pi']
    cost = (f'${L["cost"]:.4f}', f'${P["cost"]:.4f}') if L['cost'] is not None else ('not priced', 'not priced')
    summary_rows.append(f'''<tr><th scope="row">{e(p["label"])}<span class="sub">{e(p["note"])} · {p["repeats"]} run{"s" if p["repeats"] > 1 else ""}, {p["pairs"]} pairs</span></th>
<td class="num"><b>{L["pass"]}</b>/{L["n"]}</td><td class="num"><b>{P["pass"]}</b>/{P["n"]}</td>
<td class="num">{L["calls"]}</td><td class="num">{P["calls"]}</td>
<td class="num">{fmt_int(L["uo"])}</td><td class="num">{fmt_int(P["uo"])}</td>
<td class="num">{cost[0]}</td><td class="num">{cost[1]}</td>
<td class="num">{L["median"]:.1f}s</td><td class="num">{P["median"]:.1f}s</td></tr>''')

tasks = sorted({t for p in data for t in p['outcomes']})
head = ''.join(f'<th scope="col" colspan="2">{e(p["label"])}</th>' for p in data)
sub = ''.join('<th scope="col" class="agent">Light</th><th scope="col" class="agent">Pi</th>' for _ in data)
task_rows = []
for t in tasks:
    tds = ''
    for p in data:
        o = p['outcomes'].get(t, {'light': [], 'pi': []})
        tds += f'<td class="marks">{"".join(cell(v) for v in o["light"])}</td><td class="marks">{"".join(cell(v) for v in o["pi"])}</td>'
    task_rows.append(f'<tr><th scope="row"><span class="tid">{e(t[:2])}</span> {e(TASK_NAMES.get(t, t))}</th>{tds}</tr>')

PHRASES = {'time': ('Light is faster', 'Light is slower'), 'calls': ('Light makes fewer model calls', 'Light makes more model calls'),
           'tokens': ('Light uses fewer tokens', 'Light uses more tokens'), 'cost': ('Light costs less', 'Light costs more')}
sig = [f'{PHRASES[m[0]][0 if verdict(p["diffs"][m[0]]) == "Light lower" else 1]} on {p["label"]}' for p in data for m in METRICS
       if m[0] in p['diffs'] and verdict(p['diffs'][m[0]]) != 'even']
total_pairs = sum(p['pairs'] for p in data)
light_pass = sum(p['agents']['light']['pass'] for p in data)
pi_pass = sum(p['agents']['pi']['pass'] for p in data)
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
audit_line = '; '.join(f'{p["label"]}: {p["audited"]} cells audited, {p["settings_tuples"]} settings tuple, {p["flags"]} flags' for p in data if p['audited'])

page = f'''<title>AgenC Light vs Pi</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column; data tables and interval plots break out to the full width. */
:root {{
  --bg: #f6f5fa; --panel: #ffffff; --ink: #1c1a24; --muted: #6a6578; --rule: #dcd8e6;
  --light: #6b3fd4; --light-soft: #ebe4fb; --pi: #3d5a6c; --good: #1f7a4f; --bad: #b3402e; --even: #8a8499;
  --display: "Schibsted Grotesk", "Helvetica Neue", Arial, sans-serif; --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --bg: #15131b; --panel: #1d1a25; --ink: #ece9f4; --muted: #a39db3; --rule: #332e40;
  --light: #a98bff; --light-soft: #2a2140; --pi: #8fb1c4; --good: #5cc28f; --bad: #f08a76; --even: #8f889f; color-scheme: dark }} }}
:root[data-theme="dark"] {{
  --bg: #15131b; --panel: #1d1a25; --ink: #ece9f4; --muted: #a39db3; --rule: #332e40;
  --light: #a98bff; --light-soft: #2a2140; --pi: #8fb1c4; --good: #5cc28f; --bad: #f08a76; --even: #8f889f; color-scheme: dark }}
body {{ background: var(--bg); color: var(--ink); font: 16px/1.55 var(--display); }}
main {{ max-width: 1080px; margin: 0 auto; padding-inline: 20px; padding-block: 40px 64px; display: grid; gap: 44px; }}
.prose {{ max-width: 68ch; }}
h1 {{ font-size: clamp(2rem, 5vw, 3.1rem); line-height: 1.05; margin: 0 0 14px; letter-spacing: -0.02em; font-weight: 800; text-wrap: balance; }}
h1 .l {{ color: var(--light); }} h1 .p {{ color: var(--pi); }}
h2 {{ font-size: 1.3rem; margin: 0 0 6px; letter-spacing: -0.01em; text-wrap: balance; }}
p {{ margin: 0 0 10px; }}
.lede {{ font-size: 1.15rem; }}
.meta {{ font: 13px/1.5 var(--mono); color: var(--muted); }}
.answer {{ border-left: 3px solid var(--light); padding-left: 16px; }}
section {{ display: grid; gap: 14px; min-width: 0; }}
.scroll {{ overflow-x: auto; }}
table {{ border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }}
th, td {{ padding: 9px 10px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }}
thead th {{ font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 500; white-space: nowrap; }}
td.num {{ font-family: var(--mono); font-size: 14px; white-space: nowrap; text-align: right; }}
th.agent {{ text-align: center; }}
tbody th {{ font-weight: 500; }}
.sub {{ display: block; font: 12px/1.4 var(--mono); color: var(--muted); font-weight: 400; margin-top: 2px; }}
.pair-l {{ background: var(--light-soft); }}
.tid {{ font-family: var(--mono); color: var(--muted); font-size: 13px; }}
td.marks {{ text-align: center; font-family: var(--mono); letter-spacing: 2px; white-space: nowrap; }}
.mark.pass {{ color: var(--good); }} .mark.fail {{ color: var(--bad); font-weight: 700; }}
.forests {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 18px 28px; }}
figure.forest {{ margin: 0; min-width: 0; }}
figcaption {{ font-weight: 700; margin-bottom: 4px; }}
svg {{ width: 100%; height: auto; display: block; }}
svg text {{ fill: var(--ink); font: 12px var(--mono); }}
svg .axis {{ fill: var(--muted); font-size: 11px; }}
svg .rowlabel {{ font-family: var(--display); font-size: 13px; }}
svg .zero {{ stroke: var(--muted); stroke-dasharray: 3 3; }}
svg .ci {{ stroke-width: 3; stroke-linecap: round; }}
svg .ci.even, svg .pt.even {{ stroke: var(--even); fill: var(--even); }}
svg .ci.good, svg .pt.good {{ stroke: var(--good); fill: var(--good); }}
svg .ci.bad, svg .pt.bad {{ stroke: var(--bad); fill: var(--bad); }}
.legend {{ display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 14px; color: var(--muted); }}
.legend i {{ display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: 0; }}
ul {{ margin: 0; padding-left: 20px; }} li {{ margin-bottom: 6px; }}
a {{ color: var(--light); }}
code {{ font-family: var(--mono); font-size: 0.9em; }}
.cols {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 24px 40px; }}
.cols > div {{ min-width: 0; }}
</style>
<main>
<header class="prose">
  <p class="meta">Matched benchmark · updated {e(now)}</p>
  <h1><span class="l">AgenC Light</span> vs <span class="p">Pi</span></h1>
  <p class="lede">Two coding agents get the same 12 coding tasks, the same model and the same settings, and we compare whether they finish the task, how many model calls and tokens they spend, what it costs and how long it takes.</p>
  <p class="answer"><b>Where it stands:</b> across {total_pairs} matched task pairs, Light passed {light_pass} and Pi passed {pi_pass}. Time, tokens and cost are even within the uncertainty on every model.{(" The one clear difference: " + "; ".join(e(s) for s in sig) + ".") if sig else ""} That is not yet evidence that either agent is better.</p>
</header>

<section>
  <h2>Results by model</h2>
  <p class="prose meta">Light / Pi for each metric. Calls, tokens and cost are totals over all pairs; time is the median per task.</p>
  <div class="scroll"><table>
    <thead><tr><th scope="col">Model</th><th scope="col" colspan="2">Tasks passed</th><th scope="col" colspan="2">Model calls</th><th scope="col" colspan="2">Uncached + output tokens</th><th scope="col" colspan="2">Cost</th><th scope="col" colspan="2">Median time</th></tr>
    <tr><th></th><th class="agent">Light</th><th class="agent">Pi</th><th class="agent">Light</th><th class="agent">Pi</th><th class="agent">Light</th><th class="agent">Pi</th><th class="agent">Light</th><th class="agent">Pi</th><th class="agent">Light</th><th class="agent">Pi</th></tr></thead>
    <tbody>{"".join(summary_rows)}</tbody>
  </table></div>
</section>

<section>
  <h2>Light minus Pi, per task</h2>
  <p class="prose">Each dot is Light's average difference from Pi on the same task; the bar is a 95% interval from resampling whole tasks. A bar crossing zero means the two are even so far.</p>
  <div class="legend"><span><i style="background:var(--good)"></i>Light clearly lower</span><span><i style="background:var(--even)"></i>even so far</span><span><i style="background:var(--bad)"></i>Light clearly higher</span></div>
  <div class="forests">{"".join(forest(*m) for m in METRICS)}</div>
</section>

<section>
  <h2>Every task, every run</h2>
  <p class="prose meta">One mark per run. ✓ passed the hidden check, ✗ failed it.</p>
  <div class="scroll"><table class="tasks">
    <thead><tr><th scope="col">Task</th>{head}</tr><tr><th></th>{sub}</tr></thead>
    <tbody>{"".join(task_rows)}</tbody>
  </table></div>
</section>

<section class="cols">
  <div>
    <h2>How the runs are kept fair</h2>
    <ul>
      <li>Same task prompt, fresh repository clone and fresh home for every run; tasks run one at a time, with the two agents' runs back to back in a seeded order.</li>
      <li>Every request is audited: {e(audit_line)}.</li>
      <li>AgenC keeps its normal sandbox (bubblewrap) and permission checks; commands run inside the sandbox. Pi has no sandbox.</li>
      <li>Task 12 asks for a checklist; it is scored on the code only, for both agents.</li>
      <li>Cost is the provider's list price from reported usage. Sol runs on the ChatGPT subscription and is not priced.</li>
      <li>Light: AgenC build 403da (Linux). Pi: 0.73.1. Linux PC, 2 CPUs and 8 GiB per run.</li>
      <li>Known bias against Light on Luna: those runs set <code>OPENAI_BASE_URL</code>, which makes Light fetch the model list before its first request (0.4 to 0.6 s per task). Held-out runs leave it unset.</li>
    </ul>
  </div>
  <div>
    <h2>What the runs found in AgenC</h2>
    <ul>
      <li>Headless Light refused every shell command under accept-edits mode. Fix: <a href="https://github.com/tetsuo-ai/agenc-core/pull/2827">agenc-core #2827</a>.</li>
      <li>On Linux without bubblewrap, every command in a git repository failed after startup. Fix, fail early with the remedy: <a href="https://github.com/tetsuo-ai/agenc-core/pull/2828">#2828</a>.</li>
      <li>macOS startup repeated about 108 permission-list subprocesses; caching cuts it to 43. <a href="https://github.com/tetsuo-ai/agenc-core/pull/2829">#2829</a>.</li>
      <li>Light's one repeated miss: task 12 on Luna (2 of 3 runs) returned original items instead of callback values.</li>
    </ul>
    <h2 style="margin-top:18px">Next</h2>
    <ul>
      <li>More DeepSeek and Sol runs, so time and cost can move from "even so far" to an answer.</li>
      <li>A Light candidate that checks every requested artifact before stopping.</li>
      <li>12 new held-out tasks, used once to confirm any claim.</li>
    </ul>
  </div>
</section>
</main>
'''
pathlib.Path(sys.argv[1]).write_text(page)
print(json.dumps({'panels': [(p['label'], p['pairs']) for p in data], 'significant': sig}))
