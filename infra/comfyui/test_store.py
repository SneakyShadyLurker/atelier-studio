import importlib.util
from pathlib import Path
import sys
import unittest
import threading
from unittest.mock import patch

TEST_EXECUTION_SECONDS = 3600

# Embedded Windows Python can omit the script directory from sys.path.
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR))
spec = importlib.util.spec_from_file_location('atelier_store', TEST_DIR / 'atelier_private/store.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.store = module.Store(lambda: self.now)
        self.store.create('a', execution_timeout_seconds=TEST_EXECUTION_SECONDS)

    def test_long_running_jobs_keep_inputs(self):
        self.store.put('a', 'image', b'canary')
        self.store.jobs['a'].submitted = True
        self.now = 10_000
        self.assertEqual(self.store.reap({'a'}), [])
        self.assertEqual(self.store.get('a', 'image'), b'canary')
        self.store.reap(set())
        self.assertEqual(self.store.jobs['a'].inputs, {})
        self.now += 121
        self.assertEqual(self.store.reap(set()), ['a'])

    def test_execution_budget_is_validated_once_and_not_changed_by_renewal(self):
        for budget in (0, -1, True, 1.5, '7200', module.MAX_EXECUTION_SECONDS + 1):
            with self.assertRaises(ValueError):
                self.store.create('invalid', execution_timeout_seconds=budget)
        self.assertNotIn('invalid', self.store.jobs)
        self.store.create('long', execution_timeout_seconds=47904)
        self.store.jobs['long'].submitted = True
        self.now = 7300
        self.store.renew('long')
        self.assertEqual(self.store.jobs['long'].execution_timeout_seconds, 47904)
        self.assertEqual(self.store.jobs['a'].execution_timeout_seconds, TEST_EXECUTION_SECONDS)
        with self.assertRaises(TypeError):
            self.store.create('missing-budget')

    def test_long_job_owner_silence_releases_without_a_delete(self):
        self.store.create('long', execution_timeout_seconds=module.MAX_EXECUTION_SECONDS)
        job = self.store.jobs['long']
        job.submitted = True
        self.assertEqual(job.owner_seen, 0)
        self.now = module.OWNER_IDLE_SECONDS - 1
        self.store.release_abandoned({'long'})
        self.assertFalse(job.release)
        self.now = module.OWNER_IDLE_SECONDS
        self.store.release_abandoned({'long'})
        self.assertTrue(job.release)
        self.assertEqual(job.execution_timeout_seconds, module.MAX_EXECUTION_SECONDS)
        self.assertEqual(self.store.status('long', running=True), {'state': 'released', 'outputs': []})
        self.assertEqual(job.owner_seen, 0)
        with self.assertRaises(KeyError):
            self.store.renew('long')

    def test_status_observations_preserve_long_execution_without_extending_its_budget(self):
        budget = 47904
        self.store.create('long', execution_timeout_seconds=budget)
        job = self.store.jobs['long']
        job.submitted = True
        watchdog = module.Watchdog(lambda: self.now)
        budgets = {'long': budget}
        self.assertFalse(watchdog.observe({'long'}, set(), budgets))
        for self.now in range(module.OWNER_IDLE_SECONDS - 1, budget, module.OWNER_IDLE_SECONDS - 1):
            self.store.release_abandoned({'long'})
            self.assertFalse(job.release)
            self.assertEqual(self.store.status('long', running=True)['state'], 'running')
            self.assertFalse(watchdog.observe({'long'}, set(), budgets))
        self.now = budget
        self.assertEqual(self.store.status('long', running=True)['state'], 'running')
        self.assertEqual(job.execution_timeout_seconds, budget)
        self.assertTrue(watchdog.observe({'long'}, set(), budgets))

    def test_late_status_and_explicit_release_cannot_revive_owner(self):
        job = self.store.jobs['a']
        job.submitted = True
        self.now = module.OWNER_IDLE_SECONDS
        self.assertEqual(self.store.status('a', running=True)['state'], 'released')
        self.assertEqual(job.owner_seen, 0)
        self.store.create('released', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        released = self.store.jobs['released']
        released.submitted = True
        self.store.cancel('released')
        self.now += 1
        self.assertEqual(self.store.status('released', queued=True)['state'], 'released')
        self.assertEqual(released.owner_seen, module.OWNER_IDLE_SECONDS)

    def test_preparation_status_does_not_extend_creation_bound(self):
        self.now = module.PRE_SUBMIT_SECONDS - 1
        self.assertEqual(self.store.status('a')['state'], 'leased')
        self.assertEqual(self.store.jobs['a'].owner_seen, 0)
        self.now = module.PRE_SUBMIT_SECONDS
        with self.assertRaises(KeyError):
            self.store.status('a')

    def test_terminal_retention_and_downloads_are_separate_from_active_ownership(self):
        job = self.store.jobs['a']
        job.submitted = True
        self.store.put('a', 'out', b'video', output=True)
        self.now = 10
        self.store.snapshot_terminal('a', 'completed')
        for self.now in (100, 200, 300, 400, 500, 609):
            self.store.release_abandoned({'a'})
            self.assertFalse(job.release)
            self.assertEqual(self.store.status('a')['state'], 'completed')
            self.store.renew('a')
            self.assertEqual(self.store.output('a', 'out'), (b'video', 'video/mp4'))
            self.assertEqual(job.owner_seen, 0)
        self.now = 610
        with self.assertRaises(KeyError):
            self.store.status('a')
        with self.assertRaises(KeyError):
            self.store.output('a', 'out')

    def test_submit_race_cannot_expire_inputs(self):
        self.store.jobs['a'].submitting = True
        self.store.put('a', 'x', b'x', output=True)
        self.now = 1000
        self.assertEqual(self.store.reap(set()), [])

    def test_cancel_waits_for_actual_terminal(self):
        self.store.jobs['a'].submitted = True
        self.store.jobs['a'].release = True
        self.assertEqual(self.store.reap({'a'}), [])
        self.assertEqual(self.store.reap(set()), ['a'])

    def test_unsubmitted_orphan_expires(self):
        self.now = 121
        self.assertEqual(self.store.reap(set()), ['a'])

    def test_output_survives_download_until_ack(self):
        self.store.jobs['a'].submitted = True
        self.store.put('a', 'out', b'output', output=True)
        self.store.reap(set())
        self.assertEqual(self.store.get('a', 'out', output=True), b'output')
        self.store.jobs['a'].release = True
        self.store.reap(set())
        self.assertNotIn('a', self.store.jobs)

    def test_interactive_mode_does_not_install_private_routes(self):
        spec = importlib.util.spec_from_file_location('inactive_atelier', Path(__file__).parent / 'atelier_private/__init__.py')
        inactive = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(inactive)
        self.assertEqual(inactive.NODE_CLASS_MAPPINGS, {})

    def test_caps_and_replay(self):
        for key in ('one', 'two', 'three'):
            self.store.put('a', key, b'input')
        with self.assertRaises(ValueError):
            self.store.put('a', 'four', b'input')
        with self.assertRaises(ValueError):
            self.store.create('a', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        with module.BoundedBuffer() as buffer:
            buffer.seek(module.MAX_BYTES)
            with self.assertRaises(ValueError):
                buffer.write(b'x')

    def test_upload_reservations_consume_slots_before_bytes(self):
        buffers = [self.store.reserve_input('a', key) for key in ('one', 'two', 'three')]
        with self.assertRaises(ValueError):
            self.store.reserve_input('a', 'one')
        with self.assertRaises(ValueError):
            self.store.reserve_input('a', 'four')
        with self.assertRaises(ValueError):
            self.store.put('a', 'one', b'x')
        self.store.discard_input('a', 'one', buffers[0])
        replacement = self.store.reserve_input('a', 'one')
        # A stale finally cannot discard a newer reservation for the same asset.
        self.store.discard_input('a', 'one', buffers[0])
        self.assertIs(self.store.jobs['a'].uploads['one'], replacement)

    def test_shared_budget_includes_all_jobs_uploads_and_outputs(self):
        self.store.create('b', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        with patch.object(module, 'MAX_BYTES', 12):
            self.store.put('a', 'stored', b'123')
            first = self.store.reserve_input('a', 'first')
            second = self.store.reserve_input('b', 'second')
            self.store.append_input('a', 'first', first, b'4567')
            self.store.append_input('b', 'second', second, b'89')
            with self.assertRaises(ValueError):
                self.store.append_input('b', 'second', second, b'xxxx')
            with self.assertRaises(ValueError):
                self.store.put('b', 'out', b'xxxx', output=True)
            self.store.put('b', 'out', b'xyz', output=True)
            self.store.commit_input('a', 'first', first)
            self.store.discard_input('a', 'first', first)
            self.assertEqual(self.store._total_bytes(), 12)
            self.store.discard_input('b', 'second', second)
            self.assertEqual(self.store._total_bytes(), 10)
            self.store.put('b', 'input', b'12')

    def test_unavailable_jobs_reject_reservation_before_allocation(self):
        for state in ('release', 'submitting', 'submitted'):
            with self.subTest(state=state):
                setattr(self.store.jobs['a'], state, True)
                with patch.object(module, 'BoundedBuffer') as buffer:
                    with self.assertRaises(ValueError):
                        self.store.reserve_input('a', 'x')
                    buffer.assert_not_called()
                setattr(self.store.jobs['a'], state, False)
        self.now = module.PRE_SUBMIT_SECONDS
        with patch.object(module, 'BoundedBuffer') as buffer:
            with self.assertRaises(ValueError):
                self.store.reserve_input('a', 'x')
            with self.assertRaises(KeyError):
                self.store.reserve_input('missing', 'x')
            buffer.assert_not_called()

    def test_release_and_expiry_invalidate_inflight_bytes(self):
        for released in (False, True):
            with self.subTest(released=released):
                store = module.Store(lambda: self.now)
                self.now = 0
                store.create('a', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
                buffer = store.reserve_input('a', 'x')
                store.append_input('a', 'x', buffer, b'bytes')
                store.jobs['a'].release = released
                if not released:
                    self.now = module.PRE_SUBMIT_SECONDS
                with self.assertRaises(ValueError):
                    store.append_input('a', 'x', buffer, b'x')
                with self.assertRaises(ValueError):
                    store.commit_input('a', 'x', buffer)
                self.assertEqual(store.reap(set()), ['a'])
                self.assertTrue(buffer.closed)
                self.assertEqual(store._total_bytes(), 0)
                store.create('a', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
                replacement = store.reserve_input('a', 'x')
                store.discard_input('a', 'x', buffer)
                self.assertIs(store.jobs['a'].uploads['x'], replacement)

    def test_reservations_do_not_expand_job_limit(self):
        for identity in ('b', 'c', 'd'):
            self.store.create(identity, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
            self.store.reserve_input(identity, 'x')
        with self.assertRaises(ValueError):
            self.store.create('e', execution_timeout_seconds=TEST_EXECUTION_SECONDS)

    def test_image_controls_are_strict_and_defaults_are_preserved(self):
        job = self.store.jobs['a']
        self.assertTrue(job.previews)
        self.assertFalse(job.image_outputs)
        for value in (0, 1, None, 'false', []):
            for field in ('previews', 'image_outputs'):
                with self.subTest(value=value, field=field), self.assertRaises(ValueError):
                    self.store.create('b', **{field: value}, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        with self.assertRaises(ValueError):
            self.store.put_images('a', [('out', b'png')])
        self.store.put('a', 'video', b'mp4', output=True)
        self.assertEqual(self.store.output('a', 'video'), (b'mp4', 'video/mp4'))
        self.assertEqual(self.store.status('a'), {'state': 'leased', 'outputs': [
            {'id': 'video', 'bytes': 3, 'mediaType': 'video/mp4'}]})

    def test_four_ordered_images_keep_three_separate_input_slots(self):
        self.store.create('b', previews=False, image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        for asset in ('in1', 'in2', 'in3'):
            self.store.put('b', asset, b'input')
        images = [('out' + str(i), b'png' + bytes([i])) for i in range(4)]
        self.store.put_images('b', images)
        self.assertEqual(self.store.status('b')['outputs'], [
            {'id': asset, 'bytes': len(data), 'mediaType': 'image/png'} for asset, data in images])
        for asset, data in images:
            self.assertEqual(self.store.output('b', asset), (data, 'image/png'))
        with self.assertRaises(ValueError):
            self.store.put('b', 'in4', b'x')
        with self.assertRaises(ValueError):
            self.store.put_images('b', [('fifth', b'png')])
        with self.assertRaises(KeyError):
            self.store.output('a', 'out0')

    def test_image_batch_limits_are_atomic_and_share_the_upload_budget(self):
        self.store.create('b', image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        buffer = self.store.reserve_input('a', 'upload')
        self.store.append_input('a', 'upload', buffer, b'1234')
        with patch.object(module, 'MAX_PNG_BYTES', 4), patch.object(module, 'MAX_BYTES', 10):
            for images in ([], [('x', b'x')] * 5, [('x', b'12345')],
                           [('x', b'1234'), ('y', b'123')], [('x', b'x'), ('x', b'x')]):
                with self.subTest(images=images), self.assertRaises(ValueError):
                    self.store.put_images('b', images)
                self.assertEqual(self.store.jobs['b'].outputs, {})
            self.store.put_images('b', [('x', b'1234'), ('y', b'12')])
            self.assertEqual(self.store._total_bytes(), 10)
        self.store.discard_input('a', 'upload', buffer)
        with module.BoundedBuffer(4) as bounded:
            bounded.write(b'1234')
            with self.assertRaises(ValueError):
                bounded.write(b'5')

    def test_png_byte_limit_is_50_mib_with_unchanged_shared_budget(self):
        self.assertEqual(module.MAX_PNG_BYTES, 50 * 1024 * 1024)
        self.assertEqual(module.MAX_BYTES, 512 * 1024 * 1024)
        self.store.create('b', image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)

        class OversizedPng:
            def __len__(self):
                return module.MAX_PNG_BYTES + 1

        # Only length is consulted before rejection, so no oversized allocation
        # is needed to exercise the real default boundary.
        with self.assertRaisesRegex(ValueError, 'image byte limit'):
            self.store.put_images('b', [('out', OversizedPng())])
        self.assertEqual(self.store.jobs['b'].outputs, {})

    def test_status_races_privacy_terminal_retention_and_release(self):
        self.store.create('b', image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        job = self.store.jobs['b']
        self.store.put('b', 'private-input', b'private bytes')
        self.assertEqual(self.store.status('b')['state'], 'leased')
        job.submitting = True
        # The owner polls through awaited native validation/history lag.
        for self.now in range(0, 1000, 100):
            self.assertEqual(self.store.status('b')['state'], 'queued')
        self.now = 1000
        self.assertEqual(self.store.status('b')['state'], 'queued')
        self.assertEqual(self.store.reap(set()), ['a'])
        job.submitting, job.submitted = False, True
        self.assertEqual(self.store.status('b', queued=True)['state'], 'queued')
        self.assertEqual(self.store.status('b', running=True)['state'], 'running')
        self.store.reap(set())
        self.assertEqual(self.store.status('b')['state'], 'failed')
        self.store.put_images('b', [('out', b'png')])
        self.store.snapshot_terminal('b', 'completed')
        self.assertEqual(self.store.status('b'), {'state': 'completed', 'outputs': [
            {'id': 'out', 'bytes': 3, 'mediaType': 'image/png'}]})
        self.assertEqual(job.inputs, {})
        self.now += 119
        self.store.snapshot_terminal('b', 'failed')
        self.assertEqual(self.store.status('b')['state'], 'completed')
        self.now += 1
        with self.assertRaises(KeyError):
            self.store.status('b')
        with self.assertRaises(KeyError):
            self.store.output('b', 'out')
        self.store.reap(set())
        self.assertNotIn('b', self.store.jobs)

    def test_reaped_submitted_job_without_history_fails_until_expiry(self):
        self.store.put('a', 'input', b'private bytes')
        job = self.store.jobs['a']
        job.submitted = True
        self.assertEqual(self.store.reap(set()), [])
        self.assertEqual(job.terminal, self.now)
        self.assertIsNone(job.outcome)
        self.assertEqual(job.inputs, {})
        self.assertEqual(self.store.status('a'), {'state': 'failed', 'outputs': []})
        self.now = module.TERMINAL_SECONDS - 1
        self.assertEqual(self.store.reap(set()), [])
        self.assertEqual(self.store.status('a'), {'state': 'failed', 'outputs': []})
        self.now += 1
        with self.assertRaises(KeyError):
            self.store.status('a')
        self.assertEqual(self.store.reap(set()), ['a'])
        with self.assertRaises(KeyError):
            self.store.status('a')
        self.assertEqual(self.store._total_bytes(), 0)

    def test_released_images_are_unreadable_and_cannot_be_repopulated(self):
        self.store.create('b', image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.store.put_images('b', [('out', b'png')])
        self.store.jobs['b'].submitted = True
        self.store.jobs['b'].release = True
        self.assertEqual(self.store.status('b', running=True), {'state': 'released', 'outputs': []})
        with self.assertRaises(KeyError):
            self.store.output('b', 'out')
        with self.assertRaises(ValueError):
            self.store.put_images('b', [('late', b'png')])
        self.assertEqual(self.store.reap({'b'}), [])
        self.assertEqual(self.store.reap(set()), ['b'])

    def test_renewal_extends_terminal_download_grace_but_not_absolute_cap(self):
        job = self.store.jobs['a']
        job.submitted = True
        self.store.put('a', 'video', b'mp4', output=True)
        self.store.snapshot_terminal('a', 'completed')
        for now in (100, 200, 300, 400, 500, 599):
            self.now = now
            self.store.renew('a')
            self.assertEqual(self.store.output('a', 'video'), (b'mp4', 'video/mp4'))
            self.assertEqual(self.store.reap(set()), [])
            self.assertEqual(job.terminal, 0)
        self.now = 600
        for read in (lambda: self.store.renew('a'), lambda: self.store.status('a'),
                     lambda: self.store.output('a', 'video')):
            with self.assertRaises(KeyError):
                read()
        self.assertEqual(self.store.reap(set()), ['a'])

    def test_renewal_cannot_resurrect_idle_expired_or_released_leases(self):
        for terminal in (False, True):
            with self.subTest(terminal=terminal):
                store = module.Store(lambda: self.now)
                self.now = 0
                store.create('a', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
                if terminal:
                    store.jobs['a'].submitted = True
                    store.snapshot_terminal('a', 'completed')
                self.now = 120
                with self.assertRaises(KeyError):
                    store.renew('a')
                self.assertEqual(store.reap(set()), ['a'])
        self.now = 0
        self.store.jobs['a'].release = True
        with self.assertRaises(KeyError):
            self.store.renew('a')
        with self.assertRaises(KeyError):
            self.store.renew('missing')

    def test_active_renewal_does_not_shift_first_terminal_snapshot(self):
        job = self.store.jobs['a']
        job.submitted = True
        self.now = 1000
        self.store.renew('a')
        self.assertIsNone(job.renewed)
        self.store.snapshot_terminal('a', 'completed')
        self.now = 1119
        self.store.renew('a')
        self.now = 1121
        self.assertEqual(self.store.status('a')['state'], 'completed')
        self.now = 1239
        with self.assertRaises(KeyError):
            self.store.status('a')

    def test_fallback_terminal_snapshot_is_not_reset_by_late_history(self):
        self.store.jobs['a'].submitted = True
        self.store.reap(set())
        self.now = 100
        self.store.snapshot_terminal('a', 'completed')
        self.assertEqual(self.store.jobs['a'].terminal, 0)
        self.now = 120
        with self.assertRaises(KeyError):
            self.store.renew('a')

    def test_admission_is_atomic_across_independent_threads(self):
        store = module.Store()
        barrier = threading.Barrier(8)
        admitted, busy = [], []

        def compete(index):
            barrier.wait(timeout=2)
            try:
                store.admit(str(index), set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)
                admitted.append(index)
            except module.WorkerBusy:
                busy.append(index)

        threads = [threading.Thread(target=compete, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(admitted), 1)
        self.assertEqual(len(busy), 7)
        self.assertEqual(len(store.jobs), 1)

    def test_completed_payloads_overlap_but_capacity_and_native_activity_block(self):
        store = module.Store()
        for identity in ('a', 'b', 'c', 'd'):
            store.admit(identity, set(), image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
            store.jobs[identity].submitted = True
            store.put_images(identity, [('output', b'png')])
            store.snapshot_terminal(identity, 'completed')
        with self.assertRaises(module.WorkerBusy):
            store.admit('fifth', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        with self.assertRaises(module.DuplicateJob):
            store.admit('a', {'native'}, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        store.jobs['a'].release = True
        store.reap(set())
        # The refused waiter keeps polling with its own ID and keeps its place.
        for active in ({'queued'}, {'running'}):
            with self.assertRaises(module.WorkerBusy):
                store.admit('fifth', active, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        store.admit('fifth', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.assertEqual(store.output('b', 'output'), (b'png', 'image/png'))

    def test_released_running_job_blocks_until_native_terminal(self):
        self.store.jobs['a'].submitted = True
        self.store.jobs['a'].release = True
        self.store.reap({'a'})
        with self.assertRaises(module.WorkerBusy):
            self.store.admit('next', {'a'}, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.store.reap(set())
        self.store.admit('next', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.assertEqual(set(self.store.jobs), {'next'})

    def test_retained_payload_budget_reports_busy(self):
        self.store.jobs['a'].submitted = True
        self.store.put('a', 'output', b'payload', output=True)
        self.store.snapshot_terminal('a', 'completed')
        with patch.object(module, 'MAX_BYTES', 7), self.assertRaises(module.WorkerBusy):
            self.store.admit('next', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)

    def busy_position(self, identity, active=frozenset({'native'})):
        with self.assertRaises(module.WorkerBusy) as refused:
            self.store.admit(identity, active, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        return refused.exception.position

    def test_waiting_list_is_first_come_with_visible_positions(self):
        self.store.jobs.clear()
        self.assertEqual([self.busy_position(key) for key in ('w1', 'w2', 'w3')], [1, 2, 3])
        # Re-polling keeps the original place in line.
        self.assertEqual(self.busy_position('w2'), 2)
        self.assertEqual(self.busy_position('w1'), 1)
        # A free worker admits only the head; later waiters keep their places.
        self.assertEqual(self.busy_position('w3', set()), 3)
        self.assertEqual(self.busy_position('w2', set()), 2)
        self.assertEqual(self.busy_position('late', set()), 4)
        self.store.admit('w1', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.assertIn('w1', self.store.jobs)
        self.assertEqual(list(self.store.waiting), ['w2', 'w3', 'late'])
        # The admitted lease now owns the slot; the next waiter is first in line.
        self.assertEqual(self.busy_position('w2', set()), 1)
        self.assertEqual(self.busy_position('w3', set()), 2)

    def test_empty_waiting_list_admits_anyone(self):
        self.store.jobs.clear()
        self.store.admit('anyone', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.assertEqual(self.store.waiting, {})

    def test_waiters_not_polled_within_five_seconds_are_dropped(self):
        self.store.jobs.clear()
        self.busy_position('stale')
        self.now = 1
        self.busy_position('fresh')
        self.now = 5
        # Exactly five seconds is still within the polling window.
        self.assertEqual(self.busy_position('fresh'), 2)
        self.now = 5.5
        self.assertEqual(self.busy_position('fresh'), 1)
        self.assertNotIn('stale', self.store.waiting)
        # A dropped waiter that returns rejoins at the back.
        self.assertEqual(self.busy_position('stale'), 2)
        self.now = 11
        self.store.reap(set())
        self.assertEqual(self.store.waiting, {})
        self.store.admit('third', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)

    def test_release_removes_waiter_and_fences_its_late_poll(self):
        self.store.jobs.clear()
        for key in ('w1', 'w2'):
            self.busy_position(key)
        self.assertFalse(self.store.cancel('w1'))
        self.assertEqual(list(self.store.waiting), ['w2'])
        with self.assertRaises(module.DuplicateJob):
            self.store.admit('w1', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.store.admit('w2', set(), execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.assertEqual(self.store.waiting, {})

    def test_waiting_list_is_bounded_without_losing_existing_places(self):
        self.store.jobs.clear()
        for index in range(module.MAX_WAITING):
            self.assertEqual(self.busy_position(str(index)), index + 1)
        self.assertIsNone(self.busy_position('overflow'))
        self.assertNotIn('overflow', self.store.waiting)
        self.assertEqual(self.busy_position('0'), 1)
        self.assertEqual(len(self.store.waiting), module.MAX_WAITING)

    def test_duplicate_identity_never_joins_the_waiting_list(self):
        with self.assertRaises(module.DuplicateJob):
            self.store.admit('a', {'native'}, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        self.assertEqual(self.store.waiting, {})


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.watchdog = module.Watchdog(lambda: self.now)

    def test_release_intent_must_end_execution_within_sixty_seconds(self):
        self.assertFalse(self.watchdog.observe({'job'}, set(), {'job': TEST_EXECUTION_SECONDS}))
        self.now = 500
        self.assertFalse(self.watchdog.observe({'job'}, {'job'}, {'job': TEST_EXECUTION_SECONDS}))
        self.now = 559
        self.assertFalse(self.watchdog.observe({'job'}, {'job'}, {'job': TEST_EXECUTION_SECONDS}))
        self.now = 560
        self.assertTrue(self.watchdog.observe({'job'}, {'job'}, {'job': TEST_EXECUTION_SECONDS}))

    def test_cooperative_interrupt_clears_the_release_timer(self):
        self.watchdog.observe({'job'}, {'job'}, {'job': TEST_EXECUTION_SECONDS})
        self.now = 30
        self.assertFalse(self.watchdog.observe(set(), set(), {}))
        self.now = 100
        self.assertFalse(self.watchdog.observe({'successor'}, set(), {'successor': TEST_EXECUTION_SECONDS}))
        self.assertEqual(self.watchdog.released, {})
        self.assertEqual(self.watchdog.running, {'successor': 100})

    def test_release_intent_is_tracked_only_while_running(self):
        self.assertFalse(self.watchdog.observe(set(), {'queued'}, {}))
        self.now = 120
        self.assertFalse(self.watchdog.observe({'queued'}, {'queued'}, {'queued': TEST_EXECUTION_SECONDS}))
        self.now = 179
        self.assertFalse(self.watchdog.observe({'queued'}, {'queued'}, {'queued': TEST_EXECUTION_SECONDS}))
        self.now = 180
        self.assertTrue(self.watchdog.observe({'queued'}, {'queued'}, {'queued': TEST_EXECUTION_SECONDS}))

    def test_absolute_execution_ceiling_without_release(self):
        self.watchdog.observe({'job'}, set(), {'job': TEST_EXECUTION_SECONDS})
        self.now = TEST_EXECUTION_SECONDS - 1
        self.assertFalse(self.watchdog.observe({'job'}, set(), {'job': TEST_EXECUTION_SECONDS}))
        self.now = TEST_EXECUTION_SECONDS
        self.assertTrue(self.watchdog.observe({'job'}, set(), {'job': TEST_EXECUTION_SECONDS}))

    def test_long_admitted_budget_still_expires_at_its_own_deadline(self):
        budgets = {'long': 47904}
        self.assertFalse(self.watchdog.observe({'long'}, set(), budgets))
        self.now = 7201
        self.assertFalse(self.watchdog.observe({'long'}, set(), budgets))
        self.now = 47903
        self.assertFalse(self.watchdog.observe({'long'}, set(), budgets))
        self.now = 47904
        self.assertTrue(self.watchdog.observe({'long'}, set(), budgets))

    def test_long_budget_does_not_extend_release_grace(self):
        budgets = {'long': module.MAX_EXECUTION_SECONDS}
        self.watchdog.observe({'long'}, {'long'}, budgets)
        self.now = 60
        self.assertTrue(self.watchdog.observe({'long'}, {'long'}, budgets))

    def test_successive_jobs_get_their_own_ceiling(self):
        self.watchdog.observe({'first'}, set(), {'first': TEST_EXECUTION_SECONDS})
        self.now = TEST_EXECUTION_SECONDS - 10
        self.assertFalse(self.watchdog.observe({'second'}, set(), {'second': TEST_EXECUTION_SECONDS}))
        self.now = TEST_EXECUTION_SECONDS + 10
        self.assertFalse(self.watchdog.observe({'second'}, set(), {'second': TEST_EXECUTION_SECONDS}))

    def test_unknown_running_native_job_fails_closed(self):
        self.assertTrue(self.watchdog.observe({'unknown'}, set(), {}))


# The portable transport harness uses stdlib dependency stand-ins. Real native
# queue/media/HTTP integration remains in test_worker.py on staging.
from test_protocol import ProtocolTests


if __name__ == '__main__':
    unittest.main()
