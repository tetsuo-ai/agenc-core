"""Deterministic native-provider fixtures, with independent artifact grading."""
import hashlib
import json
import pathlib
import random
import struct
import subprocess
import zlib

TASKS = ("file", "multi-file", "debug", "replay", "vision", "long-context")


def write(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def image_fixture():
    """Three red squares, two blue circles and one green triangle."""
    width, height = 360, 240
    pixels = bytearray([255] * width * height * 3)
    for y in range(height):
        for x in range(width):
            color = None
            if any(abs(x-cx) <= 23 and abs(y-50) <= 23 for cx in (60, 180, 300)):
                color = (225, 30, 30)
            if any((x-cx)**2 + (y-130)**2 <= 25**2 for cx in (100, 260)):
                color = (30, 70, 230)
            if 175 <= y <= 220 and abs(x-180) <= (y-175)*0.65:
                color = (20, 160, 45)
            if color:
                i = (y*width+x)*3
                pixels[i:i+3] = bytes(color)
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind+data))
    raw = b''.join(b'\0'+pixels[y*width*3:(y+1)*width*3] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def long_prompt(records=6500, seed=0):
    needles = {17: 'orchid', records//2: 'cobalt', records-19: 'harbor'}
    order = list(range(records))
    if seed:
        rng = random.Random(seed)
        needles = {i: hashlib.sha256(f'{seed}:{i}'.encode()).hexdigest()[:12]
                   for i in sorted(rng.sample(order, min(24, records)))}
        rng.shuffle(order)
    lines = [f'Record {i:05d}: item={needles.get(i, "ordinary")}; status=archived; count={i % 97}.\n' for i in order]
    prompt = ('Find the item values for records '+', '.join(map(str, needles))+
              ' in the supplied archive. Use a tool to write answer.json as a JSON array of the requested values '
              'in that order, then read it back. Do not create or consult an archive file.\n<archive>\n'+
              ''.join(lines)+'</archive>\nReturn a brief confirmation.')
    return prompt, list(needles.values())


def prepare(root, task, records=6500, seed=0):
    root = pathlib.Path(root)
    root.mkdir(parents=True, exist_ok=True)
    protected = []
    expected = None
    if task == 'file':
        prompt = 'Use a tool to create hello.txt containing exactly hi. Then read it back with a tool and reply with only its content.'
    elif task == 'multi-file':
        write(root, 'lib/data.mjs', 'export const procesData = xs => xs.map(x => x * 2);\n')
        write(root, 'index.mjs', 'import { procesData } from "./lib/data.mjs";\nexport const run = xs => procesData(xs);\n')
        write(root, 'check.mjs', 'import { strict as a } from "node:assert";\nimport * as lib from "./lib/data.mjs";\nimport { run } from "./index.mjs";\na.equal(typeof lib.processData, "function"); a.equal(lib.procesData, undefined);\na.deepEqual(run([1,-2,0]), [2,-4,0]); a.deepEqual(run([]), []); console.log("PASS multi-file");\n')
        prompt = 'Rename procesData to processData in lib/data.mjs and index.mjs. Preserve behavior. Run node check.mjs and fix any failures. Do not change check.mjs.'
        protected = ['check.mjs']
    elif task == 'debug':
        write(root, 'sum.mjs', 'export function sum(xs) { let total = 0; for (let i = 0; i <= xs.length; i++) total += xs[i]; return total; }\n')
        write(root, 'check.mjs', 'import { strict as a } from "node:assert";\nimport { sum } from "./sum.mjs";\na.equal(sum([1,2,3]), 6); a.equal(sum([]), 0); a.equal(sum([-2,5]), 3); console.log("PASS debug");\n')
        prompt = 'First run node check.mjs before reading or editing sum.mjs. Diagnose the failing test, fix sum.mjs, then run the same test again. Do not edit check.mjs.'
        protected = ['check.mjs']
    elif task == 'replay':
        steps = [
            ('normalize', 'Convert strings to trimmed lowercase strings.', [' A ', 'B '], ['a', 'b']),
            ('unique', 'Remove duplicates while preserving first occurrence order.', ['a', 'b', 'a'], ['a', 'b']),
            ('sort', 'Sort strings alphabetically without changing the input.', ['c', 'a', 'b'], ['a', 'b', 'c']),
            ('lengths', 'Map strings to their lengths.', ['ab', '', 'xyz'], [2, 0, 3]),
            ('total', 'Sum numbers, returning zero for an empty array.', [2, 0, 3], 5),
            ('report', 'Given a number, return an object with total equal to that number and unit equal to characters.', 5, {'total': 5, 'unit': 'characters'}),
        ]
        write(root, 'steps.json', json.dumps(steps))
        write(root, 'check.mjs', '''import { strict as a } from 'node:assert';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const steps = JSON.parse(readFileSync('steps.json', 'utf8'));
const n = Number(process.argv[2]); a.ok(Number.isInteger(n) && n >= 1 && n <= steps.length);
const done = existsSync('progress.json') ? JSON.parse(readFileSync('progress.json', 'utf8')) : [];
a.equal(done.length, n-1, 'complete stages in order');
const [name, , input, expected] = steps[n-1];
const { transform } = await import('./'+name+'.mjs');
const copy = structuredClone(input); a.deepEqual(transform(copy), expected); a.deepEqual(copy, input);
if (name === 'total') a.equal(transform([]), 0);
done.push(name); writeFileSync('progress.json', JSON.stringify(done));
console.log('PASS stage '+n);
console.log(n < steps.length ? 'NEXT: '+JSON.stringify(steps[n]) : 'All six stages passed. Compose them in pipeline.mjs, exporting run(input).');
''')
        prompt = ('Build a six-stage text processing pipeline. Start by reading the first entry of steps.json. '
                  'For each stage, create its named .mjs file exporting transform. Run node check.mjs N for that stage alone, '
                  'inspect its result before implementing the next stage, and keep the earlier requirements across tool steps. '
                  'After all six checks, compose the stages in pipeline.mjs exporting run(input). '
                  'run([" B ","a","b"]) must return {"total":2,"unit":"characters"}. '
                  'Run an integration test. Do not change steps.json or check.mjs, or write progress.json directly.')
        protected = ['steps.json', 'check.mjs']
    elif task == 'vision':
        (root/'shapes.png').write_bytes(image_fixture())
        prompt = ('Inspect the attached image visually. Write answer.json with integer counts under keys red_squares, '
                  'blue_circles, green_triangles. Then read it back. Do not inspect image bytes or run image analysis code.')
    elif task == 'long-context':
        prompt, expected = long_prompt(records, seed)
    else:
        raise ValueError(task)
    return {'prompt': prompt, 'image': str(root/'shapes.png') if task == 'vision' else None,
            'expected': expected,
            'protected': {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in protected}}


def grade(root, task, spec, env):
    root = pathlib.Path(root)
    try:
        for name, digest in spec['protected'].items():
            if hashlib.sha256((root/name).read_bytes()).hexdigest() != digest:
                return False, f'Protected fixture changed: {name}'
        if task == 'file':
            return (root/'hello.txt').read_bytes() == b'hi', 'exact bytes'
        if task in ('vision', 'long-context'):
            expected = ({'red_squares': 3, 'blue_circles': 2, 'green_triangles': 1} if task == 'vision'
                        else spec.get('expected') or ['orchid', 'cobalt', 'harbor'])
            return json.loads((root/'answer.json').read_text()) == expected, 'independent JSON oracle'
        if task == 'replay':
            assert json.loads((root/'progress.json').read_text()) == ['normalize','unique','sort','lengths','total','report']
            script = 'import {strict as a} from "node:assert"; import {run} from "./pipeline.mjs"; a.deepEqual(run([" B ","a","b"]), {total:2,unit:"characters"}); a.deepEqual(run([]), {total:0,unit:"characters"}); a.deepEqual(run([" XYZ ","ab","xyz"]), {total:5,unit:"characters"});'
            args = ['node', '--input-type=module', '-e', script]
        else:
            args = ['node', 'check.mjs']
        result = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True, timeout=10)
        return result.returncode == 0, result.stdout+result.stderr
    except (OSError, ValueError, AssertionError, subprocess.TimeoutExpired) as error:
        return False, type(error).__name__
