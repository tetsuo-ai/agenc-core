#!/usr/bin/env python3
"""Credential-local Responses API bridge over an outbound SSH stdio channel.

Mac: relay reads SOL_PROXY_BEARER from its environment and opens no listener.
Linux: serve opens only a loopback listener and never receives that bearer.
No provider request is made until a client submits an allowed HTTP request.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import http.server
import json
import os
import queue
import shlex
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import urllib.parse
import uuid
import time
from pathlib import Path

PROXY = 'http://127.0.0.1:8799'
MODEL = 'gpt-6-sol'
MAX_BODY = 8 * 1024 * 1024
MAX_FRAME = 12 * 1024 * 1024
TIMEOUT = 180
MAX_RESPONSE_BYTES = 512 * 1024


def encode(data):
    return base64.b64encode(data).decode('ascii')


def decode(data):
    return base64.b64decode(data, validate=True)


def read_frame(stream):
    line = stream.readline(MAX_FRAME + 1)
    if not line:
        return None
    if len(line) > MAX_FRAME or not line.endswith(b'\n'):
        raise ValueError('invalid frame size')
    frame = json.loads(line)
    if not isinstance(frame, dict) or frame.get('v') != 1:
        raise ValueError('invalid frame version')
    return frame


class Frames:
    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()

    def send(self, **frame):
        data = json.dumps({'v': 1, **frame}, separators=(',', ':')).encode() + b'\n'
        if len(data) > MAX_FRAME:
            raise ValueError('frame too large')
        with self.lock:
            self.stream.write(data)
            self.stream.flush()


def validate_request(method, path, body):
    if method == 'GET' and path in ('/v1/models', '/v1/proxy-health'):
        if body:
            raise ValueError('GET body rejected')
        return
    if method != 'POST' or path != '/v1/responses':
        raise ValueError('route rejected')
    if len(body) > MAX_BODY:
        raise ValueError('body too large')
    request = json.loads(body)
    if not isinstance(request, dict) or request.get('model') != MODEL:
        raise ValueError('model must be gpt-6-sol')
    if not isinstance(request.get('reasoning'), dict) or request['reasoning'].get('effort') != 'low':
        raise ValueError('reasoning effort must be low')
    if not isinstance(request.get('input'), list):
        raise ValueError('Responses input must be a list')


class Redactor:
    """Prevent even an unexpected echoed bearer crossing chunk boundaries."""
    def __init__(self, secret):
        self.secret = secret
        self.pending = b''

    def feed(self, chunk, final=False):
        self.pending = (self.pending + chunk).replace(self.secret, b'[REDACTED]')
        hold = 0 if final else len(self.secret) - 1
        count = max(0, len(self.pending) - hold)
        out, self.pending = self.pending[:count], self.pending[count:]
        return out


def send_error(frames, request_id, status, code):
    payload = json.dumps({'error': {'type': 'sol_bridge_error', 'code': code}}).encode()
    frames.send(type='response', id=request_id, status=status, content_type='application/json')
    frames.send(type='chunk', id=request_id, data=encode(payload))
    frames.send(type='done', id=request_id)


def forward_on_mac(frame, frames, bearer):
    """The sole HTTP client. Fixed origin; caller headers are never forwarded."""
    request_id = frame.get('id')
    started = False
    try:
        method, path = frame['method'], frame['path']
        body = decode(frame.get('body', ''))
        validate_request(method, path, body)
        request = urllib.request.Request(
            PROXY + path, data=body if method == 'POST' else None, method=method,
            headers={'Authorization': 'Bearer ' + bearer,
                     'Content-Type': 'application/json', 'Accept': 'text/event-stream'},
        )
        # Disable environment proxy settings: the credential can only go to localhost.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            response = opener.open(request, timeout=TIMEOUT)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            frames.send(type='response', id=request_id, status=response.code,
                        content_type=response.headers.get('Content-Type', 'application/octet-stream'))
            started = True
            scrub = Redactor(bearer.encode())
            read = getattr(response, 'read1', response.read)
            while True:
                chunk = read(65536)
                if not chunk:
                    break
                chunk = scrub.feed(chunk)
                if chunk:
                    frames.send(type='chunk', id=request_id, data=encode(chunk))
            tail = scrub.feed(b'', final=True)
            if tail:
                frames.send(type='chunk', id=request_id, data=encode(tail))
            frames.send(type='done', id=request_id)
    except Exception as error:
        # Exception text may contain headers/body. Only a type crosses this boundary.
        if started:
            frames.send(type='error', id=request_id, code=type(error).__name__)
        else:
            send_error(frames, request_id, 502, type(error).__name__)


def bounded_forward(frame, frames, bearer, *, max_seconds=TIMEOUT,
                    max_response_bytes=MAX_RESPONSE_BYTES, proxy=PROXY):
    """An owned child makes HTTP; its hard deadline bounds even endless bytes.

    A socket idle timeout cannot stop a response that streams whitespace
    forever. Killing this one request's child also bounds DNS/header reads.
    The bearer is present only in that local child's environment, never SSH.
    """
    environment=os.environ.copy()
    environment.update(SOL_PROXY_BEARER=bearer,SOL_PROXY_ORIGIN=proxy)
    process=subprocess.Popen([sys.executable,__file__,'forward-worker'],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=environment)
    expired=threading.Event();started=False;count=0;done=False
    def terminate():
        expired.set()
        if process.poll() is None:process.terminate()
    timer=threading.Timer(max_seconds,terminate);timer.daemon=True;timer.start()
    try:
        Frames(process.stdin).send(**{k:v for k,v in frame.items() if k!='v'})
        process.stdin.close()
        while (reply:=read_frame(process.stdout)) is not None:
            if expired.is_set():break
            if reply.get('id')!=frame.get('id'):raise ValueError('wrong response identity')
            if reply.get('type')=='chunk':
                count+=len(decode(reply['data']))
                if count>max_response_bytes:
                    if process.poll() is None:process.terminate()
                    raise OverflowError('response byte budget exceeded')
            if reply.get('type')=='response':started=True
            if reply.get('type')=='done':done=True
            frames.send(**{k:v for k,v in reply.items() if k!='v'})
        if expired.is_set():raise TimeoutError('absolute request deadline')
        if not done:raise OSError('request worker ended without terminal frame')
    except Exception as error:
        code='request_duration_limit' if expired.is_set() else 'response_byte_limit' if isinstance(error,OverflowError) else type(error).__name__
        if started:frames.send(type='error',id=frame.get('id'),code=code)
        else:send_error(frames,frame.get('id'),502,code)
    finally:
        timer.cancel()
        if process.poll() is None:process.terminate()
        try:process.wait(timeout=2)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        process.stdout.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LinuxBridge(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, frames):
        self.frames = frames
        self.pending = {}
        self.pending_lock = threading.Lock()
        self.capacity = threading.BoundedSemaphore(1)
        super().__init__(('127.0.0.1', port), Handler)

    def disconnect(self):
        with self.pending_lock:
            for channel in self.pending.values():
                channel.put({'type': 'error', 'code': 'transport_closed'})
        self.shutdown()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        if not self.server.capacity.acquire(blocking=False):
            self.send_error(429, 'Bridge concurrency limit')
            return
        request_id = uuid.uuid4().hex
        channel = queue.Queue()
        started = False
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= MAX_BODY:
                self.send_error(413)
                return
            body = self.rfile.read(size)
            try:
                validate_request(self.command, self.path, body)
            except (ValueError, TypeError):
                self.send_error(400, 'Only GPT-6 Luna Low Responses requests are allowed')
                return
            with self.server.pending_lock:
                self.server.pending[request_id] = channel
            # Authorization and all other incoming headers stop on Linux.
            self.server.frames.send(type='request', id=request_id, method=self.command,
                                    path=self.path, body=encode(body))
            while True:
                frame = channel.get(timeout=TIMEOUT + 15)
                kind = frame['type']
                if kind == 'response':
                    if started:
                        raise ValueError('duplicate response')
                    self.send_response(int(frame['status']))
                    self.send_header('Content-Type', frame.get('content_type', 'application/octet-stream'))
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    started = True
                elif kind == 'chunk':
                    if not started:
                        raise ValueError('chunk before response')
                    self.wfile.write(decode(frame['data']))
                    self.wfile.flush()
                elif kind == 'done':
                    if not started:
                        raise ValueError('done before response')
                    return
                elif kind == 'error':
                    raise OSError('transport failure')
        except (OSError, ValueError, queue.Empty):
            if not started:
                try:
                    self.send_error(502, 'Sol bridge transport unavailable')
                except OSError:
                    pass
        finally:
            self.close_connection = True
            with self.server.pending_lock:
                self.server.pending.pop(request_id, None)
            self.server.capacity.release()


def serve(args):
    if sys.platform != 'linux':
        raise RuntimeError('The listener is allowed only on Linux')
    frames = Frames(sys.stdout.buffer)
    server = LinuxBridge(args.port, frames)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    frames.send(type='ready', url=f'http://127.0.0.1:{server.server_port}/v1', pid=os.getpid())
    try:
        while (frame := read_frame(sys.stdin.buffer)) is not None:
            if frame.get('type') not in ('response', 'chunk', 'done', 'error'):
                raise ValueError('unexpected incoming frame')
            with server.pending_lock:
                channel = server.pending.get(frame.get('id'))
            if channel is not None:
                channel.put(frame)
    finally:
        server.disconnect()
        server.server_close()
        thread.join(timeout=5)


def relay(args):
    if sys.platform != 'darwin':
        raise RuntimeError('Credential relay is allowed only on the Mac')
    bearer = os.environ.pop('SOL_PROXY_BEARER', '').strip()
    if not bearer or '\n' in bearer or '\r' in bearer:
        raise RuntimeError('Set SOL_PROXY_BEARER in the Mac process environment')
    remote = ['python3', args.remote_script, 'serve', '--port', str(args.port)]
    ssh = ['ssh', '-i', args.ssh_key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
           '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
           args.ssh_host, shlex.join(remote)]
    # The bearer was removed before spawning SSH, so it cannot enter that process.
    proc = subprocess.Popen(ssh, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    frames = Frames(proc.stdin)
    capacity = threading.BoundedSemaphore(1)
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    admissions = Path('/private/tmp/light-models/evidence/sol-relay-admissions.jsonl')
    requests = len(admissions.read_text().splitlines()) if admissions.exists() else 0
    def worker(frame):
        try:
            bounded_forward(frame, frames, bearer,max_seconds=args.request_seconds,
                            max_response_bytes=args.response_bytes,proxy=args.proxy)
        finally:
            capacity.release()
    def stop(signum, frame):
        raise KeyboardInterrupt
    previous = signal.signal(signal.SIGTERM, stop)
    try:
        while (frame := read_frame(proc.stdout)) is not None:
            if frame.get('type') == 'ready':
                # Only connection metadata is printed; no model content or credential.
                print(json.dumps({'bridge_url': frame['url'], 'linux_pid': frame['pid'],
                                  'model': MODEL, 'reasoning_effort': 'low'}), flush=True)
            elif frame.get('type') == 'request':
                if frame.get('method') == 'POST':
                    if requests >= args.max_requests:
                        send_error(frames, frame.get('id'), 429, 'confirmatory_call_limit')
                        continue
                    requests += 1
                    with admissions.open('a') as log:
                        log.write(json.dumps({'ordinal':requests,'id':frame.get('id'),'time':time.time()})+'\n');log.flush();os.fsync(log.fileno())
                if not capacity.acquire(blocking=False):
                    send_error(frames, frame.get('id'), 429, 'concurrency_limit')
                    continue
                pool.submit(worker, frame)
            else:
                raise ValueError('unexpected remote frame')
    finally:
        signal.signal(signal.SIGTERM, previous)
        proc.stdin.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        pool.shutdown(wait=True, cancel_futures=True)


def self_test():
    """Linux-only, no credentials and no provider calls; fake framed responses."""
    if sys.platform != 'linux':
        raise RuntimeError('Tests run only on Linux')
    import io
    test_secret = b'fixture-only-value'
    scrub = Redactor(test_secret)
    assert scrub.feed(b'prefix fixture-') + scrub.feed(b'only-value suffix', final=True) == b'prefix [REDACTED] suffix'
    output = io.BytesIO(); Frames(output).send(type='done', id='test')
    assert read_frame(io.BytesIO(output.getvalue()))['type'] == 'done'
    assert read_frame(io.BytesIO(b'')) is None
    body = json.dumps({'model': MODEL, 'reasoning': {'effort': 'low'}, 'input': [], 'stream': True}).encode()
    validate_request('POST', '/v1/responses', body)
    for invalid in (body.replace(b'low', b'high'), body.replace(MODEL.encode(), b'other'), b'{"input":"text"}'):
        try:
            validate_request('POST', '/v1/responses', invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid request accepted')
    proc = subprocess.Popen([sys.executable, __file__, 'serve', '--port', '0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        ready = read_frame(proc.stdout); assert ready['type'] == 'ready'
        def client():
            request = urllib.request.Request(ready['url'] + '/responses', data=body,
                      headers={'Authorization': 'Bearer client-dummy', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(client)
            request = read_frame(proc.stdout)
            assert request['type'] == 'request' and decode(request['body']) == body
            assert 'headers' not in request and b'client-dummy' not in json.dumps(request).encode()
            frames = Frames(proc.stdin); rid = request['id']
            frames.send(type='response', id=rid, status=200, content_type='text/event-stream')
            frames.send(type='chunk', id=rid, data=encode(b'data: {"ok":'))
            frames.send(type='chunk', id=rid, data=encode(b'true}\n\n'))
            frames.send(type='done', id=rid)
            assert result.result(timeout=10) == (200, b'data: {"ok":true}\n\n')
        proc.stdin.close(); assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.terminate(); proc.wait(timeout=5)
    print(json.dumps({'self_test': 'pass', 'provider_calls': 0, 'credential_reads': 0}))


def main():
    global PROXY
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    server = modes.add_parser('serve'); server.add_argument('--port', type=int, default=8809)
    local = modes.add_parser('relay')
    local.add_argument('--ssh-host', required=True)
    local.add_argument('--ssh-key', required=True)
    local.add_argument('--remote-script', required=True)
    local.add_argument('--proxy',default=PROXY,help='Existing HTTP loopback proxy; never started or reconfigured')
    local.add_argument('--port', type=int, default=8809)
    local.add_argument('--max-requests', type=int, default=40)
    local.add_argument('--request-seconds',type=float,default=TIMEOUT)
    local.add_argument('--response-bytes',type=int,default=MAX_RESPONSE_BYTES)
    modes.add_parser('self-test')
    modes.add_parser('forward-worker',help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.mode == 'serve': serve(args)
    elif args.mode == 'relay':
        origin=urllib.parse.urlparse(args.proxy)
        if origin.scheme!='http' or origin.hostname not in ('127.0.0.1','localhost','::1') or origin.username or origin.password or origin.path not in ('','/') or origin.query or origin.fragment:
            raise ValueError('Proxy origin must be credential-free HTTP loopback')
        if not 0<args.request_seconds<=TIMEOUT or not 0<args.response_bytes<=10*1024*1024 or not 1<=args.max_requests<=600:
            raise ValueError('Invalid confirmatory request limits')
        args.proxy=args.proxy.rstrip('/')
        relay(args)
    elif args.mode == 'forward-worker':
        if sys.platform!='darwin':raise RuntimeError('Credential request worker is allowed only on Mac')
        PROXY=os.environ.pop('SOL_PROXY_ORIGIN')
        bearer=os.environ.pop('SOL_PROXY_BEARER')
        frame=read_frame(sys.stdin.buffer)
        forward_on_mac(frame,Frames(sys.stdout.buffer),bearer)
    else: self_test()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        # Never interpolate exceptions which may contain request data or headers.
        print(json.dumps({'bridge_error': type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
