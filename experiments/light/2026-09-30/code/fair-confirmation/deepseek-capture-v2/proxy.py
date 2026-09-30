"""Offline prospective Flash proxy derivative; no CLI launcher.
Financial source is pinned to converge runner 9141aac0…; tests compare exact ASTs.
Never configure this module with actual account credentials or journals.
"""
import datetime, hashlib, http.server, json, os, pathlib, threading, time
import urllib.request, urllib.error
from capture import Capture, Unknown
ORIGINAL_RUNNER_SHA256 = '9141aac009975534487d7aa6ed04401f7e9ae249c64a2c035695963d14cb540e'
ROOT = LEDGER = None
KEY = ''
PROVIDER = 'deepseek'
PRICING = {}
RATE_LIMITED = threading.Event()
LOCK = threading.Lock()
UPSTREAM = threading.BoundedSemaphore(2)
ACTIVE = {}
SPEND_CAP = float('inf')
BALANCE_FLOOR = 1
BALANCE_SNAPSHOT = None
MAX_CALLS = 45
OWNER = None
def write_json(p,v):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(v,indent=2)+'\n')

def balance():
    req=urllib.request.Request('https://api.deepseek.com/user/balance',headers={'Authorization':'Bearer '+KEY})
    d=json.load(urllib.request.urlopen(req,timeout=30))
    return {'is_available':d['is_available'],'total_balance':d['balance_infos'][0]['total_balance']}

def spend():
    return sum(json.loads(l).get('budget_charge_usd',json.loads(l).get('cost_usd',0)) for l in LEDGER.read_text().splitlines()) if LEDGER.exists() else 0

def pending_reservations():
    journal=ROOT/'deepseek-reservations.jsonl'
    if not journal.exists():return 0
    settled={(x['run'],x['call']) for x in (json.loads(l) for l in LEDGER.read_text().splitlines()) if 'run' in x and 'call' in x} if LEDGER.exists() else set()
    return sum(x['reserve'] for x in (json.loads(l) for l in journal.read_text().splitlines()) if (x['run'],x['call']) not in settled)

def admit_reservation(rid,n,reserve):
    with (ROOT/'deepseek-reservations.jsonl').open('a') as f:
        f.write(json.dumps({'run':rid,'call':n,'reserve':reserve,'time':time.time()})+'\n');f.flush();os.fsync(f.fileno())


def rates(model,stamp):
    d=datetime.datetime.fromtimestamp(stamp,datetime.timezone.utc)
    peak=d.weekday() in PRICING['peak_weekdays_utc'] and any(start<=d.hour<end for start,end in PRICING['peak_hours_utc'])
    base=PRICING['models'][model]['usd_per_million_tokens']
    return [v*(PRICING['peak_multiplier'] if peak else 1) for v in base]


def reservation(body):
    if PROVIDER=='openai':return 0
    # Serialized bytes conservatively bound prompt tokens; reserve peak output.
    peak=PRICING['peak_multiplier']
    rate=PRICING['models'][body['model']]['usd_per_million_tokens']
    output=body.get('max_tokens',body.get('max_completion_tokens',8192))
    return (output*rate[2]*peak+len(json.dumps(body).encode())*rate[1]*peak)/1e6

class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'data':[{'id':m} for m in ['deepseek-flash','deepseek-v4-pro','gpt-6-luna']]}).encode())
    def do_POST(self):
        self.arrived_at=time.time()
        with UPSTREAM:
            self.forward()
    def forward(self):
        rid=self.path.split('/')[1]
        if rid not in ACTIVE: self.send_error(404);return
        state=ACTIVE[rid]
        # Freeze exact incoming/forwarded bytes before any reservation. Owner
        # authority comes from trusted setup, never this request or its headers.
        try:
            if OWNER is None or PROVIDER != 'deepseek': raise Unknown('owner_required')
            length=int(self.headers['Content-Length'])
            if not 0 < length <= 1024*1024: raise Unknown('request_size')
            incoming=self.rfile.read(length)
            if len(incoming) != length: raise Unknown('short_request')
            body=OWNER.parse_request(incoming)
            forwarded=json.dumps(body).encode()
        except Exception:
            self.send_error(400, 'Capture preflight refused');return
        if PROVIDER=='deepseek' and body.get('model') not in PRICING['models']:
            state['budget_stop']=True;state['stop_reason']='unpriced_model'
            self.send_error(400,'Unpriced model refused');return
        stamp=time.time()
        with LOCK:
            try:
                ticket=OWNER.preflight(rid,state['calls']+1,incoming,forwarded)
            except Exception:
                self.send_error(400, 'Capture binding refused');return
            used=spend()
            # Reserve peak-price worst-case completion + prompt per outstanding call.
            reserve=reservation(body)
            reserved=pending_reservations()
            if PROVIDER=='deepseek' and (BALANCE_SNAPSHOT is None or
                BALANCE_SNAPSHOT['balance'] - max(0, used-BALANCE_SNAPSHOT['spent']) - reserved - reserve < BALANCE_FLOOR):
                RATE_LIMITED.set();state['budget_stop']=True;state['stop_reason']='balance_floor'
                self.send_error(429,'Account balance floor reached');return
            if used+reserved+reserve>=SPEND_CAP:
                self.send_error(429,'Benchmark spend cap');state['budget_stop']=True;state['stop_reason']='spend_cap';return
            if RATE_LIMITED.is_set() or state['calls']>=MAX_CALLS:
                self.send_error(429,'Benchmark call limit');state['budget_stop']=True;state['stop_reason']='provider_subset_stop' if RATE_LIMITED.is_set() else 'call_limit';return
            state['calls']+=1; n=state['calls']
            admit_reservation(rid,n,reserve)
            state.setdefault('reserved',{})[n]=reserve
        dest=state['dir']/f'wire-{n:03}.json'
        write_json(dest,{'sent_at':stamp,'body':body})
        upstream=OPENAI_UPSTREAM if PROVIDER=='openai' else 'https://api.deepseek.com/chat/completions'
        req=urllib.request.Request(upstream,data=forwarded,headers={'Authorization':'Bearer '+(KEY if PROVIDER=='deepseek' else 'benchmark-proxy'),'Content-Type':'application/json'})
        usage={}; toolids=set();error=None
        capture=Capture(ticket)
        timing={'request_received_at':getattr(self,'arrived_at',stamp),'upstream_start_at':time.time(),
                'response_headers_at':None,'first_token_at':None,'last_token_at':None,'stream_end_at':None}
        timing['proxy_guard_seconds']=timing['upstream_start_at']-timing['request_received_at']
        try:
            with urllib.request.urlopen(req,timeout=180) as res:
                timing['response_headers_at']=time.time()
                capture.headers(res.status,res.headers.get('Content-Type'))
                self.send_response(res.status);self.send_header('Content-Type',res.headers.get('Content-Type','text/event-stream'));self.end_headers()
                chunks=[]
                for line in res:
                    chunks.append(line)
                    capture.append(line)
                    try:self.wfile.write(line);self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):capture.delivery_failed=True
                    if line.startswith(b'data: '):
                        try:
                            event=json.loads(line[6:])
                            token=any(any(c.get('delta',{}).get(k) for k in ('content','reasoning_content','tool_calls')) for c in event.get('choices',[]))
                            if token:
                                now=time.time()
                                if timing['first_token_at'] is None:timing['first_token_at']=now
                                timing['last_token_at']=now
                            if event.get('usage'):usage=event['usage']
                            if event.get('type') in ('response.completed','response.failed','response.incomplete') and event.get('response',{}).get('usage'):
                                usage=event['response']['usage']
                            item=event.get('item',{})
                            if item.get('type')=='function_call':toolids.add(item.get('call_id',item.get('id')))
                            if event.get('type') in ('error','response.failed','response.incomplete'):
                                error={'type':'upstream_event','event_type':event.get('type'),'code':event.get('code',event.get('error',{}).get('code'))}
                                if PROVIDER=='openai':RATE_LIMITED.set()
                            for c in event.get('choices',[]):
                                for t in c.get('delta',{}).get('tool_calls',[]): toolids.add(t.get('index',t.get('id')))
                        except (ValueError,TypeError):pass
                timing['stream_end_at']=time.time()
                capture.outcome='eof'
                raw=b''.join(chunks)
                if not body.get('stream'):
                    event=json.loads(raw);usage=event.get('usage',{})
                    for item in event.get('output',[]):
                        if item.get('type')=='function_call':toolids.add(item.get('call_id',item.get('id')))
                    for c in event.get('choices',[]):
                        for t in c.get('message',{}).get('tool_calls',[]):toolids.add(t.get('id'))
                capture.stage='original_response_write'
                (state['dir']/f'response-{n:03}.txt').write_bytes(raw)
        except urllib.error.HTTPError as e:
            capture.outcome='http_error';capture.status=e.code
            error={'status':e.code,'body':e.read().decode()}
            if PROVIDER=='openai' and e.code in (429,503):RATE_LIMITED.set()
            try:self.send_error(e.code)
            except OSError:pass
        except Exception as e:
            capture.outcome='original_write_error' if capture.stage=='original_response_write' else 'read_error'
            error={'type':type(e).__name__}
            try:self.send_error(502)
            except OSError:pass
        hit=usage.get('prompt_cache_hit_tokens',usage.get('prompt_tokens_details',{}).get('cached_tokens',0))
        inp=usage.get('prompt_tokens',0);out=usage.get('completion_tokens',0)
        if PROVIDER=='openai':
            inp=usage.get('input_tokens',0);out=usage.get('output_tokens',0)
            hit=usage.get('input_tokens_details',{}).get('cached_tokens',0)
        miss=usage.get('prompt_cache_miss_tokens',inp-hit)
        price=rates(body['model'],stamp) if PROVIDER=='deepseek' else None
        cost=(hit*price[0]+miss*price[1]+out*price[2])/1e6 if PROVIDER=='deepseek' else None
        budget_charge=(cost or 0) if usage or (error and 400<=error.get('status',0)<500) else reserve
        record={'run':rid,'call':n,'model':body['model'],'input_tokens':inp,'cached_tokens':hit,'uncached_tokens':miss,'output_tokens':out,'tool_calls':len(toolids),'cost_usd':cost,'cost_basis':'provider-list-rate' if PROVIDER=='deepseek' else 'subscription-unpriced','rates':price,'time':stamp,'seconds':time.time()-stamp,'error':error,'usage':usage,'budget_charge_usd':budget_charge,'usage_missing':not bool(usage) and not (error and 400<=error.get('status',0)<500)}
        record['timing']=timing
        with LOCK:
            with LEDGER.open('a') as f:
                f.write(json.dumps(record)+'\n');f.flush();os.fsync(f.fileno())
            state['records'].append(record);state['reserved'].pop(n,None)
        write_json(state['dir']/f'usage-{n:03}.json',record)
        # Optional evidence cannot skip, release, retry or modify settlement.
        try: OWNER.publish(capture)
        except Exception: pass


