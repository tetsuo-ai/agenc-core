import fcntl
import json
import pathlib
import multiprocessing
import os
import tempfile
import unittest
from unittest.mock import patch

import resolve_stop as subject


class AcknowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='luna-resolution-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        (self.root/'locks').mkdir()
        self.run = 'old-luna-task-light-r1'
        self.run_dir = self.root/'runs'/self.run
        self.run_dir.mkdir(parents=True)
        self.guard = self.root/'synthetic-guard.txt'
        self.guard.write_bytes(b'Synthetic fixture, not an approved live guard.')
        self.guard_hash = subject.digest(self.guard.read_bytes())
        self.approved = patch.object(subject, 'REVIEWED_PRESEND_GUARDS', frozenset([self.guard_hash]))
        self.approved.start()
        self.addCleanup(self.approved.stop)
        self.fix_validation = self.root/'synthetic-fix-validation.json'
        self.fix_validation.write_bytes(subject.encoded({'fix_sha': '2'*40,
            'fixed_policy_validated': True, 'provider_calls': 0, 'configuration_sha256': 'a'*64}))
        self.fix_approved = patch.object(subject, 'REVIEWED_FIX_VALIDATIONS', {
            '2'*40: subject.digest(self.fix_validation.read_bytes())})
        self.fix_approved.start()
        self.addCleanup(self.fix_approved.stop)
        self.stop = self.root/'luna-api-stop.json'
        self.stop.write_bytes(subject.encoded({'reason': subject.REASON, 'run': self.run, 'time': 1}))
        self.usage = {'run': self.run, 'call': 1, 'usage_missing': False, 'error': None,
                      'usage': {'input_tokens': 10, 'output_tokens': 2},
                      'input_tokens': 10, 'output_tokens': 2, 'cached_tokens': 0, 'uncached_tokens': 10,
                      'cost_usd': .01, 'budget_charge_usd': .01}
        (self.run_dir/'usage-001.json').write_bytes(subject.encoded(self.usage))
        (self.run_dir/'wire-001.json').write_bytes(subject.encoded({'body': {
            'model': 'gpt-6-luna', 'reasoning': {'effort': 'low'}, 'max_output_tokens': 8192, 'stream': True}}))
        (self.run_dir/'response-001.txt').write_bytes(b'data: '+json.dumps({
            'type': 'response.completed', 'response': {'status': 'completed', 'usage': self.usage['usage']}}).encode()+b'\n\n')
        self.rows = [
            {'event': 'admit', 'id': 'historical:1', 'run': 'historical', 'call': 1, 'reserve': 123},
            {'event': 'admit', 'id': self.run+':1', 'run': self.run, 'call': 1, 'reserve': .5},
            {'event': 'settle', 'id': self.run+':1', **self.usage},
        ]
        self.ledger = self.root/'luna-api-ledger.jsonl'
        self.write_ledger()
        self.spend = self.root/'spend.jsonl'
        self.spend.write_bytes(b'{"historical_reserve":123}\n')
        for name in ('spend-luna.jsonl', 'spend-deepseek.jsonl', 'deepseek-reservations.jsonl'):
            (self.root/name).write_bytes(b'{"historical_hold":456}\n')
        self.result = {'id': self.run, 'provider': 'openai', 'model': 'gpt-6-luna',
                       'phase': 'old', 'agent_revision': '1'*40, 'budget_stop': True,
                       'stop_reason': subject.REASON, 'usage_complete': True,
                       'provider_errors': 0, 'timeout': False, 'pass': False, 'model_calls': 1,
                       'input_tokens': 10, 'output_tokens': 2, 'cached_tokens': 0, 'uncached_tokens': 10,
                       'cost_usd': .01, 'budget_charge_usd': .01,
                       'provenance': {'harness_files_sha256': {'direct.mjs': self.guard_hash}}}
        self.write_result()
        self.preflight = self.root/'provenance-new-openai.json'
        self.preflight.write_bytes(subject.encoded({'candidate_revision': '2'*40, 'phase': 'new',
            'provider': 'openai', 'light_adaptive_effort': False, 'light_adaptive_high': False,
            'reasoning_effort': 'low', 'output_cap': 8192, 'configuration_sha256': 'a'*64,
            'reasoning_settings_by_agent': {'light': {'light_reasoning_policy': 'fixed', 'reasoning_effort': 'low'}}}))
        self.fix_validation.write_bytes(subject.encoded({'fix_sha': '2'*40,
            'fixed_policy_validated': True, 'provider_calls': 0, 'configuration_sha256': 'a'*64,
            'fresh_phase': 'new', 'fresh_provenance_sha256': subject.digest(self.preflight.read_bytes())}))
        subject.REVIEWED_FIX_VALIDATIONS['2'*40] = subject.digest(self.fix_validation.read_bytes())
        self.kwargs = {'expected_stop_sha256': subject.digest(self.stop.read_bytes()),
                       'expected_run': self.run, 'fix_sha': '2'*40, 'fresh_phase': 'new',
                       'authority_id': 'fixture-authorized-review', 'reviewed_guard_path': self.guard,
                       'fix_validation_path': self.fix_validation,
                       'expected_fresh_provenance_sha256': subject.digest(self.preflight.read_bytes()),
                       'explicitly_authorized': True}
        self.before = {self.ledger: self.ledger.read_bytes(), self.spend: self.spend.read_bytes(),
                       self.run_dir/'result.json': (self.run_dir/'result.json').read_bytes()}
        self.before.update({p: p.read_bytes() for p in self.root.glob('*.jsonl')})

    def write_ledger(self):
        self.ledger.write_bytes(b''.join(subject.encoded(row).replace(b'\n', b'')+b'\n' for row in self.rows))

    def write_result(self):
        (self.run_dir/'result.json').write_bytes(subject.encoded(self.result))

    def call(self, **extra):
        return subject.acknowledge_presend_stop(self.root, **{**self.kwargs, **extra})

    def assert_historical_unchanged(self):
        for path, data in self.before.items():
            self.assertEqual(path.read_bytes(), data)

    def approve_aliases(self, aliases):
        validation = json.loads(self.fix_validation.read_bytes())
        validation['reviewed_journal_aliases'] = aliases
        self.fix_validation.write_bytes(subject.encoded(validation))
        subject.REVIEWED_FIX_VALIDATIONS['2'*40] = subject.digest(self.fix_validation.read_bytes())

    def create_reviewed_alias(self):
        alias = self.root/'spend-deepseek.jsonl'
        target = self.root/'spend-converged-guard-v2.jsonl'
        alias.rename(target)
        alias.symlink_to(target.name)
        self.approve_aliases({alias.name: target.name})
        return alias, target

    def test_exact_reviewed_alias_preserved_and_durably_recorded(self):
        alias, target = self.create_reviewed_alias()
        before = subject.journal_snapshot(self.root, {alias.name: target.name})
        self.call()
        self.assertEqual(subject.journal_snapshot(self.root, {alias.name: target.name}), before)
        folder = self.root/'stop-resolutions'/self.kwargs['expected_stop_sha256']
        for name in ('prepared.json', 'completed.json'):
            receipt = json.loads((folder/name).read_bytes())
            self.assertEqual(receipt['reviewed_journal_aliases'], {alias.name: target.name})
            self.assertEqual(receipt['journal_snapshots'], before)
            self.assertEqual(receipt['journal_snapshots'][alias.name]['sha256'], subject.digest(target.read_bytes()))
        self.assert_historical_unchanged()

    def test_unreviewed_alias_refused_before_admission_barrier(self):
        self.create_reviewed_alias()
        self.approve_aliases({})
        with self.assertRaisesRegex(subject.Refusal, 'aliases do not match'): self.call()
        self.assertTrue(self.stop.exists())
        self.assertFalse((self.root/'luna-api-admission.lock').exists())

    def test_unused_or_unsupported_alias_mapping_refused(self):
        for mapping in [
                {'spend-deepseek.jsonl': 'spend-converged-guard-v2.jsonl'},
                {'unknown.jsonl': 'spend.jsonl'},
                {'spend-deepseek.jsonl': '/tmp/external.jsonl'},
                {'spend-deepseek.jsonl': '../outside.jsonl'},
                {'spend-deepseek.jsonl': 'nested/file.jsonl'},
                {'spend-deepseek.jsonl': 'spend-deepseek.jsonl'}, [], None]:
            with self.subTest(mapping=mapping):
                self.approve_aliases(mapping)
                with self.assertRaises(subject.Refusal): self.call()
                self.assertFalse((self.root/'luna-api-admission.lock').exists())

    def test_wrong_link_text_and_chained_alias_refused(self):
        alias, target = self.create_reviewed_alias()
        alias.unlink()
        alias.symlink_to(str(target))
        with self.assertRaisesRegex(subject.Refusal, 'alias target changed'): self.call()
        alias.unlink()
        alias.symlink_to(target.name)
        target.unlink()
        target.symlink_to('spend.jsonl')
        with self.assertRaisesRegex(subject.Refusal, 'aliases do not match'): self.call()
        self.assertFalse((self.root/'luna-api-admission.lock').exists())

    def assert_alias_swap_refused(self, boundary, swap_target):
        alias, target = self.create_reviewed_alias()
        write = subject.write_new
        def swapping_write(path, data):
            write(path, data)
            if path.name == boundary:
                changed = target if swap_target else alias
                # Keep the former inode allocated; identical bytes/text are not sufficient.
                changed.rename(self.root/'retained-old-inode')
                if swap_target:
                    target.write_bytes((self.root/'retained-old-inode').read_bytes())
                else:
                    alias.symlink_to(target.name)
        with patch.object(subject, 'write_new', swapping_write):
            with self.assertRaisesRegex(subject.Refusal, 'evidence changed'): self.call()
        self.assertTrue((self.root/'luna-api-admission.lock').is_dir())
        self.assert_historical_unchanged()

    def test_same_text_alias_swap_before_archive_refused(self):
        self.assert_alias_swap_refused('acknowledgement-owner.json', False)

    def test_same_text_alias_swap_before_rename_refused(self):
        self.assert_alias_swap_refused('prepared.json', False)

    def test_same_text_alias_swap_before_unlock_refused(self):
        self.assert_alias_swap_refused('completed.json', False)

    def test_same_bytes_target_swap_before_archive_refused(self):
        self.assert_alias_swap_refused('acknowledgement-owner.json', True)

    def test_same_bytes_target_swap_before_rename_refused(self):
        self.assert_alias_swap_refused('prepared.json', True)

    def test_same_bytes_target_swap_before_unlock_refused(self):
        self.assert_alias_swap_refused('completed.json', True)

    def test_success_archives_before_retiring_preserves_unknown_history_and_is_idempotent(self):
        original = self.stop.read_bytes()
        rename = subject.os.rename
        def checked_rename(source, target):
            self.assertEqual((target.parent/'original-stop.json').read_bytes(), original)
            prepared = json.loads((target.parent/'prepared.json').read_bytes())
            self.assertEqual(prepared['status'], 'prepared_presend_acknowledgement')
            self.assertEqual(prepared['historical_other_unsettled_reservations'], 1)
            rename(source, target)
        with patch.object(subject.os, 'rename', checked_rename):
            self.assertEqual(self.call()['status'], 'acknowledged_presend_only')
        self.assertFalse(self.stop.exists())
        self.assertFalse((self.root/'luna-api-admission.lock').exists())
        folder = self.root/'stop-resolutions'/self.kwargs['expected_stop_sha256']
        self.assertEqual((folder/'retired-stop.json').read_bytes(), original)
        self.assertEqual(self.call()['status'], 'already_acknowledged')
        self.assert_historical_unchanged()

    def test_explicit_authority_and_historical_source_review_required(self):
        with self.assertRaises(subject.Refusal): self.call(explicitly_authorized=False)
        with patch.object(subject, 'REVIEWED_PRESEND_GUARDS', frozenset()):
            with self.assertRaisesRegex(subject.Refusal, 'no reviewed'): self.call()
        self.assertTrue(self.stop.exists())

    def test_all_other_stop_reasons_refused(self):
        for reason in ['billing_error', 'fetch_error', 'stream_error', 'http_503', 'upstream_event', 'task_call_cap', 'unknown']:
            with self.subTest(reason=reason):
                self.stop.write_bytes(subject.encoded({'run': self.run, 'reason': reason, 'time': 1}))
                with self.assertRaises(subject.Refusal):
                    self.call(expected_stop_sha256=subject.digest(self.stop.read_bytes()))
                self.assertTrue(self.stop.exists())
        self.assert_historical_unchanged()

    def test_expected_hash_run_and_fix_mismatch_refused(self):
        for args in [{'expected_stop_sha256': '0'*64}, {'expected_run': 'different'},
                     {'fix_sha': '1'*40}, {'fix_sha': 'bad'}]:
            with self.subTest(args=args), self.assertRaises(subject.Refusal): self.call(**args)
        self.assertTrue(self.stop.exists())

    def test_provider_flock_and_admission_lock_refused(self):
        with (self.root/'locks'/'openai.lock').open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(subject.Refusal, 'runner is active'): self.call()
        (self.root/'luna-api-admission.lock').mkdir()
        with self.assertRaisesRegex(subject.Refusal, 'admission lock'): self.call()
        self.assertTrue(self.stop.exists())

    def test_unsettled_stopped_run_refused_without_cancelling_historical_holds(self):
        self.rows.pop()
        self.write_ledger()
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(subject.Refusal, 'not fully settled'): self.call()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertTrue(self.stop.exists())

    def test_missing_usage_errors_and_conservative_hold_refused(self):
        original = dict(self.rows[-1])
        for change in [{'usage_missing': True}, {'error': {'type': 'transport'}},
                       {'usage': {}}, {'cost_usd': None}, {'budget_charge_usd': .5}]:
            with self.subTest(change=change):
                self.rows[-1] = {**original, **change}
                self.write_ledger()
                with self.assertRaisesRegex(subject.Refusal, 'unknown usage'): self.call()
                self.assertTrue(self.stop.exists())

    def test_guard_provenance_and_usage_file_disagreement_refused(self):
        self.result['provenance']['harness_files_sha256']['direct.mjs'] = '0'*64
        self.write_result()
        with self.assertRaisesRegex(subject.Refusal, 'provenance mismatch'): self.call()
        self.result['provenance']['harness_files_sha256']['direct.mjs'] = self.guard_hash
        self.write_result()
        altered = {**self.usage, 'input_tokens': 11, 'uncached_tokens': 11,
                   'usage': {'input_tokens': 11, 'output_tokens': 2}}
        (self.run_dir/'usage-001.json').write_bytes(subject.encoded(altered))
        with self.assertRaisesRegex(subject.Refusal, 'disagree'): self.call()

    def test_old_or_preexisting_fresh_phase_refused(self):
        with self.assertRaises(subject.Refusal): self.call(fresh_phase='old')
        (self.root/'runs'/'new-other-run').mkdir()
        with self.assertRaisesRegex(subject.Refusal, 'already attempted'): self.call()

    def test_extra_wire_for_unadmitted_call_refused(self):
        (self.run_dir/'wire-002.json').write_bytes(b'{}')
        with self.assertRaisesRegex(subject.Refusal, 'unadmitted'): self.call()
        self.assertTrue(self.stop.exists())

    def test_archive_or_evidence_io_failure_keeps_active_stop(self):
        with patch.object(subject, 'write_new', side_effect=OSError('simulated write failure')):
            with self.assertRaises(OSError): self.call()
        self.assertTrue(self.stop.exists())
        self.assert_historical_unchanged()
        with self.assertRaisesRegex(subject.Refusal, 'admission lock'): self.call()

    def test_failure_after_rename_restores_marker_without_touching_ledgers(self):
        write = subject.write_new
        def failing_write(path, data):
            if path.name == 'completed.json': raise OSError('simulated completion fsync failure')
            return write(path, data)
        with patch.object(subject, 'write_new', failing_write):
            with self.assertRaises(OSError): self.call()
        self.assertEqual(subject.digest(self.stop.read_bytes()), self.kwargs['expected_stop_sha256'])
        self.assert_historical_unchanged()

    def test_new_stop_on_idempotent_call_is_never_removed(self):
        self.call()
        newer = subject.encoded({'run': 'newer', 'reason': 'billing_error', 'time': 2})
        self.stop.write_bytes(newer)
        with self.assertRaisesRegex(subject.Refusal, 'hash mismatch'): self.call()
        self.assertEqual(self.stop.read_bytes(), newer)

    def test_stop_swap_at_rename_is_detected_and_actual_new_stop_restored(self):
        rename = subject.os.rename
        newer = subject.encoded({'run': 'newer', 'reason': 'billing_error', 'time': 2})
        def swapping_rename(source, target):
            source.write_bytes(newer)
            rename(source, target)
        with patch.object(subject.os, 'rename', swapping_rename):
            with self.assertRaisesRegex(subject.Refusal, 'rename boundary'): self.call()
        self.assertEqual(self.stop.read_bytes(), newer)
        self.assert_historical_unchanged()

    def test_symlink_stop_is_refused(self):
        saved = self.root/'saved-stop.json'
        self.stop.rename(saved)
        self.stop.symlink_to(saved)
        with self.assertRaises(OSError): self.call()
        self.assertTrue(self.stop.is_symlink())

    def test_unreviewed_fix_validation_is_refused(self):
        with patch.object(subject, 'REVIEWED_FIX_VALIDATIONS', {}):
            with self.assertRaisesRegex(subject.Refusal, 'fix validation'): self.call()
        self.assertTrue(self.stop.exists())

    def test_incomplete_or_inconsistent_accounting_refused(self):
        original = dict(self.rows[-1])
        for change in [{'input_tokens': True}, {'cached_tokens': 11},
                       {'usage': {'input_tokens': 10, 'output_tokens': 2, 'input_tokens_details': {'cached_tokens': 11}}}]:
            self.rows[-1] = {**original, **change}
            self.write_ledger()
            with self.assertRaisesRegex(subject.Refusal, 'unknown usage'): self.call()
        self.rows[-1] = dict(original)
        del self.rows[-1]['error']
        self.write_ledger()
        with self.assertRaisesRegex(subject.Refusal, 'unknown usage'): self.call()

    def test_bool_error_count_and_wrong_result_totals_refused(self):
        self.result['provider_errors'] = False
        self.write_result()
        with self.assertRaisesRegex(subject.Refusal, 'ambiguous'): self.call()
        self.result['provider_errors'] = 0
        self.result['output_tokens'] = 3
        self.write_result()
        with self.assertRaisesRegex(subject.Refusal, 'totals disagree'): self.call()

    def test_exact_reviewed_preflight_only_phase_is_allowed(self):
        config = 'a'*64
        preflight = self.root/'provenance-new-openai.json'
        preflight.write_bytes(subject.encoded({'candidate_revision': '2'*40, 'phase': 'new',
            'provider': 'openai', 'light_adaptive_effort': False, 'light_adaptive_high': False,
            'reasoning_effort': 'low', 'output_cap': 8192, 'configuration_sha256': config,
            'reasoning_settings_by_agent': {'light': {'light_reasoning_policy': 'fixed', 'reasoning_effort': 'low'}}}))
        self.fix_validation.write_bytes(subject.encoded({'fix_sha': '2'*40,
            'fixed_policy_validated': True, 'provider_calls': 0, 'configuration_sha256': config,
            'fresh_phase': 'new', 'fresh_provenance_sha256': subject.digest(preflight.read_bytes())}))
        with patch.object(subject, 'REVIEWED_FIX_VALIDATIONS', {'2'*40: subject.digest(self.fix_validation.read_bytes())}):
            with self.assertRaisesRegex(subject.Refusal, 'receipt phase or preflight'): self.call(expected_fresh_provenance_sha256=None)
            self.assertEqual(self.call(expected_fresh_provenance_sha256=subject.digest(preflight.read_bytes()))['status'],
                             'acknowledged_presend_only')

    def test_attempted_phase_is_rejected_even_if_run_directory_was_removed(self):
        self.rows.append({'event': 'admit', 'id': 'new-prior:1', 'run': 'new-prior', 'call': 1, 'reserve': 2})
        self.write_ledger()
        with self.assertRaisesRegex(subject.Refusal, 'already admitted'): self.call()

    def test_missing_fresh_preflight_is_refused(self):
        self.preflight.unlink()
        with self.assertRaisesRegex(subject.Refusal, 'fresh preflight is required'): self.call()

    def test_reviewed_receipt_must_bind_exact_phase_and_preflight_hash(self):
        original = json.loads(self.fix_validation.read_bytes())
        for fields in [{'fresh_phase': 'different'}, {'fresh_provenance_sha256': '0'*64}]:
            self.fix_validation.write_bytes(subject.encoded({**original, **fields}))
            with patch.object(subject, 'REVIEWED_FIX_VALIDATIONS', {'2'*40: subject.digest(self.fix_validation.read_bytes())}):
                with self.assertRaisesRegex(subject.Refusal, 'receipt phase or preflight'): self.call()
            self.assertTrue(self.stop.exists())

    def test_spend_journal_change_before_unlock_keeps_admission_blocked(self):
        write = subject.write_new
        journal = self.root/'spend-deepseek.jsonl'
        def concurrent_change(path, data):
            write(path, data)
            if path.name == 'completed.json': journal.write_bytes(b'{"concurrent_other_provider":true}\n')
        with patch.object(subject, 'write_new', concurrent_change):
            with self.assertRaisesRegex(subject.Refusal, 'evidence changed'): self.call()
        self.assertTrue((self.root/'luna-api-admission.lock').is_dir())
        self.assertEqual(journal.read_bytes(), b'{"concurrent_other_provider":true}\n')

    def test_newer_stop_during_completion_keeps_stop_and_owned_admission_barrier(self):
        write = subject.write_new
        newer = subject.encoded({'run': 'newer', 'reason': 'billing_error', 'time': 2})
        def inject_new_stop(path, data):
            write(path, data)
            if path.name == 'completed.json': self.stop.write_bytes(newer)
        with patch.object(subject, 'write_new', inject_new_stop):
            with self.assertRaisesRegex(subject.Refusal, 'newer stop'): self.call()
        self.assertEqual(self.stop.read_bytes(), newer)
        self.assertTrue((self.root/'luna-api-admission.lock').is_dir())
        self.assert_historical_unchanged()

    def test_uncatchable_exit_after_rename_leaves_durable_admission_barrier(self):
        def crash_child():
            rename = subject.os.rename
            def crash_after_rename(source, target):
                rename(source, target)
                os._exit(79)
            with patch.object(subject.os, 'rename', crash_after_rename): self.call()
        process = multiprocessing.get_context('fork').Process(target=crash_child)
        process.start()
        process.join(5)
        self.assertEqual(process.exitcode, 79)
        self.assertFalse(self.stop.exists())
        barrier = self.root/'luna-api-admission.lock'
        self.assertTrue(barrier.is_dir())
        self.assertTrue((barrier/'acknowledgement-owner.json').is_file())
        with self.assertRaises(FileExistsError): barrier.mkdir()
        with self.assertRaisesRegex(subject.Refusal, 'admission lock'): self.call()
        self.assert_historical_unchanged()

    def test_upstream_error_with_complete_usage_and_null_error_is_refused(self):
        response = self.run_dir/'response-001.txt'
        response.write_bytes(b'data: {"type":"error","error":{"code":"synthetic_failure"}}\n\n'+response.read_bytes())
        with self.assertRaisesRegex(subject.Refusal, 'upstream error'): self.call()
        self.assertTrue(self.stop.exists())

    def test_missing_recorded_wire_or_response_is_refused(self):
        (self.run_dir/'wire-001.json').unlink()
        with self.assertRaises(FileNotFoundError): self.call()
        self.assertTrue(self.stop.exists())

    def test_nonstream_completed_response_is_checked(self):
        (self.run_dir/'wire-001.json').write_bytes(subject.encoded({'body': {
            'model': 'gpt-6-luna', 'reasoning': {'effort': 'low'}, 'max_output_tokens': 8192, 'stream': False}}))
        (self.run_dir/'response-001.txt').write_bytes(subject.encoded({
            'status': 'failed', 'error': {'code': 'synthetic'}, 'usage': self.usage['usage']}))
        with self.assertRaisesRegex(subject.Refusal, 'terminal response'): self.call()

    def test_process_exit_after_completion_before_unlock_keeps_barrier(self):
        def crash_child():
            write = subject.write_new
            def crash_after_complete(path, data):
                write(path, data)
                if path.name == 'completed.json': os._exit(80)
            with patch.object(subject, 'write_new', crash_after_complete): self.call()
        process = multiprocessing.get_context('fork').Process(target=crash_child)
        process.start(); process.join(5)
        self.assertEqual(process.exitcode, 80)
        self.assertFalse(self.stop.exists())
        self.assertTrue((self.root/'luna-api-admission.lock').is_dir())
        receipt = self.root/'stop-resolutions'/self.kwargs['expected_stop_sha256']/'completed.json'
        self.assertEqual(json.loads(receipt.read_bytes())['status'], 'acknowledged_presend_only')
        with self.assertRaisesRegex(subject.Refusal, 'admission lock'): self.call()
        self.assert_historical_unchanged()

    def test_process_exit_after_owner_unlink_leaves_empty_blocking_lock(self):
        def crash_child():
            unlink = pathlib.Path.unlink
            def crash_after_owner_unlink(path, *args, **kwargs):
                unlink(path, *args, **kwargs)
                if path.name == 'acknowledgement-owner.json': os._exit(81)
            with patch.object(pathlib.Path, 'unlink', crash_after_owner_unlink): self.call()
        process = multiprocessing.get_context('fork').Process(target=crash_child)
        process.start(); process.join(5)
        self.assertEqual(process.exitcode, 81)
        barrier = self.root/'luna-api-admission.lock'
        self.assertTrue(barrier.is_dir())
        self.assertEqual(list(barrier.iterdir()), [])
        with self.assertRaisesRegex(subject.Refusal, 'admission lock'): self.call()
        self.assert_historical_unchanged()


if __name__ == '__main__':
    unittest.main()
