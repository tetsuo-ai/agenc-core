"""Bounded optional Flash capture and trusted in-process owner publication gate.

No launcher, credential loader or external transport. Capabilities are live
object identities issued AFTER durable commits, never reconstructed from files.
Trusted caller / immutable deployment / private artifact directory required.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import threading
import uuid

HERE = Path(__file__).resolve().parent
BINDING_PIN = '513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6'
ADAPTER_PIN = 'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323'
GRADER_PIN = '7f6cfcb6115ebf118497c8ae1611094e19c31526409552585658bdfc7274c933'
MAX_REQUEST = 1024 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_METADATA = 256 * 1024


class Unknown(ValueError):
    pass


def need(ok, reason):
    if not ok:
        raise Unknown(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_size <= limit, 'artifact_size_or_type')
        with os.fdopen(os.dup(fd), 'rb') as handle:
            raw = handle.read(limit + 1)
        after = os.fstat(fd)
        current = os.stat(path, follow_symlinks=False)
        fields = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        need(fields(before) == fields(after) == fields(current) and len(raw) == before.st_size,
             'artifact_changed')
        return raw
    finally:
        os.close(fd)


def load_source(path, pin):
    raw = read_regular(path, MAX_REQUEST)
    need(sha(raw) == pin, 'source_pin_mismatch')
    namespace = {'__name__': '_flash_pinned_' + path.stem, '__file__': str(path)}
    exec(compile(raw, str(path), 'exec'), namespace)
    return namespace


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_bytes(path, raw):
    """Exclusive file + directory commit. Failure leaves evidence, never authority.

    No withdrawal is required for correctness: a surviving link on double fault
    is not a returned publication capability. Stale partial files block retry.
    """
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(fd), 'wb') as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        os.link(temporary, path, follow_symlinks=False)
        sync_directory(path.parent)
        os.unlink(temporary)
        sync_directory(path.parent)
    finally:
        os.close(fd)


class Capture:
    def __init__(self, ticket):
        self.ticket = ticket
        self.parts = []
        self.size = 0
        self.complete_write = True
        self.status = None
        self.content_type = None
        self.outcome = 'incomplete'
        self.stage = 'upstream_read'
        self.delivery_failed = False

    def headers(self, status, content_type):
        self.status = status if type(status) is int else None
        self.content_type = content_type if type(content_type) is str and len(content_type) <= 256 else None

    def append(self, raw):
        # Bounded optional capture; do not interrupt original usage/settlement.
        if not self.complete_write:
            return
        if type(raw) is not bytes or self.size + len(raw) > MAX_RESPONSE:
            self.complete_write = False
            self.parts.clear()
            return
        self.parts.append(raw)
        self.size += len(raw)


class Owner:
    """Trusted proxy-parent-only object, inaccessible to tool descendants.

    No identity/authentication is inferred from a child bearer or URL path.
    This caller must already own that per-cell route in a private loopback
    environment. Normal runner adoption and genuine parent provenance absent.
    """
    def __init__(self, *, directory, contract_bytes, expected, deployed_source_pins,
                 proxy_source_sha256, capture_source_sha256):
        need(sha(read_regular(HERE / 'proxy.py', MAX_REQUEST)) == proxy_source_sha256,
             'proxy_source_mismatch')
        need(sha(read_regular(HERE / 'capture.py', MAX_REQUEST)) == capture_source_sha256,
             'capture_source_mismatch')
        self.binding = load_source(HERE.parent / 'prompt-binding-v2/prompt_binding.py', BINDING_PIN)
        need(type(contract_bytes) is bytes and len(contract_bytes) <= MAX_METADATA, 'contract_size')
        self.contract = contract_bytes
        # Snapshot the independently supplied trusted preflight. Never mint any
        # expected digest from the incoming body under validation.
        self.expected = self.binding['parse'](encode(expected))
        self.sources = self.binding['parse'](encode(deployed_source_pins))
        need(len(encode(self.expected)) <= MAX_METADATA and len(encode(self.sources)) <= MAX_METADATA,
             'metadata_size')
        need(self.expected.get('route') == 'deepseek-proxy', 'flash_route_required')
        self.proxy_pin = proxy_source_sha256
        self.capture_pin = capture_source_sha256
        self.directory = Path(directory)
        need(self.directory.is_dir() and not self.directory.is_symlink(), 'private_directory_required')
        self._identity = object()
        self._records = {}
        self._capability = None
        self._inventory = None
        self._lock = threading.Lock()
        self._bound_first = False
        self._closed = False

    def parse_request(self, raw):
        need(type(raw) is bytes and 0 < len(raw) <= MAX_REQUEST, 'request_size')
        return self.binding['parse'](raw)

    def preflight(self, run, ordinal, incoming, forwarded):
        need(not self._closed and type(ordinal) is int and 1 <= ordinal <= 1000, 'owner_closed_or_call_invalid')
        need(run == self.expected['run_id'], 'run_mismatch')
        original = self.parse_request(incoming)
        # Exactly the serialization used by the old proxy; distinct raw hashes.
        need(forwarded == json.dumps(original).encode(), 'forwarded_bytes_mismatch')
        self.parse_request(forwarded)
        admission = dict(run_id=run, root_turn_id=self.expected['root_turn_id'], admission_id=run+':1',
                         call_ordinal=1, prior_root_generations=0, initial_request=True, request_role='root')
        if ordinal == 1:
            bound = self.binding['bind_initial_request'](request_bytes=incoming, contract_bytes=self.contract,
                expected=self.expected, admission=admission, deployed_source_pins=self.sources)
            need(bound['binding_verified'] is True, 'initial_binding_refused')
            # Independently check the actual bytes sent upstream too.
            bound = self.binding['bind_initial_request'](request_bytes=forwarded, contract_bytes=self.contract,
                expected=self.expected, admission=admission, deployed_source_pins=self.sources)
            need(bound['binding_verified'] is True, 'forwarded_binding_refused')
            self._bound_first = True
        else:
            need(self._bound_first, 'missing_first_binding')
        return (self._identity, run, ordinal, incoming, forwarded)

    def publish(self, capture):
        with self._lock:
            need(not self._closed, 'publication_after_close')
            token, run, ordinal, incoming, forwarded = capture.ticket
            need(token is self._identity and run == self.expected['run_id'] and ordinal not in self._records,
                 'foreign_or_duplicate_ticket')
            need(capture.complete_write, 'optional_capture_overflow')
            raw = b''.join(capture.parts)
            need(len(raw) == capture.size <= MAX_RESPONSE, 'capture_size_mismatch')
            receipt = dict(schema_version=1, protocol_id=self.expected['protocol_id'], run_id=run,
                root_turn_id=self.expected['root_turn_id'], call_ordinal=ordinal, admission_id=f'{run}:{ordinal}',
                route='deepseek-proxy', source='provider_response_sse', initial_request=ordinal == 1,
                incoming_sha256=sha(incoming), forwarded_sha256=sha(forwarded), response_sha256=sha(raw),
                response_byte_count=len(raw), http_status=capture.status, content_type=capture.content_type,
                requested_stream=self.parse_request(forwarded).get('stream') is True,
                transport_outcome=capture.outcome, downstream_delivery_failed=capture.delivery_failed,
                capture_write_complete=True, proxy_source_sha256=self.proxy_pin, capture_source_sha256=self.capture_pin,
                adapter_sha256=ADAPTER_PIN, binding_sha256=BINDING_PIN,
                contract_sha256=sha(self.contract), task_prompt_sha256=self.expected['task_prompt_sha256'])
            artifacts = {f'incoming-{ordinal:03}.json': incoming, f'forwarded-{ordinal:03}.json': forwarded,
                         f'output-{ordinal:03}.sse': raw, f'capture-{ordinal:03}.json': encode(receipt)}
            for name, data in artifacts.items():
                publish_bytes(self.directory / name, data)
            # Independent success acknowledgment exists only AFTER every fsync.
            self._records[ordinal] = {name: sha(data) for name, data in artifacts.items()}

    def finalize(self, *, admitted_calls, owner_quiescent):
        with self._lock:
            need(not self._closed, 'owner_already_closed')
            self._closed = True  # no retries or late publication after an ambiguous commit
            need(owner_quiescent is True and type(admitted_calls) is int and 1 <= admitted_calls <= 1000,
                 'owner_not_quiescent')
            need(set(self._records) == set(range(1, admitted_calls + 1)), 'missing_publication_ack')
            inventory = dict(schema_version=1, run_id=self.expected['run_id'], finalized=True,
                admitted_calls=admitted_calls, proxy_source_sha256=self.proxy_pin,
                capture_source_sha256=self.capture_pin, publications=self._records)
            raw = encode(inventory)
            publish_bytes(self.directory / 'publication-inventory.json', raw)
            self._inventory = raw
            self._capability = object()
            return self._capability

    def score(self, capability, *, planning_required, code_artifact_pass, normal_exit, timed_out, budget_stopped):
        grader = load_source(HERE.parent / 'protocol.py', GRADER_PIN)
        original = dict(code_artifact_pass=code_artifact_pass, normal_exit=normal_exit,
                        timed_out=timed_out, budget_stopped=budget_stopped)
        invalid = any(value is not None and type(value) is not bool for value in original.values())
        original = {key: value if value is None or type(value) is bool else None for key,value in original.items()}
        plan = None
        result = dict(capture_verified=False, binding_verified=None, evidence_unknown_reason=None,
                      adapter_sha256=ADAPTER_PIN, grader_sha256=GRADER_PIN, **original)
        try:
            need(type(planning_required) is bool and not invalid, 'invalid_outcome_type')
            if planning_required:
                need(capability is not None and capability is self._capability and self._inventory is not None,
                     'missing_trusted_commit_capability')
                need(read_regular(self.directory / 'publication-inventory.json', MAX_REQUEST) == self._inventory,
                     'inventory_changed')
                # Only exact call one, never later successful captures.
                artifacts = {name: read_regular(self.directory / name, MAX_RESPONSE)
                             for name in self._records[1]}
                need(all(sha(artifacts[name]) == digest for name,digest in self._records[1].items()),
                     'artifact_hash_mismatch')
                receipt = self.binding['parse'](artifacts['capture-001.json'])
                need(receipt['http_status'] == 200 and type(receipt['http_status']) is int
                     and type(receipt['content_type']) is str
                     and receipt['content_type'].split(';')[0].strip().lower() == 'text/event-stream'
                     and receipt['transport_outcome'] == 'eof'
                     and receipt['requested_stream'] is True and receipt['capture_write_complete'] is True
                     and receipt['downstream_delivery_failed'] is False, 'incomplete_transport_or_delivery')
                admission = dict(run_id=self.expected['run_id'],root_turn_id=self.expected['root_turn_id'],
                    admission_id=self.expected['run_id']+':1',call_ordinal=1,prior_root_generations=0,
                    initial_request=True,request_role='root')
                for name in ('incoming-001.json','forwarded-001.json'):
                    bound = self.binding['bind_initial_request'](request_bytes=artifacts[name], contract_bytes=self.contract,
                        expected=self.expected, admission=admission, deployed_source_pins=self.sources)
                    need(bound['binding_verified'] is True, 'binding_unverified')
                adapter = load_source(HERE.parent / 'stream_adapters.py', ADAPTER_PIN)
                adapted = adapter['adapt_chat_completions'](artifacts['output-001.sse'],
                    adapter_sha256=ADAPTER_PIN,capture_complete=True,source='provider_response_sse')
                plan = grader['visible_plan_score'](adapted)
                result.update(capture_verified=True,binding_verified=True)
                if adapted.get('complete') is not True:
                    result['evidence_unknown_reason'] = 'adapter_capture_unknown'
        except Unknown as error:
            result['evidence_unknown_reason'] = str(error)
        except Exception:
            result['evidence_unknown_reason'] = 'capture_evidence_unknown'
        result.update(grader['score_cell'](**original, planning_required=planning_required is True, plan=plan))
        if type(planning_required) is not bool:
            result['requested_format_contract_pass'] = None
        return result
