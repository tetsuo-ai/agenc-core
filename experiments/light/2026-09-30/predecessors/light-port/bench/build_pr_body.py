"""Render a reviewer-facing description from the two retained confirmations."""
import json
from pathlib import Path
r=Path(__file__).resolve().parent.parent
def read(name):return json.loads((r/'evidence'/name).read_text())
metrics=read('fair-comparison.json');tests=read('fair-full-comparison.json');files=read('pr-file-map.json');proof=read('fair-provenance.json')
report=(r/'REPORT.md').read_text();start=report.index('| Model | Agent / confirmation |');end=report.index('\n\n',start);table=report[start:end]
lines=['## Why','',
'Light repeatedly pays for its fixed instructions and earlier tool results. Measured recovery and discovery rounds amplify that history cost. This experimental profile gives Light a focused workflow, canonical file operations, bounded new output, and explicit capability loading while retaining runtime enforcement.','',
'## What per file','',
'| File | Change |','| --- | --- |']
for path,description in files.items():lines.append(f'| `{path}` | {description} |')
lines+=['| `docs/eval/light-independent.md` | Records both confirmations, the fair measurement method, validation and limitations. |',
'| `docs/eval/light-independent-status.md` | Preserves per-task decomposition and deltas for retained Pi, main-study and independent candidates. |',
'| `docs/eval/light-independent-data.json` | Retains numeric per-run measurements and provenance without prompts or response text. |','',
'## Evidence','',
'Both independent confirmations execute frozen production source `3c954ea5591c683aa9b14a0219345e11051b06dd` on twelve tasks, two repeats per model, using the retained Pi cells. The new 48-cell matrix has 48 functional grader passes, complete provider usage, and no startup or provider errors. No model-bearing cell was selectively retried.','',table,'',
'**The overall performance target is not met.** In the equal-guard confirmation, Flash still misses median time by 0.82 seconds; Pro misses p90 by 2.39 seconds. Both meet functional completion and aggregate token gates. The earlier Pro confirmation passed all aggregate gates; its Flash median and p90 failed. Both records remain visible, and the new confirmation controls timing acceptance.','',
'The fair harness makes one live balance check per task before launch, matching Pi. Local per-call reservations still enforce the lifetime $15 cap and reserve $10 floor headroom from the latest live balance snapshot. The previous guard cost 6.21/8.45 seconds per task on Flash/Pro inside wall time. New raw wall times are reported directly; no retroactive subtraction was used. Cohort `candidate-eq` has a maximum 93-byte socket path. Thirteen fair cells overlap the main job’s provider intervals; none overlap Core suites.','',
'Per-task tables report calls, prefix/history/output tokens, reasoning, large-result positions and measured timing components. Exact retained Pi first-token/generation and separate tool/overhead clocks are unavailable and remain NA. In the fair comparison, mean reasoning is 2,682 versus Pi 3,097 tokens/task on Flash and 3,870 versus 4,091 on Pro. These observations do not establish prompt causality.','',
'Integrity limitations: Pro task03 repeat2 performs root searches that expose source-cache and sibling-run filenames. Later observed reads/edits remain in its repository; no foreign source-content read was observed. This is a workspace-scope violation qualifying the functional grader count. The process-based harness also permits container scratch fixtures. Raw outcomes are retained.','',
'The compact FileRead/MultiEdit presentation omits canonical relative-path guidance; the frozen workflow does not restore it. Discovered Write retains its canonical description. Fair Flash task05 repeat2 attempts a mistyped absolute edit path, receives a rejection, then corrects it. This confirms a recovered path error and the guidance gap without proving causality. No path fix was made during confirmation.','',
'The stable eager catalog was tested and rejected: it increased tokens and failed the frozen task12 deferred-discovery condition. That check requires Light to load and invoke its planning tool; retained Pi is exempt from the discovery receipt. No grader was weakened.','',
'## Tests','',
'Linux source/test-support typechecks, the build, and 85 retained focused checks pass. The fair harness passes 45 offline checks, including seven focused checks for guard placement, live floor refusal, and local spend/reservation caps. The full suites below run sequentially after all benchmark cells, using the official Linux Core runner.','',
'| Ref | Full suite |','| --- | --- |',
'| Pinned main `3caa13df9` | '+next(line for line in tests['baseline']['summary'] if line.startswith('Tests ')).replace(' | ', ' / ')+' |',
'| Frozen candidate `3c954ea55` | '+next(line for line in tests['candidate']['summary'] if line.startswith('Tests ')).replace(' | ', ' / ')+' |','',
f"New failure identities versus the paired pinned main: **{len(tests['new_failures'])}**. Earlier failed full-suite observations remain retained, including SDK timing, Bedrock credential classification and scheduled-turn cancellation; later checks do not erase them.",'',
'Clean-room check: all changed source, prompts, tool descriptions and authored proof files are compared with the 701-file Pi package using normalized 8/12/20-word overlap, subtracting inherited main text. New textual overlap is zero. Numeric-only table patterns are reported separately. Pi source/prompt/schema/error/documentation text was not used as implementation input. The lexical scan is evidence of textual independence, not proof of semantic independence.','',
'Credential scans emit counts and paths without matching contents. Exact provider-key and generic provider-key matches are zero; header flags are unchanged baseline test fixtures.','',
'## Not changed','',
'Permission admission, sandbox execution, freshness enforcement, effect receipts and durability remain on their canonical runtime paths. Required DeepSeek reasoning history is preserved. The benchmark keeps high effort, the 8,192-token output ceiling, task/call deadlines, frozen prompts and graders, and the existing budget ledger. The new measurement does not alter production source. Only proof documents are added after the frozen revision.','',
'No default promotion, merge, release or deployment is included.']
(r/'evidence/pr-body-fair.md').write_text('\n'.join(lines)+'\n')
print('Draft PR description rendered.')
