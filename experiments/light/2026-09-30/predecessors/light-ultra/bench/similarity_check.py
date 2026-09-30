"""Measure normalized overlap without emitting any third-party prose or code."""
import argparse, hashlib, json, re
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--package', type=Path, required=True)
p.add_argument('--input', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
sizes = (8, 12, 20)
index = {n: set() for n in sizes}
corpus = []

def words(s):
    return re.findall(r'[a-z_][a-z_0-9]*|[0-9]+', s.lower())

def grams(tokens, n):
    return {hashlib.blake2b('\0'.join(tokens[i:i+n]).encode(), digest_size=16).digest()
            for i in range(max(0, len(tokens)-n+1))}

for path in sorted(a.package.rglob('*')):
    if not path.is_file() or path.suffix not in ('.js', '.ts', '.md', '.json', '.map'): continue
    if 'node_modules' in path.relative_to(a.package).parts: continue
    data = path.read_bytes()
    text = data.decode(errors='replace')
    texts = [text]
    if path.suffix == '.map':
        try: texts = [s for s in json.loads(text).get('sourcesContent', []) if isinstance(s, str)]
        except ValueError: continue
    corpus.append({'path':str(path.relative_to(a.package)), 'sha256':hashlib.sha256(data).hexdigest()})
    for text in texts:
        tokens = words(text)
        for n in sizes: index[n].update(grams(tokens, n))

if not corpus or any(not index[n] for n in sizes):
    raise ValueError('A nonempty Pi package corpus is required')

rows = []
for entry in json.loads(a.input.read_text()):
    row = {k:entry[k] for k in ('branch', 'path', 'revision', 'base')}
    row['sha256'] = hashlib.sha256(entry['content'].encode()).hexdigest()
    for field in ('content', 'added'):
        tokens = words(entry[field]); result = {'words':len(tokens)}
        for n in sizes:
            gs = grams(tokens, n); hits = len(gs & index[n])
            result[str(n)] = {'unique_grams':len(gs), 'matched':hits, 'fraction':hits/len(gs) if gs else 0}
        row[field] = result
    rows.append(row)
report = {'method':'Lowercase identifier/word/number tokens; unique contiguous 8/12/20-gram overlap. Whole changed files and added diff lines are both checked. Exact overlap is a screen, not proof of independent authorship or semantic dissimilarity. No package text is emitted.',
          'package':str(a.package), 'package_files':len(corpus),
          'package_manifest_sha256':hashlib.sha256(json.dumps(corpus,sort_keys=True).encode()).hexdigest(),
          'index_sizes':{n:len(s) for n,s in index.items()}, 'files':rows}
a.out.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps({'package_files':len(corpus), 'checked_files':len(rows),
                  'added_match_files':{n:sum(r['added'][str(n)]['matched']>0 for r in rows) for n in sizes}}))
