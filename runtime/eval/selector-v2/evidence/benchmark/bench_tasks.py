#!/usr/bin/env python3
"""Frozen task builder and deterministic graders. Never executes submitted code."""
import argparse
import ast
import copy
import datetime
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
SYSTEM_PROMPT = 'Solve the supplied task. Return exactly the requested JSON object as your final answer. Do not include markdown, explanation or additional keys. All data is supplied; no external knowledge or network access is needed.'
CODE_RULES = ('Write Python 3 function solve(data), returning the specified JSON-compatible result. Return only {"code":"def solve(data):\\n    ..."}. No imports or other functions. Allowed: assignments, indexing/slicing, if/else, for/while, break/continue, return, list/dict/set/tuple literals and comprehensions, arithmetic except exponentiation, comparisons, and calls to len, range, sorted, min, max, sum, abs, enumerate, zip, list, dict, set, tuple, all, any, int, str, bool. Allowed methods: append, extend, pop, get, keys, values, items, sort, reverse, count, index, split, join, lower, upper, strip, startswith, endswith. No attributes except these method calls. Do not use recursion. Inputs are small; the grader has a 100,000-step limit. ')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool): return type(a) is type(b) and a == b
    if isinstance(a, (int,float)) and isinstance(b, (int,float)): return math.isfinite(a) and math.isfinite(b) and a == b
    if type(a) is not type(b): return False
    if isinstance(a, dict): return set(a)==set(b) and all(equal(a[k],b[k]) for k in a)
    if isinstance(a, list): return len(a)==len(b) and all(equal(x,y) for x,y in zip(a,b))
    return a == b

class CodeRejected(Exception):
    pass

class Returned(Exception):
    def __init__(self, value): self.value = value

class Broken(Exception): pass
class Continued(Exception): pass

class SafePython:
    """AST interpreter: no eval/exec/compile, no globals, no filesystem or processes.

    Only explicitly enumerated AST operations and builtins are interpreted. Model
    strings are data throughout. This is a constrained coding benchmark, not a
    general-purpose Python runtime or a claim that Python/Node VM is a sandbox.
    """
    def __init__(self, code):
        if not isinstance(code, str) or len(code) > 16000: raise CodeRejected('code-size')
        try: tree = ast.parse(code)
        except (SyntaxError, ValueError, RecursionError): raise CodeRejected('syntax')
        if sum(1 for _ in ast.walk(tree)) > 3000: raise CodeRejected('ast-size')
        body = tree.body
        if len(body) != 1 or not isinstance(body[0], ast.FunctionDef): raise CodeRejected('one-function-required')
        fn = body[0]
        if fn.name != 'solve' or fn.decorator_list or fn.returns or fn.type_comment: raise CodeRejected('function-signature')
        a = fn.args
        if a.posonlyargs or a.vararg or a.kwarg or a.kwonlyargs or a.defaults or len(a.args) != 1 or a.args[0].arg != 'data' or a.args[0].annotation: raise CodeRejected('function-signature')
        self.body = fn.body
        self.steps = 0
        self.env = {}

    def tick(self):
        self.steps += 1
        if self.steps > 100000: raise CodeRejected('step-limit')

    def bound(self, value):
        if isinstance(value, int) and abs(value) > 10**100: raise CodeRejected('integer-limit')
        if isinstance(value, (str, list, tuple, dict, set, range)) and len(value) > 10000: raise CodeRejected('value-size')
        return value

    def assign(self, target, value):
        self.tick()
        if isinstance(target, ast.Name):
            if target.id.startswith('_'): raise CodeRejected('private-name')
            self.env[target.id] = self.bound(value)
        elif isinstance(target, (ast.Tuple, ast.List)):
            if len(target.elts) != len(value): raise CodeRejected('unpack')
            for x, y in zip(target.elts, value): self.assign(x, y)
        elif isinstance(target, ast.Subscript):
            base, key = self.expr(target.value), self.expr(target.slice)
            if not isinstance(base, (list, dict)): raise CodeRejected('assignment-target')
            base[key] = self.bound(value)
            self.bound(base)
        else: raise CodeRejected('assignment-target')

    def binary(self, op, left, right):
        if isinstance(op, ast.Add): result = left + right
        elif isinstance(op, ast.Sub): result = left - right
        elif isinstance(op, ast.Mult):
            if isinstance(left, (list, tuple, str)) and isinstance(right, int) and len(left)*right > 10000: raise CodeRejected('value-size')
            if isinstance(right, (list, tuple, str)) and isinstance(left, int) and len(right)*left > 10000: raise CodeRejected('value-size')
            result = left * right
        elif isinstance(op, ast.FloorDiv): result = left // right
        elif isinstance(op, ast.Div): result = left / right
        elif isinstance(op, ast.Mod):
            if not isinstance(left, (int,float)) or not isinstance(right, (int,float)): raise CodeRejected('numeric-modulo-only')
            result = left % right
        elif isinstance(op, ast.BitOr) and isinstance(left, set): result = left | right
        elif isinstance(op, ast.BitAnd) and isinstance(left, set): result = left & right
        else: raise CodeRejected('binary-operation')
        return self.bound(result)

    def comprehension(self, node):
        output = []
        old = dict(self.env)
        def visit(i):
            self.tick()
            if i == len(node.generators):
                output.append((self.expr(node.key),self.expr(node.value)) if isinstance(node, ast.DictComp) else self.expr(node.elt))
                self.bound(output)
                return
            gen = node.generators[i]
            if gen.is_async: raise CodeRejected('async')
            for item in self.expr(gen.iter):
                self.assign(gen.target, item)
                if all(self.expr(test) for test in gen.ifs): visit(i+1)
        try: visit(0)
        finally: self.env = old
        if isinstance(node, ast.DictComp): return dict(output)
        if isinstance(node, ast.SetComp): return set(output)
        return output

    def expr(self, node):
        self.tick()
        if isinstance(node, ast.Constant):
            if not isinstance(node.value, (str,int,float,bool,type(None))): raise CodeRejected('constant')
            return self.bound(node.value)
        if isinstance(node, ast.Name):
            if node.id.startswith('_') or node.id not in self.env: raise CodeRejected('unknown-name')
            return self.env[node.id]
        if isinstance(node, ast.List): return [self.expr(v) for v in node.elts]
        if isinstance(node, ast.Tuple): return tuple(self.expr(v) for v in node.elts)
        if isinstance(node, ast.Set): return set(self.expr(v) for v in node.elts)
        if isinstance(node, ast.Dict): return {self.expr(k):self.expr(v) for k,v in zip(node.keys,node.values)}
        if isinstance(node, (ast.ListComp,ast.SetComp,ast.DictComp,ast.GeneratorExp)): return self.comprehension(node)
        if isinstance(node, ast.Subscript): return self.expr(node.value)[self.expr(node.slice)]
        if isinstance(node, ast.Slice): return slice(*(self.expr(n) if n is not None else None for n in [node.lower,node.upper,node.step]))
        if isinstance(node, ast.BinOp): return self.binary(node.op,self.expr(node.left),self.expr(node.right))
        if isinstance(node, ast.UnaryOp):
            value = self.expr(node.operand)
            if isinstance(node.op,ast.Not): return not value
            if isinstance(node.op,ast.USub): return self.bound(-value)
            if isinstance(node.op,ast.UAdd): return self.bound(+value)
            raise CodeRejected('unary-operation')
        if isinstance(node, ast.BoolOp):
            value = self.expr(node.values[0])
            for n in node.values[1:]:
                if isinstance(node.op,ast.And) and not value: break
                if isinstance(node.op,ast.Or) and value: break
                value = self.expr(n)
            return value
        if isinstance(node, ast.Compare):
            left = self.expr(node.left)
            for op, n in zip(node.ops,node.comparators):
                right = self.expr(n)
                if isinstance(op,ast.Eq): ok = left == right
                elif isinstance(op,ast.NotEq): ok = left != right
                elif isinstance(op,ast.Lt): ok = left < right
                elif isinstance(op,ast.LtE): ok = left <= right
                elif isinstance(op,ast.Gt): ok = left > right
                elif isinstance(op,ast.GtE): ok = left >= right
                elif isinstance(op,ast.In): ok = left in right
                elif isinstance(op,ast.NotIn): ok = left not in right
                elif isinstance(op,ast.Is): ok = left is right
                elif isinstance(op,ast.IsNot): ok = left is not right
                else: raise CodeRejected('comparison')
                if not ok: return False
                left = right
            return True
        if isinstance(node,ast.IfExp): return self.expr(node.body if self.expr(node.test) else node.orelse)
        if isinstance(node,ast.Call):
            args = [self.expr(n) for n in node.args]
            kwargs = {n.arg:self.expr(n.value) for n in node.keywords}
            if None in kwargs: raise CodeRejected('keyword-expansion')
            if isinstance(node.func,ast.Name):
                name = node.func.id
                builtins = {'len':len,'sorted':sorted,'min':min,'max':max,'sum':sum,'abs':abs,'list':list,'dict':dict,'set':set,'tuple':tuple,'all':all,'any':any,'int':int,'str':str,'bool':bool}
                if name == 'range': return self.bound(range(*args,**kwargs))
                if name == 'enumerate': return self.bound(list(enumerate(*args,**kwargs)))
                if name == 'zip': return self.bound(list(zip(*args,**kwargs)))
                if name not in builtins: raise CodeRejected('forbidden-call')
                return self.bound(builtins[name](*args,**kwargs))
            if isinstance(node.func,ast.Attribute):
                base = self.expr(node.func.value)
                name = node.func.attr
                allowed = {list:{'append','extend','pop','sort','reverse','count','index'},dict:{'get','keys','values','items','pop'},str:{'split','join','lower','upper','strip','startswith','endswith','count','index'}}
                if name not in allowed.get(type(base),set()): raise CodeRejected('forbidden-method')
                if name == 'join' and sum(len(v) for v in args[0])+len(base)*len(args[0]) > 10000: raise CodeRejected('value-size')
                result = getattr(base,name)(*args,**kwargs)
                self.bound(base)
                if name in {'keys','values','items'}: result = list(result)
                return self.bound(result)
            raise CodeRejected('call-target')
        raise CodeRejected('expression-'+type(node).__name__)

    def block(self, statements):
        for node in statements:
            self.tick()
            if isinstance(node,ast.Assign):
                value = self.expr(node.value)
                for target in node.targets: self.assign(target,value)
            elif isinstance(node,ast.AugAssign): self.assign(node.target,self.binary(node.op,self.expr(node.target),self.expr(node.value)))
            elif isinstance(node,ast.Return): raise Returned(self.expr(node.value) if node.value is not None else None)
            elif isinstance(node,ast.Expr): self.expr(node.value)
            elif isinstance(node,ast.If): self.block(node.body if self.expr(node.test) else node.orelse)
            elif isinstance(node,(ast.For,ast.While)):
                broken = False
                if isinstance(node,ast.For): iterator = iter(self.expr(node.iter))
                while True:
                    self.tick()
                    if isinstance(node,ast.For):
                        try: self.assign(node.target,next(iterator))
                        except StopIteration: break
                    elif not self.expr(node.test): break
                    try: self.block(node.body)
                    except Continued: continue
                    except Broken: broken = True; break
                if not broken: self.block(node.orelse)
            elif isinstance(node,ast.Break): raise Broken()
            elif isinstance(node,ast.Continue): raise Continued()
            elif isinstance(node,ast.Pass): pass
            else: raise CodeRejected('statement-'+type(node).__name__)

    def run(self, data):
        self.env = {'data':copy.deepcopy(data)}
        self.steps = 0
        try: self.block(self.body)
        except Returned as r: return r.value
        return None

def grade(task, response_text):
    try:
        if not isinstance(response_text,str) or len(response_text)>131072: return {'pass':False,'reason':'answer-size'}
        answer = json.loads(response_text)
        if task['grader']['type'] == 'exact-json':
            return {'pass':equal(answer,task['expected']),'reason':'exact-match' if equal(answer,task['expected']) else 'answer-mismatch'}
        if not isinstance(answer,dict) or set(answer) != {'code'}: return {'pass':False,'reason':'code-object-required'}
        runner = SafePython(answer['code'])
        passed = 0
        for test in task['grader']['tests']:
            if not equal(runner.run(test['input']),test['output']): return {'pass':False,'reason':'test-mismatch','testsPassed':passed,'testsTotal':len(task['grader']['tests'])}
            passed += 1
        return {'pass':True,'reason':'all-tests-pass','testsPassed':passed,'testsTotal':passed}
    except json.JSONDecodeError: return {'pass':False,'reason':'invalid-json'}
    except CodeRejected as e: return {'pass':False,'reason':'restricted-python:'+str(e)}
    except Exception as e: return {'pass':False,'reason':'grader-runtime:'+type(e).__name__}

def make_tasks(source):
    original = json.loads(source.read_text())
    tasks = []
    for t in original['tasks']:
        t = copy.deepcopy(t)
        t.update(grader={'type':'exact-json'},maxOutputTokens=4096,needsTools=False,files={},provenance={'source':str(source),'suiteVersion':original['suiteVersion'],'originalSplit':t['split'],'priorExposure':'previous job already evaluated these tasks; original holdout is reused, not newly unseen'})
        tasks.append(t)
    def add(id,split,kind,complexity,prompt,expected,**kwargs):
        row = dict(id=id,split=split,kind=kind,complexity=complexity,prompt=prompt,expected=expected,grader={'type':'exact-json'},maxOutputTokens=4096,needsTools=False,files={},provenance={'source':'router-bench authored frozen extension','priorExposure':'unseen by routing tuning; authored before provider calls'})
        row.update(kwargs)
        tasks.append(row)
    def code(id,split,complexity,prompt,tests,reference):
        add(id,split,'coding',complexity,CODE_RULES+prompt,None,grader={'type':'restricted-python-tests','tests':[{'input':x,'output':y} for x,y in tests]},referenceAnswer={'code':reference},maxOutputTokens=4096)
    code('cal-code-stable-unique','calibration','simple','Input data is a list of integers. Return unique values in first occurrence order.',[([],[]),([3,1,3,2,1],[3,1,2]),([0,0,-1,0,-1,2],[0,-1,2]),([4],[4]),([8,7,6],[8,7,6])], 'def solve(data):\n    out=[]\n    for x in data:\n        if x not in out: out.append(x)\n    return out')
    code('cal-code-interval-union','calibration','moderate','Input data is a list of closed integer intervals [start,end] with start<=end. Merge intervals that overlap or touch at the same endpoint (do not merge [1,2] with [3,4]). Return intervals sorted by start. Empty input returns [].',[([],[]),([[5,7],[1,3],[3,5]],[[1,7]]),([[1,2],[3,4]],[[1,2],[3,4]]),([[2,2],[1,9],[3,4]],[[1,9]]),([[-4,-2],[-2,0],[5,5]],[[-4,0],[5,5]])], 'def solve(data):\n    out=[]\n    for pair in sorted(data):\n        if out and pair[0]<=out[-1][1]:\n            out[-1][1]=max(out[-1][1],pair[1])\n        else: out.append(list(pair))\n    return out')
    code('cal-code-shortest-path','calibration','hard','Input data has n (1..12), undirected edges [[u,v],...] over vertices 0..n-1, start and goal. Return minimum edge count from start to goal, or -1 if unreachable. Self loops and duplicate edges are possible.',[({'n':1,'edges':[],'start':0,'goal':0},0),({'n':4,'edges':[[0,1],[1,2],[2,3],[0,3]],'start':0,'goal':3},1),({'n':4,'edges':[[0,1]],'start':0,'goal':3},-1),({'n':5,'edges':[[0,0],[0,1],[0,1],[1,2],[2,4]],'start':4,'goal':0},3)],'def solve(data):\n    dist=[-1]*data["n"]\n    dist[data["start"]]=0\n    q=[data["start"]]\n    for u in q:\n        if u==data["goal"]: return dist[u]\n        for a,b in data["edges"]:\n            if a==u: v=b\n            elif b==u: v=a\n            else: continue\n            if dist[v]<0:\n                dist[v]=dist[u]+1\n                q.append(v)\n    return -1')
    code('cal-code-version-merge','calibration','moderate','Input data is records with id (string), rev (integer), value (integer or null). For each id keep highest revision; equal revisions have identical values. Null deletes an id. Return a dictionary of surviving id:value pairs.',[([],{}),([{'id':'a','rev':2,'value':7},{'id':'a','rev':1,'value':9}],{'a':7}),([{'id':'a','rev':1,'value':7},{'id':'a','rev':2,'value':None}],{}),([{'id':'x','rev':1,'value':None},{'id':'x','rev':3,'value':0},{'id':'z','rev':2,'value':4}],{'x':0,'z':4})], 'def solve(data):\n    best={}\n    for r in data:\n        if r["id"] not in best or r["rev"]>best[r["id"]]["rev"]: best[r["id"]]=r\n    return {k:v["value"] for k,v in best.items() if v["value"] is not None}')
    code('hold-code-window-max','holdout','moderate','Input data has nums (list of integers) and k (1<=k<=len(nums), unless nums is empty). Return maximum of each consecutive window of length k, in order. Empty nums returns [].',[({'nums':[],'k':1},[]),({'nums':[1,3,-1,-3,5,3,6,7],'k':3},[3,3,5,5,6,7]),({'nums':[-2,-3,-1],'k':2},[-2,-1]),({'nums':[4,4,1],'k':1},[4,4,1]),({'nums':[4,2,9],'k':3},[9])], 'def solve(data):\n    a=data["nums"]\n    k=data["k"]\n    return [max(a[i:i+k]) for i in range(len(a)-k+1)]')
    code('hold-code-topological-order','holdout','hard','Input data has n (0..10) and directed edges [[u,v],...] meaning u must precede v. Return lexicographically smallest topological ordering of vertices 0..n-1, or [] if there is a cycle. Duplicate edges have no extra meaning.',[({'n':0,'edges':[]},[]),({'n':4,'edges':[[0,2],[1,2],[2,3]]},[0,1,2,3]),({'n':3,'edges':[[0,1],[1,0]]},[]),({'n':4,'edges':[[3,0],[3,0],[1,2]]},[1,2,3,0]),({'n':1,'edges':[[0,0]]},[])], 'def solve(data):\n    out=[]\n    for i in range(data["n"]):\n        found=False\n        for v in range(data["n"]):\n            if v not in out and all(a in out for a,b in data["edges"] if b==v):\n                out.append(v)\n                found=True\n                break\n        if not found: return []\n    return out')
    add('cal-extract-csv','calibration','extraction','simple','Parse RFC4180 CSV below. Return {"names":[names whose qty>=3 in input order],"total":sum of all qty}. CSV:\nname,qty\n"Doe, Jane",3\n"The ""A"" team",2\nAda,5',{'names':['Doe, Jane','Ada'],'total':10})
    add('cal-extract-units','calibration','extraction','moderate','Normalize inventory to grams; kg=1000g, mg=0.001g. Exclude canceled entries. Records: A=1.25kg active; B=700mg active; C=400g canceled; D=12.3g active; E=0.087kg active. Return {"grams":{"A":number,"B":number,"D":number,"E":number},"total":number}.',{'grams':{'A':1250,'B':0.7,'D':12.3,'E':87},'total':1350})
    add('cal-extract-event-sourcing','calibration','extraction','hard','Start stock A=5,B=2. Process events in order. Each eventId is processed once: duplicates are ignored even if earlier rejected. A move succeeds atomically only with sufficient source stock. Restock adds amount. Events: e1 move A->B 4; e2 move B->A 7; e3 restock B 3; e2 move B->A 7; e4 move B->A 5; e5 move A->B 6; e1 move A->B 4. Return {"stock":{"A":integer,"B":integer},"rejected":[eventIds],"duplicates":[eventIds in arrival order]}.',{'stock':{'A':0,'B':10},'rejected':['e2'],'duplicates':['e2','e1']})
    add('cal-extract-precedence','calibration','extraction','moderate','Configuration merges in order: defaults, region, account, request. A null means delete that key, not inherit. Objects merge recursively; arrays replace. Defaults={"retry":3,"tags":["base"],"db":{"port":10,"ssl":false}}; region={"db":{"ssl":true},"tags":["eu"]}; account={"retry":null,"db":{"port":20}}; request={"retry":0,"tags":[],"db":{"ssl":null}}. Return {"config":merged object}.',{'config':{'retry':0,'tags':[],'db':{'port':20}}})
    add('hold-extract-timezones','holdout','extraction','moderate','All timestamps are September 29, 2026 unless a date is given. Convert to UTC and sort earliest first; ties preserve input order. Events: a at 01:15 UTC+02; b at 00:00 UTC; c at 18:30 UTC-05 on September 28; d at 08:30 UTC+09; e at 23:45 UTC on September 28. Return {"ids":[eventIds],"utc":[ISO timestamps YYYY-MM-DDTHH:MM:00Z in corresponding order]}.',{'ids':['a','c','d','e','b'],'utc':['2026-09-28T23:15:00Z','2026-09-28T23:30:00Z','2026-09-28T23:30:00Z','2026-09-28T23:45:00Z','2026-09-29T00:00:00Z']})
    add('hold-extract-ledger','holdout','extraction','hard','Ledger starts balance=100 integer cents, no pending holds. Hold succeeds only if balance minus pending holds >= amount. Capture(id,actual) releases entire matching hold and deducts actual from balance; capture is invalid if actual>held or no hold. Release removes a matching hold, or is a no-op if absent. Operations: hold a 40; hold b 70; capture a 25; hold c 60; hold d 20; release c; hold e 50; capture e 51; capture e 45; release d. Return {"balance":integer,"held":integer,"available":integer,"rejected":["operation:ID" in order]}.',{'balance':30,'held':0,'available':30,'rejected':['hold:b','hold:d','capture:e']})
    add('cal-reason-inclusion','calibration','reasoning','moderate','In integers 1..500 inclusive, count those divisible by 6 or 10 but not divisible by 15. Return {"count":integer}.',{'count':101})
    add('cal-reason-bayes','calibration','reasoning','moderate','A randomly selected box is A with probability 1/3, B with probability 2/3. A holds 3 red and 1 blue; B holds 1 red and 3 blue. Draw two balls without replacement; both are red. Return posterior probability box A as reduced {"numerator":integer,"denominator":integer}.',{'numerator':1,'denominator':1})
    add('cal-reason-maxflow','calibration','reasoning','hard','Directed network capacities: S->A 5, S->B 4, A->B 2, A->C 3, B->C 3, B->T 2, C->T 5. Find maximum integer flow S to T. Return {"flow":integer}.',{'flow':7})
    add('cal-reason-logic','calibration','reasoning','simple','Exactly one of Ada, Ben, Cy broke a cup. Exactly one statement is true. Ada: "Ben broke it." Ben: "I did not break it." Cy: "Ada did not break it." Return {"culprit":"Ada"|"Ben"|"Cy"}.',{'culprit':'Ada'})
    add('hold-reason-countpaths','holdout','reasoning','hard','A robot goes from (0,0) to (5,5) using only steps (1,0) or (0,1). It must never visit (2,2) or (3,3). How many distinct paths remain? Return {"paths":integer}.',{'paths':84})
    add('hold-reason-game','holdout','reasoning','moderate','A pile has 31 stones. Players alternate removing 1, 3, or 4 stones, never more than remain. The player taking the last stone wins. Both play optimally. Return {"firstWins":boolean,"winningFirstMoves":[all legal first removals leading to a forced win, increasing]}.',{'firstWins':True,'winningFirstMoves':[1,3]})
    tool_specs = [
        ('cal-tool-invoice-join','calibration','moderate',{'customers.json':json.dumps([{'id':'c1','region':'EU'},{'id':'c2','region':'US'},{'id':'c3','region':'EU'}]),'invoices.csv':'id,customer,status,cents\ni1,c1,paid,120\ni2,c2,paid,400\ni3,c3,pending,80\ni4,c3,paid,200\ni5,c1,paid,30\n'},'Join the files by customer ID. Return {"invoiceIds":[paid EU invoice IDs in CSV order],"totalCents":integer}.',{'invoiceIds':['i1','i4','i5'],'totalCents':350}),
        ('cal-tool-config-trace','calibration','simple',{'config.json':'{"active":"west","regions":{"west":"west.json","east":"east.json"}}','west.json':'{"endpoint":"local-west","timeout":17}','east.json':'{"endpoint":"local-east","timeout":99}'},'Follow config.json active region to its file. Return {"endpoint":string,"timeout":integer}.',{'endpoint':'local-west','timeout':17}),
        ('cal-tool-log-correlation','calibration','hard',{'a.log':'r1 start 10\nr2 start 12\nr3 start 15\nr4 start 20\n','b.log':'r2 end 19 ok\nr1 end 30 error\nr4 end 22 ok\nr3 end 25 ok\n'},'Join request IDs. Among successful requests only, return {"slowest":request ID,"duration":end minus start,"successful":[IDs in alphabetical order]}.',{'slowest':'r3','duration':10,'successful':['r2','r3','r4']}),
        ('cal-tool-dependency-files','calibration','moderate',{'root.json':'{"requires":["a","b"]}','a.json':'{"requires":["c"]}','b.json':'{"requires":["c","d"]}','c.json':'{"requires":[]}','d.json':'{"requires":["a"]}','unused.json':'{"requires":[]}'},'Starting at root, follow requires entries to <name>.json. Return {"reachable":[all reachable names including root, alphabetically],"leaves":[reachable names with empty requires, alphabetically]}.',{'reachable':['a','b','c','d','root'],'leaves':['c']}),
        ('hold-tool-artifact-manifest','holdout','moderate',{'manifest.json':'{"parts":["part-3.json","part-1.json"],"ignore":["part-2.json"]}','part-1.json':'{"count":7,"ids":["b","a"]}','part-2.json':'{"count":1000,"ids":["fake"]}','part-3.json':'{"count":5,"ids":["a","c"]}'},'Read only parts selected by the manifest. Return {"count":sum of selected counts,"ids":[unique selected IDs in first occurrence order scanning manifest.parts order]}.',{'count':12,'ids':['a','c','b']}),
        ('cal-tool-repair-audit','calibration','hard',{'expected.json':'{"a":4,"b":9,"c":0,"d":3}','actual.json':'{"a":4,"b":8,"e":6}','policy.txt':'Report missing keys, extra keys and value mismatches separately. Sort key arrays alphabetically. A mismatch includes only keys present in both files.'},'Compare actual.json with expected.json under policy.txt. Return {"missing":[keys],"extra":[keys],"mismatched":[keys],"correct":[keys]}.',{'missing':['c','d'],'extra':['e'],'mismatched':['b'],'correct':['a']})]
    for id,split,complexity,files,instruction,expected in tool_specs:
        inline = '\n\n'.join('FILE '+name+'\n'+content for name,content in files.items())
        add(id,split,'tool_use',complexity,instruction+'\nFor this direct model-choice task, these are the complete local file contents:\n'+inline,expected,needsTools=True,files=files,agentPrompt='Use local file-reading tools to inspect the provided files in the task workspace. '+instruction,maxOutputTokens=4096)
    for index in range(6):
        split = 'calibration' if index<5 else 'holdout'
        id = ('cal' if split=='calibration' else 'hold')+'-long-'+['revision','sum','crossref','exceptions','interleave','precedence'][index]
        records = []
        for n in range(240):
            records.append({'id':'item-%03d'%n,'rev':1,'value':(n*37+11)%997,'group':['amber','birch','coral','dune'][n%4],'note':'Routine archive entry; values are authoritative only under the task rules. This descriptive note is irrelevant to numerical selection.'})
        if index==0:
            records.insert(79,dict(records[17],rev=4,value=813))
            records.insert(181,dict(records[17],rev=2,value=922))
            question='For item-017 keep only highest rev, irrespective of arrival. Return {"id":"item-017","rev":integer,"value":integer}.'
            expected={'id':'item-017','rev':4,'value':813}
        elif index==1:
            chosen=[r for r in records if r['group']=='birch' and r['value']<100]
            question='Select group birch with value<100. Return {"ids":[IDs in arrival order],"total":sum of their values}.'
            expected={'ids':[r['id'] for r in chosen],'total':sum(r['value'] for r in chosen)}
        elif index==2:
            refs=['item-198','item-003','item-112','item-069','item-214']
            question='Lookup this exact reference list in order: '+json.dumps(refs)+'. Return {"values":[corresponding values],"total":their sum}.'
            vals=[records[int(r[5:])]['value'] for r in refs]
            expected={'values':vals,'total':sum(vals)}
        elif index==3:
            records.insert(92,dict(records[46],rev=3,value=None))
            records.insert(178,dict(records[46],rev=2,value=500))
            records.insert(212,dict(records[150],rev=4,value=0))
            question='For IDs item-046 and item-150 select highest revision. Null means deleted; 0 is a live value. Return {"active":{live ID:value},"deleted":[deleted IDs alphabetically]}.'
            expected={'active':{'item-150':0},'deleted':['item-046']}
        elif index==4:
            selected=[r for r in records if r['group']=='coral' and 400<=r['value']<=500]
            question='Select group coral with 400<=value<=500. Return {"ids":[IDs in arrival order],"total":sum of their values}.'
            expected={'ids':[r['id'] for r in selected],'total':sum(r['value'] for r in selected)}
        else:
            records.insert(5,dict(records[211],rev=5,value=201))
            records.insert(117,dict(records[211],rev=3,value=None))
            records.append(dict(records[211] if records[211]['id']=='item-211' else next(r for r in records if r['id']=='item-211'),rev=2,value=990))
            question='For item-211 keep highest revision, ignoring later lower revisions; null at highest revision alone deletes. Return {"id":"item-211","rev":integer,"value":integer,"deleted":boolean}.'
            expected={'id':'item-211','rev':5,'value':201,'deleted':False}
        prompt='This is a long-context archive lookup task. '+question+'\nARCHIVE BEGIN\n'+'\n'.join(json.dumps(r,separators=(',',':')) for r in records)+'\nARCHIVE END\n'+question
        add(id,split,'long_context','hard' if index in [0,3,5] else 'moderate',prompt,expected,maxOutputTokens=4096,contextCharacters=len(prompt))
    return {'suiteVersion':'router-bench-v1-42','systemPrompt':SYSTEM_PROMPT,'splitPolicy':'28 calibration / 14 holdout. Six original holdout tasks were previously evaluated by xprov and are labeled reused. Eight new extension holdout tasks are excluded from all tuning. No routing calibration or task edits may use holdout outcomes. All graders, tests and task metadata frozen before paid calls.','tasks':tasks}

def self_test(suite):
    count=0
    for task in suite['tasks']:
        reference=task.get('referenceAnswer',task['expected'])
        result=grade(task,json.dumps(reference))
        if not result['pass']: raise AssertionError((task['id'],result))
        if grade(task,'not json')['pass']: raise AssertionError('invalid accepted')
        if grade(task,json.dumps({'wrong':True}))['pass']: raise AssertionError('wrong accepted')
        count+=3
    t=next(t for t in suite['tasks'] if t['grader']['type']=='restricted-python-tests')
    for code in ['def solve(data):\n    import os\n    return []','def solve(data):\n    return __import__("os").environ','def solve(data):\n    return data.__class__','def solve(data):\n    while True: pass','def solve(data):\n    return [0]*1000000000']:
        if grade(t,json.dumps({'code':code}))['pass']: raise AssertionError('unsafe accepted')
        count+=1
    # Independently recompute the arithmetic expectations rather than testing only literals.
    byid={t['id']:t for t in suite['tasks']}
    assert sum((n%6==0 or n%10==0) and n%15!=0 for n in range(1,501))==byid['cal-reason-inclusion']['expected']['count']
    dp={(0,0):1}
    for x in range(6):
        for y in range(6):
            if (x,y)==(0,0): continue
            dp[x,y]=0 if (x,y) in {(2,2),(3,3)} else dp.get((x-1,y),0)+dp.get((x,y-1),0)
    assert dp[5,5]==byid['hold-reason-countpaths']['expected']['paths']
    wins=[False]
    for n in range(1,32): wins.append(any(n>=m and not wins[n-m] for m in [1,3,4]))
    assert {'firstWins':wins[31],'winningFirstMoves':[m for m in [1,3,4] if not wins[31-m]]}==byid['hold-reason-game']['expected']
    return {'pass':True,'checks':count+3,'tasks':len(suite['tasks'])}

def build(source):
    suite=make_tasks(source)
    result=self_test(suite)
    (ROOT/'tasks.json').write_text(json.dumps(suite,indent=2,ensure_ascii=False)+'\n')
    lines=['# Frozen router benchmark','',f"Version: `{suite['suiteVersion']}`. 42 tasks: 28 calibration, 14 holdout.",'',
        'The source job has **12 total tasks, including 6 held-out**, not 12 plus 6. All 12 are preserved verbatim in prompt, expected answer and original split. The six source holdouts have already been evaluated by that job and are explicitly reused; the 8 newly authored holdouts provide the fresh holdout stratum. The extension adds six tasks each for tested Python coding, extraction, reasoning, local-file tool use and long context. No holdout is used to tune selector profiles, prompts, candidate identity, routing labels or output budgets.','',
        'Task kind, complexity and limits are author declarations frozen before model calls. Calibration is reported separately even if no tuning occurs. Code tasks use 4–5 independent test cases; all must pass. The long-context tasks contain 240 archive records (roughly 50,000 characters each), not a claim to fill every candidate context window.','',
        'Every arm gets the identical direct prompt and system prompt. Direct tool-use tasks contain the complete file contents; they measure choice quality for the workload, not actual tool execution. End-to-end runs instead materialize `files` in the isolated workspace and give the parent `agentPrompt`; the parent must spawn a child without provider/model overrides, and that child must read the files. Final answer correctness and actual spawn/read trace must be reported independently. Only six tasks have required local-file tool actions.','',
        '## Grading and isolation','',
        '`python3 bench_tasks.py grade TASK_ID` reads the raw final-answer text from stdin and prints one JSON verdict. The Python API is `grade(task, response_text)`. Exact JSON graders reject extra keys, markdown and altered array order. Object key order does not matter; numerically equal JSON numbers are equivalent (e.g. `1` equals `1.0`), with no floating tolerance. JSON boolean and integer are distinct. Nonfinite numbers are rejected. All correctness criteria are available before requests.','',
        'Generated code is never passed to `eval`, `exec`, `compile`, Node VM, a shell or an external interpreter. `SafePython` interprets an explicitly listed AST subset with fixed builtins and methods, no imports/attributes/reflection/I/O, bounded code/AST/container sizes, and a 100,000-operation limit. Each function gets a deep copy of its test input. Unsupported syntax fails rather than escaping to host Python. This measures a constrained Python language, not unrestricted coding ability. `referenceAnswer` exists only for grader self-tests and must never be included in provider requests or routing calibration.','',
        '## Freeze and self-check','',
        '`python3 bench_tasks.py verify` validates SHA-256 of tasks, grader and this specification. `python3 bench_tasks.py self-test` checks all reference answers, rejects invalid answers, exercises forbidden code and independently recomputes arithmetic/path/game oracles. `freeze.json` records UTC timestamp, source hash and artifact hashes. Once calls begin, these four files must not change; fixes require a separately versioned suite and invalidation/re-run of affected results.','',
        '## Task inventory','',
        '| ID | Split | Kind | Difficulty | Grader | Max output tokens |','|---|---|---|---|---|---:|']
    for t in suite['tasks']: lines.append(f"| {t['id']} | {t['split']} | {t['kind']} | {t['complexity']} | {t['grader']['type']} | {t['maxOutputTokens']} |")
    (ROOT/'TASKS.md').write_text('\n'.join(lines)+'\n')
    freeze={'suiteVersion':suite['suiteVersion'],'frozenAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':str(source),'sourceSha256':digest(source),'counts':{'tasks':42,'calibration':28,'holdout':14,'newHoldout':8,'reusedHoldout':6},'files':{p:digest(ROOT/p) for p in ['tasks.json','bench_tasks.py','TASKS.md']},'selfTest':result,'noPaidCallsBeforeFreeze':True}
    (ROOT/'freeze.json').write_text(json.dumps(freeze,indent=2)+'\n')
    print(json.dumps(freeze))

def main():
    p=argparse.ArgumentParser()
    p.add_argument('command',choices=['build','grade','self-test','verify'])
    p.add_argument('task',nargs='?')
    args=p.parse_args()
    if args.command=='build':
        if (ROOT/'freeze.json').exists(): raise SystemExit('Already frozen; refusing overwrite')
        build(Path('/private/tmp/xprov-ultra/live-eval-tasks.json'))
        return
    suite=json.loads((ROOT/'tasks.json').read_text())
    if args.command=='grade':
        task=next((t for t in suite['tasks'] if t['id']==args.task),None)
        if task is None: raise SystemExit('Unknown task')
        print(json.dumps(grade(task,sys.stdin.read())))
    elif args.command=='self-test': print(json.dumps(self_test(suite)))
    else:
        freeze=json.loads((ROOT/'freeze.json').read_text())
        good=all(digest(ROOT/name)==sha for name,sha in freeze['files'].items())
        print(json.dumps({'pass':good,'files':len(freeze['files'])}))
        if not good: raise SystemExit(1)

if __name__=='__main__': main()
