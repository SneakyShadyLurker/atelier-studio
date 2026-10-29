"""Portable worker boundary checks: real handlers, JSON bodies and middleware.

No media libraries or ComfyUI install are needed. test_worker.py also runs these
scenarios through aiohttp and the native PromptQueue on staging.
"""
import importlib.util
import json
import logging
from pathlib import Path
import sys
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

TEST_EXECUTION_SECONDS = 3600


class Response:
    def __init__(self, *, status=200, body=b'', headers=None):
        self.status, self.body, self.headers = status, body, headers or {}


class Routes:
    def __getattr__(self, method):
        return lambda path: lambda handler: handler


class Request:
    def __init__(self, path, *, method='POST', body=None, job=None, authenticated=True):
        self.path, self.method = path, method
        self.headers = {'Authorization': 'Bearer ' + 'synthetic-token-with-at-least-32-characters'} if authenticated else {}
        self.match_info = {'job': job} if job else {}
        self._read_bytes = json.dumps(body).encode() if body is not None else b''
        self.can_read_body = bool(self._read_bytes)

    async def read(self):
        return self._read_bytes

    async def json(self):
        return json.loads(self._read_bytes)

    @property
    def content(self):
        return self

    async def iter_chunked(self, size):
        for offset in range(0, len(self._read_bytes), size):
            yield self._read_bytes[offset:offset + size]


class Queue:
    def __init__(self):
        self.mutex = threading.RLock()
        self.queue, self.currently_running, self.history = [], {}, {}
        self.interrupted = []
        self.flags = {}

    def set_flag(self, name, value):
        with self.mutex:
            self.flags[name] = value

    def delete_queue_item(self, predicate):
        with self.mutex:
            self.queue[:] = [item for item in self.queue if not predicate(item)]

    def interrupt_if_running(self, identity):
        with self.mutex:
            if any(item[1] == identity for item in self.currently_running.values()):
                self.interrupted.append(identity)


def load_worker():
    server = SimpleNamespace(app=SimpleNamespace(middlewares=[], on_startup=[], on_cleanup=[]),
                             routes=Routes(), prompt_queue=Queue())
    web = SimpleNamespace(middleware=lambda handler: handler, Response=Response,
                          json_response=lambda value, **kwargs: Response(body=json.dumps(value).encode(), **kwargs),
                          HTTPRequestEntityTooLarge=type('HTTPTooLarge', (Exception,), {}))
    modules = {name: ModuleType(name) for name in (
        'numpy', 'torch', 'PIL', 'aiohttp', 'comfy', 'comfy.cli_args',
        'comfy_api', 'comfy_api.latest', 'server')}
    modules['PIL'].Image = modules['PIL'].ImageOps = SimpleNamespace()
    modules['aiohttp'].web = web
    modules['comfy.cli_args'].args = SimpleNamespace()
    modules['comfy_api.latest'].InputImpl = modules['comfy_api.latest'].Types = SimpleNamespace()
    modules['server'].PromptServer = SimpleNamespace(instance=server)
    root = Path(__file__).parent / 'atelier_private'
    spec = importlib.util.spec_from_file_location('portable_worker', root / 'worker.py', submodule_search_locations=[str(root)])
    worker = importlib.util.module_from_spec(spec)
    level = logging.root.manager.disable
    with patch.dict(sys.modules, {**modules, spec.name: worker}):
        try:
            spec.loader.exec_module(worker)
        finally:
            logging.disable(level)
    worker.TOKEN = 'synthetic-token-with-at-least-32-characters'
    worker.HOST_READY = True
    return worker, server


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.worker, self.server = load_worker()

    async def lease(self, identity=None, body=None):
        identity = identity or str(uuid.uuid4())
        body = {'executionTimeoutSeconds': TEST_EXECUTION_SECONDS, **(body or {})}
        request = Request('/atelier/v1/jobs/' + identity, job=identity, body=body)
        return identity, await self.worker.private_boundary(request, self.worker.create_job)

    async def test_serial_admission_metadata_duplicate_and_capacity(self):
        worker, queue = self.worker, self.server.prompt_queue
        metadata = json.loads((await worker.privacy(None)).body)
        self.assertEqual(metadata['protocol'], 2)
        self.assertTrue(metadata['capabilities']['job_admission'])
        self.assertRegex(metadata['worker_build'], r'^[a-f0-9]{64}$')
        self.assertEqual(metadata['allowed_nodes'], sorted(worker.ALLOWED))
        self.assertNotIn('SaveImageWebsocket', metadata['allowed_nodes'])
        self.assertEqual(metadata['limits'], dict(max_jobs=4, max_payload_bytes=512 * 1024 * 1024,
                         max_image_bytes=50 * 1024 * 1024, max_images=4, pre_submit_seconds=120,
                         terminal_idle_seconds=120, terminal_max_seconds=600, max_execution_seconds=86400))
        identity, response = await self.lease()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body)['protocol'], 2)
        _, response = await self.lease(identity)
        self.assertEqual(response.status, 409)
        waiter, response = await self.lease()
        self.assertEqual((response.status, json.loads(response.body)), (429, {'error': 'worker_busy'}))
        self.assertEqual(response.headers, {'Retry-After': '1', 'Cache-Control': 'no-store',
                                            'Atelier-Queue-Position': '1'})
        # Native completion between reaper ticks must immediately free admission,
        # while already completed output leases still own their payloads.
        for index in range(4):
            worker.STORE.jobs[identity].submitted = True
            worker.STORE.put(identity, 'out', b'mp4', output=True)
            queue.history[identity] = {'status': {'status_str': 'success', 'completed': True}}
            _, response = await self.lease() if index == 3 else (None, None)
            if index == 3:
                self.assertEqual(response.status, 429)
            else:
                # The first freed slot belongs to the waiter already in line.
                identity, response = await self.lease(waiter if index == 0 else None)
                self.assertEqual(response.status, 200)
        self.assertEqual(len(worker.STORE.jobs), 4)
        self.assertEqual(queue.history, {})

    async def test_execution_budget_is_required_and_negotiated(self):
        metadata = json.loads((await self.worker.privacy(None)).body)
        self.assertTrue(metadata['capabilities']['execution_budget'])
        identity = str(uuid.uuid4())
        for body in ({}, {'previews': True}):
            response = await self.worker.private_boundary(Request('/atelier/v1/jobs/' + identity,
                job=identity, body=body), self.worker.create_job)
            self.assertEqual(response.status, 400)
        for budget in (0, True, 1.5, '7200', 86401):
            _, response = await self.lease(body={'executionTimeoutSeconds': budget})
            self.assertEqual(response.status, 400)
        self.assertEqual(self.worker.STORE.jobs, {})
        identity, response = await self.lease(body={'executionTimeoutSeconds': 47904})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.worker.STORE.jobs[identity].execution_timeout_seconds, 47904)

    async def test_residency_tracks_failed_prompt_attempt_before_native_handler(self):
        metadata = json.loads((await self.worker.privacy(None)).body)
        self.assertTrue(metadata['capabilities']['residency_tracking'])
        identity, response = await self.lease(body={'imageOutputs': True})
        self.assertIsNone(json.loads(response.body)['previous_prompt_id'])

        async def rejected(request):
            self.assertEqual(self.worker.LAST_PROMPT_ID, identity)
            return Response(status=400)

        body = {'prompt_id': identity, 'prompt': {'9': {'class_type': 'AtelierSaveImages', 'inputs': {'job_id': identity}}}}
        response = await self.worker.private_boundary(Request('/prompt', body=body), rejected)
        self.assertEqual(response.status, 400)
        _, response = await self.lease()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body)['previous_prompt_id'], identity)

    async def test_execution_stuck_uses_admitted_budget(self):
        now = [0]
        self.worker.STORE = self.worker.Store(lambda: now[0])
        self.worker.WATCHDOG = self.worker.Watchdog(lambda: now[0])
        identity, _ = await self.lease(body={'executionTimeoutSeconds': 47904})
        self.worker.STORE.jobs[identity].submitted = True
        self.server.prompt_queue.currently_running[0] = (0, identity)
        self.assertFalse(self.worker.execution_stuck(self.server.prompt_queue))
        for now[0] in range(119, 47904, 119):
            response = await self.worker.job_status(Request('/atelier/v1/jobs/' + identity, method='GET', job=identity))
            self.assertEqual(json.loads(response.body)['state'], 'running')
            self.worker.reap_queue(self.server.prompt_queue)
            self.assertFalse(self.worker.execution_stuck(self.server.prompt_queue))
        now[0] = 47904
        self.assertTrue(self.worker.execution_stuck(self.server.prompt_queue))

    async def test_status_observes_ownership_during_awaited_native_submission(self):
        now = [0]
        worker = self.worker
        worker.STORE = worker.Store(lambda: now[0])
        identity, _ = await self.lease(body={'imageOutputs': True})

        async def submitting(request):
            for now[0] in (100, 200, 300):
                status = await worker.job_status(Request('/atelier/v1/jobs/' + identity, method='GET', job=identity))
                self.assertEqual(json.loads(status.body)['state'], 'queued')
                self.assertEqual(worker.STORE.jobs[identity].owner_seen, now[0])
                self.assertEqual(worker.STORE.jobs[identity].created, 0)
            return Response()

        body = {'prompt_id': identity, 'prompt': {'9': {'class_type': 'AtelierSaveImages', 'inputs': {'job_id': identity}}}}
        response = await worker.private_boundary(Request('/prompt', body=body), submitting)
        self.assertEqual(response.status, 200)
        now[0] = 400
        status = await worker.job_status(Request('/atelier/v1/jobs/' + identity, method='GET', job=identity))
        self.assertEqual(json.loads(status.body)['state'], 'queued')
        self.assertEqual(worker.STORE.jobs[identity].owner_seen, 400)

    async def test_slow_preparation_gets_a_full_owner_window_after_valid_submission(self):
        now = [0]
        worker, queue = self.worker, self.server.prompt_queue
        worker.STORE = worker.Store(lambda: now[0])
        identity, _ = await self.lease(body={'imageOutputs': True, 'executionTimeoutSeconds': 47904})
        now[0] = worker.PRE_SUBMIT_SECONDS - 1

        async def submitted(request):
            queue.currently_running[0] = (0, identity)
            return Response()

        body = {'prompt_id': identity, 'prompt': {'9': {'class_type': 'AtelierSaveImages', 'inputs': {'job_id': identity}}}}
        response = await worker.private_boundary(Request('/prompt', body=body), submitted)
        self.assertEqual(response.status, 200)
        job = worker.STORE.jobs[identity]
        self.assertEqual(job.created, 0)
        self.assertEqual(job.execution_timeout_seconds, 47904)
        for now[0] in (120, 238):
            worker.reap_queue(queue)
            self.assertFalse(job.release)
        status = await worker.job_status(Request('/atelier/v1/jobs/' + identity, method='GET', job=identity))
        self.assertEqual(json.loads(status.body)['state'], 'running')
        self.assertEqual(job.owner_seen, 238)
        now[0] = 358
        worker.reap_queue(queue)
        self.assertTrue(job.release)
        self.assertEqual(queue.interrupted, [identity])

    async def test_rejected_prompt_never_refreshes_owner_observation(self):
        now = [0]
        worker = self.worker

        async def unexpected_native_handler(request):
            self.fail('rejected prompt reached native execution')

        for reason in ('expired', 'released', 'prohibited', 'duplicate'):
            with self.subTest(reason=reason):
                now[0] = 0
                worker.STORE = worker.Store(lambda: now[0])
                identity, _ = await self.lease(body={'imageOutputs': True})
                now[0] = 120 if reason == 'expired' else 119
                job = worker.STORE.jobs[identity]
                if reason == 'released':
                    worker.STORE.cancel(identity)
                if reason == 'duplicate':
                    job.submitted = True
                kind = 'ProhibitedNode' if reason == 'prohibited' else 'AtelierSaveImages'
                body = {'prompt_id': identity, 'prompt': {'9': {'class_type': kind, 'inputs': {'job_id': identity}}}}
                response = await worker.private_boundary(Request('/prompt', body=body), unexpected_native_handler)
                self.assertEqual(response.status, 400)
                self.assertEqual(job.owner_seen, 0)

    async def test_abandoned_queued_job_dequeues_and_never_interrupts_successor(self):
        now = [0]
        worker, queue = self.worker, self.server.prompt_queue
        worker.STORE = worker.Store(lambda: now[0])
        identity, _ = await self.lease(body={'executionTimeoutSeconds': 86400})
        worker.STORE.jobs[identity].submitted = True
        queue.queue.append((0, identity))
        now[0] = 120
        successor, response = await self.lease()
        self.assertEqual(response.status, 200)
        self.assertEqual(queue.queue, [])
        self.assertNotIn(identity, worker.STORE.jobs)
        self.assertEqual(queue.interrupted, [])
        worker.STORE.jobs[successor].submitted = True
        queue.currently_running[0] = (0, successor)
        late = await worker.job_status(Request('/atelier/v1/jobs/' + identity, method='GET', job=identity))
        self.assertEqual(late.status, 404)
        self.assertEqual((await self.delete(identity)).status, 200)
        worker.reap_queue(queue)
        self.assertEqual(queue.interrupted, [])
        self.assertFalse(worker.STORE.jobs[successor].release)

    async def test_release_does_not_admit_until_native_running_really_leaves(self):
        worker, queue = self.worker, self.server.prompt_queue
        identity, _ = await self.lease()
        worker.STORE.jobs[identity].submitted = True
        queue.currently_running[0] = (0, identity)
        response = await worker.private_boundary(Request('/atelier/v1/jobs/' + identity, method='DELETE', job=identity), worker.release)
        self.assertEqual(response.status, 200)
        waiter, response = await self.lease()
        self.assertEqual(response.status, 429)
        self.assertGreaterEqual(len(queue.interrupted), 2)
        queue.currently_running.clear()
        _, response = await self.lease(waiter)
        self.assertEqual(response.status, 200)
        self.assertNotIn(identity, worker.STORE.jobs)

    async def test_free_checks_queue_without_reaching_native_handler_or_cuda(self):
        calls = []

        async def native_free(request):
            calls.append(await request.json())
            return Response()

        for active in ('queued', 'running'):
            queue = self.server.prompt_queue
            queue.queue, queue.currently_running = [], {}
            if active == 'queued':
                queue.queue.append((0, 'independent-consumer'))
            else:
                queue.currently_running[0] = (0, 'independent-consumer')
            response = await self.worker.private_boundary(Request('/free', body={'unload_models': True}), native_free)
            self.assertEqual(response.status, 429)
            self.assertEqual(json.loads(response.body), {'error': 'worker_busy'})
        self.assertEqual(calls, [])
        queue.currently_running.clear()
        response = await self.worker.private_boundary(Request('/free', body={'unload_models': True}), native_free)
        self.assertEqual(response.status, 200)
        self.assertEqual(calls, [])
        self.assertEqual(queue.flags, {'unload_models': True})
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_free_rejects_unsafe_methods_invalid_types_and_large_bodies(self):
        async def downstream(request):
            self.fail('free must not await downstream middleware')

        for method in ('GET', 'DELETE', 'PUT', 'HEAD'):
            response = await self.worker.private_boundary(Request('/free', method=method, body={}), downstream)
            self.assertEqual(response.status, 405)
        for body in ([], True, {'free_memory': 1}, {'unload_models': 'true'},
                     {'unknown': True}, {'free_memory': None}, {'padding': 'x' * 1024}):
            response = await self.worker.private_boundary(Request('/free', body=body), downstream)
            self.assertEqual(response.status, 400)
        self.assertEqual(self.server.prompt_queue.flags, {})
        for body in ({}, {'free_memory': False, 'unload_models': False},
                     {'free_memory': True, 'unload_models': True}):
            response = await self.worker.private_boundary(Request('/free', body=body), downstream)
            self.assertEqual(response.status, 200)
        self.assertEqual(self.server.prompt_queue.flags, {'free_memory': True, 'unload_models': True})

    async def test_unknown_delete_fences_late_post_and_does_not_interrupt_successor(self):
        identity, successor = str(uuid.uuid4()), str(uuid.uuid4())
        queue = self.server.prompt_queue
        queue.currently_running[0] = (0, successor)
        response = await self.worker.private_boundary(Request('/atelier/v1/jobs/' + identity,
            method='DELETE', job=identity), self.worker.release)
        self.assertEqual(response.status, 200)
        _, response = await self.lease(identity)
        self.assertEqual(response.status, 409)
        self.assertEqual(queue.interrupted, [])
        queue.currently_running.clear()
        _, response = await self.lease(successor)
        self.assertEqual(response.status, 200)

    async def test_unknown_delete_capacity_refuses_unretained_intent_and_expires(self):
        now = [0]
        self.worker.STORE = self.worker.Store(lambda: now[0])
        cancelled = [str(uuid.uuid4()) for _ in range(256)]
        for identity in cancelled:
            response = await self.worker.private_boundary(Request('/atelier/v1/jobs/' + identity,
                method='DELETE', job=identity), self.worker.release)
            self.assertEqual(response.status, 200)
        overflow = str(uuid.uuid4())
        response = await self.worker.private_boundary(Request('/atelier/v1/jobs/' + overflow,
            method='DELETE', job=overflow), self.worker.release)
        self.assertEqual((response.status, json.loads(response.body)), (429, {'error': 'worker_busy'}))
        self.assertEqual(len(self.worker.STORE.cancelled), 256)
        self.assertNotIn(overflow, self.worker.STORE.cancelled)
        # Tombstone capacity must not consume normal job admission capacity.
        _, response = await self.lease(overflow)
        self.assertEqual(response.status, 200)
        self.worker.STORE.jobs[overflow].submitted = True
        self.server.prompt_queue.currently_running[0] = (0, overflow)
        response = await self.worker.private_boundary(Request('/atelier/v1/jobs/' + overflow,
            method='DELETE', job=overflow), self.worker.release)
        self.assertEqual(response.status, 200)
        self.worker.reap_queue(self.server.prompt_queue)
        self.assertTrue(self.worker.STORE.jobs[overflow].release)
        self.assertEqual(len(self.worker.STORE.cancelled), 256)
        self.server.prompt_queue.currently_running.clear()
        now[0] = 119
        response = await self.worker.private_boundary(Request('/atelier/v1/jobs/' + cancelled[0],
            method='DELETE', job=cancelled[0]), self.worker.release)
        self.assertEqual(response.status, 200)
        _, response = await self.lease(cancelled[0])
        self.assertEqual(response.status, 409)
        now[0] = 120
        _, response = await self.lease(cancelled[0])
        self.assertEqual(response.status, 200)
        self.assertEqual(len(self.worker.STORE.cancelled), 0)

    async def test_real_prompt_boundary_rewrites_metadata_and_rejects_socket_sink(self):
        identity, _ = await self.lease(body={'imageOutputs': True, 'previews': False})
        submitted = []

        async def submit(request):
            submitted.append(await request.json())
            self.server.prompt_queue.queue.append((0, identity))
            return Response()

        body = {'prompt_id': identity, 'prompt': {'9': {'class_type': 'SaveImageWebsocket', 'inputs': {}}}}
        response = await self.worker.private_boundary(Request('/prompt', body=body), submit)
        self.assertEqual(response.status, 400)
        body['prompt']['9'] = {'class_type': 'AtelierSaveImages', 'inputs': {'job_id': identity}}
        body['extra_data'] = {'private': 'not forwarded'}
        response = await self.worker.private_boundary(Request('/prompt', body=body), submit)
        self.assertEqual(response.status, 200)
        self.assertEqual(submitted[0]['extra_data'], {'preview_method': 'none'})
        _, response = await self.lease()
        self.assertEqual(response.status, 429)

    async def delete(self, identity):
        request = Request('/atelier/v1/jobs/' + identity, method='DELETE', job=identity)
        return await self.worker.private_boundary(request, self.worker.release)

    async def test_waiting_list_header_order_and_delete_through_the_boundary(self):
        now = [0]
        worker = self.worker
        worker.STORE = worker.Store(lambda: now[0])
        holder, response = await self.lease()
        self.assertEqual(response.status, 200)
        waiters = [str(uuid.uuid4()) for _ in range(3)]
        for position, identity in enumerate(waiters, 1):
            _, response = await self.lease(identity)
            self.assertEqual(response.status, 429)
            # Deployed clients parse this body strictly; only the header is new.
            self.assertEqual(response.body, b'{"error": "worker_busy"}')
            self.assertEqual(response.headers['Atelier-Queue-Position'], str(position))
        first, second, third = waiters
        self.assertEqual((await self.delete(first)).status, 200)
        self.assertNotIn(first, worker.STORE.waiting)
        _, response = await self.lease(second)
        self.assertEqual(response.headers['Atelier-Queue-Position'], '1')
        # Free the slot: a later waiter still yields to the head of the line.
        self.assertEqual((await self.delete(holder)).status, 200)
        _, response = await self.lease(third)
        self.assertEqual((response.status, response.headers['Atelier-Queue-Position']), (429, '2'))
        _, response = await self.lease(second)
        self.assertEqual(response.status, 200)
        _, response = await self.lease(first)
        self.assertEqual(response.status, 409)
        _, response = await self.lease(third)
        self.assertEqual((response.status, response.headers['Atelier-Queue-Position']), (429, '1'))
        # Other busy refusals keep their unchanged headers.
        self.server.prompt_queue.currently_running[0] = (0, second)
        response = await worker.private_boundary(Request('/free', body={}), worker.create_job)
        self.assertEqual(response.headers, {'Retry-After': '1', 'Cache-Control': 'no-store'})

    async def run_reaper(self, ticks, each=lambda now: None, *, last_job=1000.0, has_run=True, owned=None):
        worker, queue = self.worker, self.server.prompt_queue
        clock = iter(ticks)
        now = [next(clock)]
        worker.STORE = worker.Store(lambda: now[0])
        for identity, budget in (owned or {}).items():
            worker.STORE.create(identity, execution_timeout_seconds=budget)
            worker.STORE.jobs[identity].submitted = True
        worker.WATCHDOG = worker.Watchdog(lambda: now[0])
        exits = []

        async def sleep(delay):
            each(now[0])
            try:
                now[0] = next(clock)
            except StopIteration:
                raise ReaperStopped from None

        def exit_process(code):
            exits.append((now[0], code, worker.HOST_READY))
            raise ReaperStopped

        with patch.multiple(worker, LAST_JOB=last_job, HAS_RUN=has_run, host_ready=lambda: True,
                            time=SimpleNamespace(monotonic=lambda: now[0]),
                            asyncio=SimpleNamespace(sleep=sleep), os=SimpleNamespace(_exit=exit_process)):
            with self.assertRaises(ReaperStopped):
                await worker.reaper()
        return exits, queue

    async def test_idle_unload_sets_native_flags_once_per_idle_period(self):
        flagged = []
        queue = self.server.prompt_queue

        def each(now):
            if queue.flags:
                flagged.append(now)
                queue.flags.clear()  # The native worker consumes its flags.
            # Set state for the next tick: one short job is seen running at 1700.
            if now == 1650:
                self.worker.STORE.create('job', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
                self.worker.STORE.jobs['job'].submitted = True
            queue.currently_running = {0: (0, 'job')} if now == 1650 else {}

        exits, _ = await self.run_reaper([1599, 1600, 1601, 1650, 1700, 1701, 2299, 2300, 2301, 4000], each)
        self.assertEqual(flagged, [1600, 2300])
        self.assertEqual(exits, [])

    async def test_idle_unload_sets_both_native_flags_under_the_queue_mutex(self):
        queue = self.server.prompt_queue
        seen = []
        original = queue.set_flag

        def set_flag(name, value):
            self.assertTrue(queue.mutex._is_owned())
            seen.append((name, value))
            original(name, value)

        queue.set_flag = set_flag
        await self.run_reaper([1600])
        self.assertEqual(seen, [('unload_models', True), ('free_memory', True)])

    async def test_idle_unload_needs_a_prior_job(self):
        queue = self.server.prompt_queue
        await self.run_reaper([1600, 5000], has_run=False)
        self.assertEqual(queue.flags, {})

    async def test_watchdog_restarts_when_released_job_keeps_running(self):
        worker, queue = self.worker, self.server.prompt_queue
        identity = str(uuid.uuid4())
        queue.currently_running[0] = (0, identity)

        def each(now):
            if now == 0:
                worker.STORE.cancel(identity)

        exits, _ = await self.run_reaper([0, 10, 69, 70, 71], each, last_job=0.0, owned={identity: TEST_EXECUTION_SECONDS})
        # Interrupt retries continue until the watchdog gives up; readiness
        # drops before the supervised exit so nothing new is admitted.
        self.assertEqual(exits, [(70, 1, False)])
        self.assertGreaterEqual(queue.interrupted.count(identity), 3)

    async def test_watchdog_restarts_past_the_absolute_execution_ceiling(self):
        queue = self.server.prompt_queue
        queue.currently_running[0] = (0, 'native-job')
        ceiling = TEST_EXECUTION_SECONDS
        def observe(now):
            self.worker.STORE.status('native-job', running=True)
        ticks = [*range(0, ceiling, 119), ceiling]
        exits, _ = await self.run_reaper(ticks, observe, last_job=0.0, owned={'native-job': ceiling})
        self.assertEqual(exits, [(ceiling, 1, False)])

    async def test_silent_owner_of_long_running_job_reaches_existing_restart_fence(self):
        identity = str(uuid.uuid4())
        queue = self.server.prompt_queue
        queue.currently_running[0] = (0, identity)
        exits, _ = await self.run_reaper([0, 119, 120, 179, 180], last_job=0.0, owned={identity: 86400})
        self.assertEqual(exits, [(180, 1, False)])
        self.assertGreaterEqual(queue.interrupted.count(identity), 3)
        self.assertTrue(self.worker.STORE.jobs[identity].release)

    async def test_watchdog_restarts_unknown_running_native_work(self):
        self.server.prompt_queue.currently_running[0] = (0, 'unknown-native-job')
        exits, _ = await self.run_reaper([0], last_job=0.0)
        self.assertEqual(exits, [(0, 1, False)])

    async def test_watchdog_ignores_a_released_job_that_stops(self):
        worker, queue = self.worker, self.server.prompt_queue
        identity = str(uuid.uuid4())
        queue.currently_running[0] = (0, identity)

        def each(now):
            if now == 0:
                worker.STORE.cancel(identity)
            if now == 59:
                queue.currently_running.clear()

        exits, _ = await self.run_reaper([0, 1, 59, 60, 61, 200], each, last_job=0.0, owned={identity: TEST_EXECUTION_SECONDS})
        self.assertEqual(exits, [])
        self.assertNotIn(identity, worker.STORE.jobs)


class ReaperStopped(Exception):
    pass


if __name__ == '__main__':
    unittest.main()
