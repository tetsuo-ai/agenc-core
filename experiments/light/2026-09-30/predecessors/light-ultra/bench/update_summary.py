from pathlib import Path
p=Path('core/runtime/tests/tool-registry.test.ts');s=p.read_text();old='      expect(canonical.inputSchema).toEqual(normal.tools.find(tool => tool.name === canonical.name)?.inputSchema);';assert old in s;s=s.replace(old,'''      const normalSchema = normal.tools.find(tool => tool.name === canonical.name)!.inputSchema;
      expect(canonical.inputSchema).toEqual(canonical.name === "system.searchTools"
        ? { ...normalSchema, properties: { ...normalSchema.properties, instructions: { type: "string", enum: ["memory"] } } }
        : normalSchema);''');p.write_text(s)
r=Path('benchmark/runtime/benchmarks/light-mode');p=r/'summarize.py';s=p.read_text();s=s.replace('def aggregate(runs):','''def wall_distribution(runs):
    values = sorted(r['wall_seconds'] for r in runs if number(r.get('wall_seconds')))
    complete = bool(runs) and len(values) == len(runs)
    return {'median': statistics.median(values) if complete else None,
            'p90': values[math.ceil(len(values) * .9) - 1] if complete else None,
            'method': 'median; p90 nearest rank; all attempts including failures'}


def aggregate(runs):''');s=s.replace("'completed_runs': completed, 'incomplete_runs': count-completed,","'completed_runs': completed, 'incomplete_runs': count-completed,\n            'wall_seconds': wall_distribution(runs),")
s=s.replace("    return {'tokens_at_most_pi': tokens, 'pass_rate_at_least_pi': quality,\n            'light_to_pi_token_ratio': ratio, 'raw_metrics_meet_target': tokens is True and quality is True}","""    median = light['wall_seconds']['median'] < pi['wall_seconds']['median'] if all(g['wall_seconds']['median'] is not None for g in (pi,light)) else None
    p90 = light['wall_seconds']['p90'] < pi['wall_seconds']['p90'] if all(g['wall_seconds']['p90'] is not None for g in (pi,light)) else None
    return {'tokens_at_most_pi': tokens, 'pass_rate_at_least_pi': quality,
            'wall_median_lower_than_pi': median, 'wall_p90_lower_than_pi': p90,
            'light_to_pi_token_ratio': ratio, 'raw_metrics_meet_target': tokens is True and quality is True,
            'all_owner_metrics_met': tokens is True and quality is True and median is True and p90 is True}""")
s=s.replace("            check['accepted'] = not blockers and check['raw_metrics_meet_target']","""            check['no_pi_completed_task_lost'] = summaries['pi']['passed'] == 0 or (summaries['light']['runs'] > 0 and summaries['light']['passed'] == summaries['light']['runs'])
            check['accepted'] = not blockers and check['raw_metrics_meet_target'] and check['no_pi_completed_task_lost']""")
s=s.replace("and total_check['raw_metrics_meet_target'] and balanced_target","and total_check['all_owner_metrics_met'] and balanced_target")
s=s.replace("'wall_seconds':2,'model_calls':1","'wall_seconds':1 if phase.startswith('candidate') else 2,'model_calls':1")
s=s.replace("        assert result['models'][0]['totals']['pi']['failed']==1","""        assert result['models'][0]['totals']['pi']['failed']==1
        assert result['models'][0]['totals']['light']['wall_seconds']['p90'] == 1
        assert wall_distribution([{'wall_seconds':n} for n in range(1,11)])['p90'] == 9
        assert wall_distribution([{}])['median'] is None""")
s=s.replace("            'limitations':['At least two runs", "            'limitations':['Wall p90 uses nearest rank across all selected attempts. Median and p90 must both be strictly lower in each model; no Pi-completed task may have a failed Light repeat.',\n                           'At least two runs")
needle="        lines += ['','Per-task strict target: Light mean total tokens <= Pi; Light pass rate >= Pi."
assert needle in s
s=s.replace(needle,"""        lines += ['', '| Agent | Wall median seconds | Wall p90 seconds |', '| --- | ---: | ---: |']
        for agent in AGENTS:
            distribution = model['totals'][agent]['wall_seconds']
            lines.append(f"| {agent} | {format_number(distribution['median'],1)} | {format_number(distribution['p90'],1)} |")
        lines += ['','Per-task strict target: Light mean total tokens <= Pi; Light pass rate >= Pi.""")
p.write_text(s)
p=r/'README.md';s=p.read_text().replace('Candidate Light must have no greater mean total token use and no lower pass rate than Pi on every task and in totals.','Candidate Light must have no greater mean total token use and no lower pass rate than Pi on every task and in totals. Every task Pi completes must have all Light repeats complete. Each model must also have strictly lower median and nearest-rank p90 wall time across all attempts, including failures.');p.write_text(s)
