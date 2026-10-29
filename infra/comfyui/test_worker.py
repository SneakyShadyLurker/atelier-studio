"""Run with the worker's embedded Python; synthetic data, no GPU generation."""
import asyncio
from fractions import Fraction
import importlib.util
import io
from pathlib import Path
import sys
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest import mock
from unittest.mock import patch
import uuid

TEST_EXECUTION_SECONDS = 3600

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'ComfyUI'))
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import torch
from PIL import Image
from PIL.PngImagePlugin import PngInfo

# Real native media implementations, isolated HTTP/queue owner.
server_module = ModuleType('server')
server = SimpleNamespace(app=web.Application(), routes=web.RouteTableDef())
server_module.PromptServer = SimpleNamespace(instance=server)
sys.modules['server'] = server_module
spec = importlib.util.spec_from_file_location('atelier_private', ROOT / 'atelier_private/worker.py',
                                            submodule_search_locations=[str(ROOT / 'atelier_private')])
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)
server.app.on_startup.clear()
server.app.on_cleanup.clear()
server.app.add_routes(server.routes)
worker.TOKEN = 'synthetic-test-token-with-32-characters'
worker.HOST_READY = True


class ReaperStopped(Exception):
    pass


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from execution import PromptQueue
        worker.STORE = worker.Store()
        server.prompt_queue = PromptQueue(SimpleNamespace(queue_updated=lambda: None))

    async def test_renewal_route_expiry_release_and_video_status(self):
        now = [0]
        store = worker.Store(lambda: now[0])
        identity = str(uuid.uuid4())
        asset = str(uuid.uuid4())
        store.create(identity, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        store.jobs[identity].submitted = True
        store.put(identity, asset, b'mp4', output=True)
        store.snapshot_terminal(identity, 'completed')
        queue = SimpleNamespace(mutex=threading.RLock(), queue=[], currently_running={}, history={})
        app = web.Application(middlewares=[worker.private_boundary])
        app.add_routes(server.routes)
        client = TestClient(TestServer(app))
        headers = {'Authorization': 'Bearer ' + worker.TOKEN}
        url = '/atelier/v1/jobs/' + identity
        with patch.object(server, 'prompt_queue', queue, create=True), patch.object(worker, 'STORE', store):
            await client.start_server()
            try:
                self.assertEqual((await client.post(url + '/renew')).status, 401)
                self.assertEqual((await client.post(url + '/renew', headers=headers, json={})).status, 400)
                now[0] = 100
                renewal = await client.post(url + '/renew', headers=headers)
                self.assertEqual(renewal.status, 200)
                self.assertEqual(await renewal.json(), {'ok': True})
                now[0] = 121
                status = await client.get(url, headers=headers)
                self.assertEqual(await status.json(), {'state': 'completed', 'outputs': [
                    {'id': asset, 'bytes': 3, 'mediaType': 'video/mp4'}]})
                download = await client.get(url + '/outputs/' + asset, headers=headers)
                self.assertEqual(await download.read(), b'mp4')
                self.assertEqual(download.content_type, 'video/mp4')
                store.jobs[identity].release = True
                self.assertEqual((await client.post(url + '/renew', headers=headers)).status, 404)
                missing = '/atelier/v1/jobs/' + str(uuid.uuid4()) + '/renew'
                self.assertEqual((await client.post(missing, headers=headers)).status, 404)
                store.jobs[identity].release = False
                now[0] = 220
                self.assertEqual((await client.post(url + '/renew', headers=headers)).status, 404)
                self.assertEqual((await client.get(url + '/outputs/' + asset, headers=headers)).status, 404)
            finally:
                await client.close()

    async def test_recovery_routes_controls_privacy_and_scoping(self):
        queue = SimpleNamespace(mutex=threading.RLock(), queue=[], currently_running={}, history={})
        app = web.Application(middlewares=[worker.private_boundary])
        app.add_routes(server.routes)
        submissions = []

        async def submit(request):
            submissions.append(await request.json())
            return web.json_response({'ok': True})

        app.router.add_post('/prompt', submit)
        client = TestClient(TestServer(app))
        headers = {'Authorization': 'Bearer ' + worker.TOKEN}
        with patch.object(server, 'prompt_queue', queue, create=True), patch.object(worker, 'STORE', worker.Store()):
            await client.start_server()
            try:
                privacy = await client.get('/atelier/v1/privacy', headers=headers)
                metadata = await privacy.json()
                self.assertEqual(metadata['protocol'], 2)
                self.assertTrue(metadata['ready'])
                self.assertRegex(metadata['worker_build'], r'^[a-f0-9]{64}$')
                self.assertEqual(metadata['allowed_nodes'], sorted(worker.ALLOWED))
                self.assertEqual(metadata['limits'], {'max_jobs': 4, 'max_payload_bytes': 512 * 1024 * 1024,
                    'max_image_bytes': 50 * 1024 * 1024, 'max_images': 4, 'pre_submit_seconds': 120,
                    'terminal_idle_seconds': 120, 'terminal_max_seconds': 600, 'max_execution_seconds': 86400})
                self.assertEqual(metadata['capabilities'], {
                    'job_status': True, 'image_outputs': True, 'preview_control': True,
                    'video_outputs': True, 'lease_renewal': True, 'job_admission': True,
                    'execution_budget': True, 'residency_tracking': True})
                for body in ({'previews': 0}, {'imageOutputs': 'true'}, [], None, {'unknown': True}):
                    if isinstance(body, dict):
                        body = {'executionTimeoutSeconds': TEST_EXECUTION_SECONDS, **body}
                    response = await client.post('/atelier/v1/jobs/' + str(uuid.uuid4()),
                                                 data=worker.json.dumps(body).encode(), headers=headers)
                    self.assertEqual(response.status, 400)
                for controls, kind, expected in (
                    (None, 'AtelierSaveVideo', 'none'),
                    ({'previews': False, 'imageOutputs': True}, 'AtelierSaveImages', 'none'),
                    ({'imageOutputs': True}, 'AtelierSaveImages', 'auto'),
                    (None, 'AtelierSaveVideo', 'none'),
                ):
                    identity = str(uuid.uuid4())
                    url = '/atelier/v1/jobs/' + identity
                    # Release prior iterations so the four-lease cap stays meaningful.
                    worker.STORE.jobs.clear()
                    response = await client.post(url, headers=headers,
                        json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS, **(controls or {})})
                    self.assertEqual(response.status, 200)
                    self.assertEqual((await client.get(url)).status, 401)
                    response = await client.get(url, headers=headers)
                    self.assertEqual(await response.json(), {'state': 'leased', 'outputs': []})
                    self.assertEqual(response.headers['Cache-Control'], 'no-store')
                    graph = {'1': {'class_type': kind, 'inputs': {'job_id': identity, 'images': ['2', 0]}}}
                    response = await client.post('/prompt', headers=headers, json={
                        'prompt_id': identity, 'prompt': graph, 'extra_data': {'preview_method': 'injected'}})
                    self.assertEqual(response.status, 200)
                    self.assertEqual(submissions[-1]['extra_data'], {'preview_method': expected})
                    # An accepted submit absent from the native queue is never inferred completed.
                    self.assertEqual((await (await client.get(url, headers=headers)).json())['state'], 'queued')
                    queue.queue = [(0, identity)]
                    self.assertEqual((await (await client.get(url, headers=headers)).json())['state'], 'queued')
                    queue.queue.clear()
                    queue.currently_running = {0: (0, identity)}
                    self.assertEqual((await (await client.get(url, headers=headers)).json())['state'], 'running')
                    queue.currently_running.clear()
                    queue.history[identity] = {'status': {'status_str': 'success', 'completed': True},
                                               'prompt': 'private prompt', 'outputs': {'secret': 'path'}}
                    worker.reap_queue(queue)
                    response = await client.get(url, headers=headers)
                    self.assertEqual(await response.json(), {'state': 'completed', 'outputs': []})
                    self.assertEqual(queue.history, {})
                self.assertEqual((await client.get('/api/jobs/' + identity, headers=headers)).status, 404)
                self.assertEqual((await client.get('/history/' + identity, headers=headers)).status, 404)
                self.assertEqual((await client.get('/atelier/v1/jobs/' + str(uuid.uuid4()), headers=headers)).status, 404)
                worker.STORE.jobs[identity].terminal -= 120
                self.assertEqual((await client.get(url, headers=headers)).status, 404)
            finally:
                await client.close()

    async def test_http_admission_native_queue_release_and_free_exclusion(self):
        queue = server.prompt_queue
        app = web.Application(middlewares=[worker.private_boundary])
        app.add_routes(server.routes)
        free_calls = []

        async def native_free(request):
            free_calls.append(await request.json())
            return web.json_response({})

        app.router.add_post('/free', native_free)
        client = TestClient(TestServer(app))
        headers = {'Authorization': 'Bearer ' + worker.TOKEN}
        identities = [str(uuid.uuid4()) for _ in range(8)]
        await client.start_server()
        try:
            replies = await asyncio.gather(*(client.post('/atelier/v1/jobs/' + identity,
                headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS, 'previews': False, 'imageOutputs': True}) for identity in identities))
            self.assertEqual(sorted(reply.status for reply in replies), [200] + [429] * 7)
            self.assertEqual(sorted(reply.headers['Atelier-Queue-Position'] for reply in replies
                                    if reply.status == 429), [str(position) for position in range(1, 8)])
            identity = next(identity for identity, reply in zip(identities, replies) if reply.status == 200)
            # Waiters that give up leave the line; later leases below are admitted.
            for waiter, reply in zip(identities, replies):
                if reply.status == 429:
                    self.assertEqual((await client.delete('/atelier/v1/jobs/' + waiter, headers=headers)).status, 200)
            self.assertEqual(worker.STORE.waiting, {})
            duplicate = await client.post('/atelier/v1/jobs/' + identity, headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS})
            self.assertEqual(duplicate.status, 409)
            worker.STORE.jobs[identity].submitted = True
            queue.put((0, identity, {}, {}, []))
            queued_free = await client.post('/free', headers=headers, json={'free_memory': True})
            self.assertEqual(queued_free.status, 429)
            _, task = queue.get()
            with patch('nodes.interrupt_processing') as interrupt:
                self.assertEqual((await client.delete('/atelier/v1/jobs/' + identity, headers=headers)).status, 200)
                self.assertTrue(interrupt.called)
                waiter = str(uuid.uuid4())
                busy = await client.post('/atelier/v1/jobs/' + waiter, headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS})
                self.assertEqual(busy.status, 429)
                self.assertEqual(await busy.json(), {'error': 'worker_busy'})
                self.assertEqual(busy.headers['Retry-After'], '1')
                self.assertEqual(busy.headers['Cache-Control'], 'no-store')
                self.assertEqual(busy.headers['Atelier-Queue-Position'], '1')
                self.assertEqual((await client.post('/free', headers=headers, json={})).status, 429)
                queue.task_done(task, {}, None)
            self.assertEqual((await client.delete('/atelier/v1/jobs/' + waiter, headers=headers)).status, 200)
            self.assertEqual(free_calls, [])
            # Complete four successive native jobs, retaining every payload.
            for index in range(4):
                identity = str(uuid.uuid4())
                self.assertEqual((await client.post('/atelier/v1/jobs/' + identity,
                    headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS, 'imageOutputs': True})).status, 200)
                worker.STORE.jobs[identity].submitted = True
                worker.STORE.put_images(identity, [('out', b'png')])
                queue.put((index, identity, {}, {}, []))
                _, task = queue.get()
                queue.task_done(task, {}, None)
                with queue.mutex:
                    queue.history[identity]['status'] = {'status_str': 'success', 'completed': True}
            capacity = await client.post('/atelier/v1/jobs/' + str(uuid.uuid4()), headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS})
            self.assertEqual(capacity.status, 429)
            self.assertEqual(len(worker.STORE.jobs), 4)
            self.assertTrue(all(job.outcome == 'completed' for job in worker.STORE.jobs.values()))
            self.assertEqual((await client.post('/free', headers=headers, json={'free_memory': True})).status, 200)
            self.assertEqual(free_calls, [])
            self.assertEqual(queue.get_flags(reset=False), {'free_memory': True})
        finally:
            await client.close()

    async def test_http_cancel_tombstones_expiry_capacity_and_native_successor(self):
        now = [0]
        worker.STORE = worker.Store(lambda: now[0])
        queue = server.prompt_queue
        app = web.Application(middlewares=[worker.private_boundary])
        app.add_routes(server.routes)
        client = TestClient(TestServer(app))
        headers = {'Authorization': 'Bearer ' + worker.TOKEN}
        cancelled = [str(uuid.uuid4()) for _ in range(256)]
        successor = str(uuid.uuid4())
        worker.STORE.create(successor, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        worker.STORE.jobs[successor].submitted = True
        queue.put((0, successor, {}, {}, []))
        _, task = queue.get()
        await client.start_server()
        try:
            with patch('nodes.interrupt_processing') as interrupt:
                for identity in cancelled:
                    response = await client.delete('/atelier/v1/jobs/' + identity, headers=headers)
                    self.assertEqual(response.status, 200)
                interrupt.assert_not_called()
                late = await client.post('/atelier/v1/jobs/' + cancelled[0], headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS})
                self.assertEqual(late.status, 409)
                overflow = await client.delete('/atelier/v1/jobs/' + str(uuid.uuid4()), headers=headers)
                self.assertEqual(overflow.status, 429)
                self.assertEqual(await overflow.json(), {'error': 'worker_busy'})
                self.assertEqual(len(worker.STORE.cancelled), 256)
                self.assertEqual((await client.delete('/atelier/v1/jobs/' + successor, headers=headers)).status, 200)
                self.assertTrue(worker.STORE.jobs[successor].release)
                interrupt.assert_called_once()
                queue.task_done(task, {}, None)
            fresh = str(uuid.uuid4())
            self.assertEqual((await client.post('/atelier/v1/jobs/' + fresh, headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS})).status, 200)
            # Known job cancellation still succeeds with a full tombstone set.
            self.assertEqual((await client.delete('/atelier/v1/jobs/' + fresh, headers=headers)).status, 200)
            now[0] = worker.PRE_SUBMIT_SECONDS
            self.assertEqual((await client.post('/atelier/v1/jobs/' + cancelled[0], headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS})).status, 200)
            self.assertEqual(worker.STORE.cancelled, {})
        finally:
            await client.close()

    async def test_http_free_is_synchronous_and_validates_controls_before_queue_flags(self):
        queue = server.prompt_queue
        app = web.Application(middlewares=[worker.private_boundary])

        async def downstream(request):
            self.fail('free must never invoke downstream HTTP/CUDA logic')

        app.router.add_route('*', '/free', downstream)
        client = TestClient(TestServer(app))
        headers = {'Authorization': 'Bearer ' + worker.TOKEN}
        await client.start_server()
        try:
            for method in ('GET', 'PUT', 'DELETE', 'HEAD'):
                self.assertEqual((await client.request(method, '/free', headers=headers, json={})).status, 405)
            for controls in ([], None, True, {'free_memory': 1}, {'unload_models': 'true'}, {'extra': True}):
                response = await client.post('/free', headers=headers, data=worker.json.dumps(controls))
                self.assertEqual(response.status, 400)
            self.assertEqual((await client.post('/free', headers=headers, data='x' * 1025)).status, 400)
            self.assertEqual(queue.get_flags(reset=False), {})
            self.assertEqual((await client.post('/free', headers=headers,
                json={'unload_models': False, 'free_memory': False})).status, 200)
            self.assertEqual(queue.get_flags(reset=False), {})
            self.assertEqual((await client.post('/free', headers=headers,
                json={'unload_models': True, 'free_memory': True})).status, 200)
            self.assertEqual(queue.get_flags(reset=False), {'unload_models': True, 'free_memory': True})
        finally:
            await client.close()

    async def test_png_outputs_order_limits_ownership_and_download(self):
        store = worker.Store()
        identity, other = str(uuid.uuid4()), str(uuid.uuid4())
        store.create(identity, previews=False, image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        store.create(other, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        with patch.object(worker, 'STORE', store):
            for owner, job_id in ((other, other), (identity, other)):
                with self.assertRaises(ValueError):
                    worker.validate_graph({'prompt_id': owner, 'prompt': {'1': {
                        'class_type': 'AtelierSaveImages', 'inputs': {'images': ['2', 0], 'job_id': job_id}}}})
            with self.assertRaises(ValueError):
                worker.AtelierSaveImages().save(torch.zeros((1, 2, 2, 3)), other)
            for shape in ((0, 2, 2, 3), (5, 2, 2, 3), (1, 8000, 4001, 3)):
                with self.assertRaises(ValueError):
                    worker.AtelierSaveImages().save(SimpleNamespace(shape=shape), identity)
            with patch.object(worker, 'MAX_PNG_BYTES', 1), self.assertRaises(ValueError):
                worker.AtelierSaveImages().save(torch.zeros((1, 2, 2, 3)), identity)
            self.assertEqual(store.jobs[identity].outputs, {})
            graph = {'1': {'class_type': 'AtelierSaveImages', 'inputs': {'images': ['2', 0], 'job_id': identity}}}
            worker.validate_graph({'prompt_id': identity, 'prompt': graph})
            pixels = torch.stack([torch.full((2, 2, 3), color / 255) for color in (0, 64, 128, 255)])
            worker.AtelierSaveImages().save(pixels, identity)
            outputs = store.status(identity)['outputs']
            self.assertEqual(len(outputs), 4)
            for output, color in zip(outputs, (0, 64, 128, 255)):
                self.assertTrue(worker.valid_id(output['id']))
                response = await worker.download(SimpleNamespace(match_info={'job': identity, 'asset': output['id']}))
                self.assertEqual(response.content_type, 'image/png')
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                self.assertEqual(len(response.body), output['bytes'])
                with Image.open(io.BytesIO(response.body)) as image:
                    self.assertEqual(image.getpixel((0, 0)), (color,) * 3)
                    self.assertEqual(image.info, {})
                wrong_owner = await worker.download(SimpleNamespace(match_info={'job': other, 'asset': output['id']}))
                self.assertEqual(wrong_owner.status, 404)
            store.jobs[identity].release = True
            response = await worker.download(SimpleNamespace(match_info={'job': identity, 'asset': outputs[0]['id']}))
            self.assertEqual(response.status, 404)
            with self.assertRaises(ValueError):
                worker.AtelierSaveImages().save(pixels[:1], identity)

    async def test_valid_png_above_8_mib_uses_50_mib_sink_and_shared_budget(self):
        metadata = PngInfo()
        metadata.add_text('synthetic-padding', 'x' * (8 * 1024 * 1024))
        with io.BytesIO() as buffer:
            Image.new('RGB', (2, 2)).save(buffer, format='PNG', pnginfo=metadata)
            png = buffer.getvalue()
        self.assertGreater(len(png), 8 * 1024 * 1024)
        self.assertEqual(worker.MAX_PNG_BYTES, 50 * 1024 * 1024)
        self.assertLess(len(png), worker.MAX_PNG_BYTES)
        store = worker.Store()
        identity, other = str(uuid.uuid4()), str(uuid.uuid4())
        store.create(identity, image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        store.create(other, image_outputs=True, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        # Inject an already valid synthetic encoder result through the real
        # bounded sink, atomic store commit and authenticated download handler.
        with patch.object(worker, 'STORE', store), patch.object(
                Image.Image, 'save', autospec=True,
                side_effect=lambda image, buffer, **kwargs: buffer.write(png)):
            worker.AtelierSaveImages().save(torch.zeros((1, 2, 2, 3)), identity)
            output = store.status(identity)['outputs'][0]
            response = await worker.download(SimpleNamespace(match_info={'job': identity, 'asset': output['id']}))
            self.assertEqual(response.body, png)
            self.assertEqual(response.content_type, 'image/png')
            with Image.open(io.BytesIO(response.body)) as image:
                self.assertEqual(image.size, (2, 2))
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 0))
            store_module = sys.modules[worker.Store.__module__]
            with patch.object(store_module, 'MAX_BYTES', len(png) * 2 - 1):
                with self.assertRaisesRegex(ValueError, 'memory limit'):
                    worker.AtelierSaveImages().save(torch.zeros((1, 2, 2, 3)), other)
            self.assertEqual(store.jobs[other].outputs, {})

    async def test_terminal_snapshot_fails_closed_and_ignores_running_history(self):
        queue = SimpleNamespace(mutex=threading.RLock(), queue=[], currently_running={}, history={})
        store = worker.Store()
        with patch.object(worker, 'STORE', store):
            for status in ({'status_str': 'error', 'completed': False, 'messages': ['private error']},
                           {'status_str': 'success', 'completed': False}, None):
                identity = str(uuid.uuid4())
                store.create(identity, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
                store.jobs[identity].submitted = True
                queue.currently_running = {0: (0, identity)}
                queue.history[identity] = {'status': status, 'prompt': 'private input'}
                worker.reap_queue(queue)
                self.assertIsNone(store.jobs[identity].outcome)
                queue.currently_running.clear()
                worker.reap_queue(queue)
                self.assertEqual(store.status(identity), {'state': 'failed', 'outputs': []})
                self.assertEqual(queue.history, {})

    async def run_reaper_ticks(self, times, *, active=None, submitting=False, has_run=True):
        clock = iter(times)
        now = next(clock)
        flags = {}
        queue = SimpleNamespace(mutex=threading.RLock(), queue=[], currently_running={}, history={},
                                set_flag=flags.__setitem__)
        if active == 'queued':
            queue.queue.append((0, 'active-job'))
        elif active == 'running':
            queue.currently_running[0] = (0, 'active-job')
        store = worker.Store(clock=lambda: now)
        if active:
            store.create('active-job', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
            store.jobs['active-job'].submitted = True
        if submitting:
            store.create('leased-job', execution_timeout_seconds=TEST_EXECUTION_SECONDS)
            store.jobs['leased-job'].submitting = True
        sleeps = []

        async def sleep(delay):
            nonlocal now
            sleeps.append(delay)
            # Finish the synthetic active job or release its submission lease.
            queue.queue.clear()
            queue.currently_running.clear()
            if active:
                store.snapshot_terminal('active-job', 'completed')
            if submitting:
                store.jobs['leased-job'].submitting = False
                store.jobs['leased-job'].release = True
            try:
                now = next(clock)
            except StopIteration:
                raise ReaperStopped from None

        exit_process = mock.Mock(side_effect=ReaperStopped)
        with mock.patch.multiple(worker, STORE=store, WATCHDOG=worker.Watchdog(lambda: now),
                                 UNLOADED_AT=None, SERVER=SimpleNamespace(prompt_queue=queue),
                                 LAST_JOB=1000.0, HAS_RUN=has_run, HOST_READY=True,
                                 host_ready=lambda: True, time=SimpleNamespace(monotonic=lambda: now),
                                 asyncio=SimpleNamespace(sleep=sleep), os=SimpleNamespace(_exit=exit_process)):
            with self.assertRaises(ReaperStopped):
                await worker.reaper()
            last_job = worker.LAST_JOB
        return exit_process, sleeps, last_job, store

    async def test_idle_restart_waits_past_180_minutes(self):
        exit_process, sleeps, last_job, _ = await self.run_reaper_ticks(
            [1301.0, 11799.0, 11800.0, 11801.0])
        exit_process.assert_called_once_with(0)
        self.assertEqual(sleeps, [1, 1, 1])
        self.assertEqual(last_job, 1000.0)

    async def test_active_jobs_refresh_idle_restart_clock(self):
        for active in ('queued', 'running'):
            with self.subTest(active=active):
                exit_process, sleeps, last_job, _ = await self.run_reaper_ticks(
                    [11801.0, 22601.0, 22602.0], active=active)
                exit_process.assert_called_once_with(0)
                self.assertEqual(sleeps, [1, 1])
                self.assertEqual(last_job, 11801.0)

    async def test_submission_lease_blocks_idle_restart_until_reaped(self):
        exit_process, sleeps, last_job, store = await self.run_reaper_ticks(
            [11801.0, 11802.0], submitting=True)
        exit_process.assert_called_once_with(0)
        self.assertEqual(sleeps, [1])
        self.assertEqual(last_job, 1000.0)
        self.assertEqual(store.jobs, {})

    async def test_unused_worker_does_not_restart(self):
        exit_process, sleeps, last_job, _ = await self.run_reaper_ticks([11801.0], has_run=False)
        exit_process.assert_not_called()
        self.assertEqual(sleeps, [1])
        self.assertEqual(last_job, 1000.0)
    async def test_upload_cleanup_on_stream_failure(self):
        for failure in (TimeoutError, ConnectionResetError, asyncio.CancelledError, ValueError):
            with self.subTest(failure=failure):
                identity, asset = str(uuid.uuid4()), str(uuid.uuid4())
                worker.STORE.create(identity, execution_timeout_seconds=TEST_EXECUTION_SECONDS)

                class Content:
                    async def iter_chunked(self, size):
                        yield b'partial'
                        raise failure()

                request = SimpleNamespace(match_info={'job': identity, 'asset': asset}, content=Content())
                try:
                    with self.assertRaises(failure):
                        await worker.upload(request)
                    self.assertEqual(worker.STORE.jobs[identity].uploads, {})
                    self.assertEqual(worker.STORE.jobs[identity].inputs, {})
                    self.assertEqual(worker.STORE._total_bytes(), 0)
                finally:
                    worker.STORE.jobs.clear()

    async def test_duplicate_upload_does_not_read_body(self):
        identity, asset = str(uuid.uuid4()), str(uuid.uuid4())
        worker.STORE.create(identity, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        reservation = worker.STORE.reserve_input(identity, asset)
        content = SimpleNamespace(iter_chunked=lambda size: self.fail('duplicate body read'))
        try:
            with self.assertRaises(ValueError):
                await worker.upload(SimpleNamespace(match_info={'job': identity, 'asset': asset}, content=content))
            with self.assertRaises(ValueError):
                worker.validate_graph({'prompt_id': identity, 'prompt': {'1': {
                    'class_type': 'AtelierSaveVideo', 'inputs': {'job_id': identity}}}})
            self.assertFalse(worker.STORE.jobs[identity].submitting)
        finally:
            worker.STORE.discard_input(identity, asset, reservation)
            worker.STORE.jobs.clear()

    async def test_reaper_retries_lost_native_interrupt_without_canceling_successor(self):
        from execution import PromptQueue
        queue = PromptQueue(SimpleNamespace(queue_updated=lambda: None))
        identity, successor = str(uuid.uuid4()), str(uuid.uuid4())
        worker.STORE.create(identity, execution_timeout_seconds=TEST_EXECUTION_SECONDS)
        worker.STORE.jobs[identity].submitted = True
        queue.put((0, identity, {}, {}, []))
        _, task = queue.get()
        interrupted = False

        def interrupt():
            nonlocal interrupted
            interrupted = True

        try:
            with patch.object(server, 'prompt_queue', queue, create=True), patch('nodes.interrupt_processing', side_effect=interrupt) as native_interrupt:
                await worker.release(SimpleNamespace(match_info={'job': identity}))
                self.assertTrue(interrupted)
                # execute_async resets an interrupt sent during the get/execute handoff.
                interrupted = False
                worker.reap_queue(queue)
                self.assertTrue(interrupted)
                self.assertTrue(worker.STORE.jobs[identity].release)
                queue.task_done(task, {}, None)
                queue.put((1, successor, {}, {}, []))
                queue.get()
                interrupted = False
                worker.reap_queue(queue)
                self.assertFalse(interrupted)
                self.assertEqual(native_interrupt.call_count, 2)
                self.assertNotIn(identity, worker.STORE.jobs)
                self.assertNotIn(identity, queue.history)
        finally:
            worker.STORE.jobs.clear()

    async def test_readiness_requires_native_privacy_flags(self):
        from comfy.cli_args import parser

        safe_flags = dict(disable_metadata=True, offline=True, disable_partner_nodes=True,
                          disable_assets=True, disable_all_custom_nodes=True,
                          enable_manager=False, tls_keyfile='key', tls_certfile='cert',
                          database_url='sqlite:///:memory:')
        with patch.object(worker, 'WRITE_GUARD', True), \
                patch.object(worker.logging.root, 'manager', SimpleNamespace(disable=worker.logging.CRITICAL)), \
                patch.dict(worker.os.environ, {'ATELIER_PRIVATE_WORKER': '1'}):
            for cache_flags, expected in (([], True), (['--cache-ram'], True),
                                           (['--cache-ram', '0'], True),
                                           (['--cache-ram', '6', '12'], True),
                                           (['--cache-classic'], True),
                                           (['--cache-none'], False), (['--cache-lru', '2'], False)):
                args = parser.parse_args(cache_flags)
                vars(args).update(safe_flags)
                with self.subTest(cache_flags=cache_flags), patch.object(worker, 'args', args):
                    self.assertIsInstance(args.cache_ram, list)
                    self.assertEqual(worker.host_ready(), expected)
                    if expected:
                        for flag in ('disable_metadata', 'offline', 'disable_partner_nodes',
                                     'disable_assets', 'disable_all_custom_nodes'):
                            with self.subTest(weakened_flag=flag):
                                setattr(args, flag, False)
                                self.assertFalse(worker.host_ready())
                                setattr(args, flag, True)
            # Older native argument namespaces do not expose RAM caching.
            args = SimpleNamespace(**safe_flags, cache_classic=True)
            with patch.object(worker, 'args', args):
                self.assertTrue(worker.host_ready())
                args.cache_classic = False
                self.assertFalse(worker.host_ready())

    async def test_routes_and_native_media(self):
        client = TestClient(TestServer(server.app))
        await client.start_server()
        headers = {'Authorization': 'Bearer ' + worker.TOKEN}
        try:
            self.assertEqual((await client.get('/atelier/v1/privacy')).status, 401)
            self.assertEqual((await client.post('/upload/image', headers=headers)).status, 404)
            identity, asset = str(uuid.uuid4()), str(uuid.uuid4())
            response = await client.post('/atelier/v1/jobs/' + identity, headers=headers, json={'executionTimeoutSeconds': TEST_EXECUTION_SECONDS})
            self.assertEqual(response.status, 200)
            self.assertTrue((await response.json())['ready'])
            self.assertTrue(worker.HAS_RUN)  # includes jobs shorter than a reaper tick
            image = Image.new('RGBA', (32, 32), (255, 0, 0, 128))
            buf = io.BytesIO()
            image.save(buf, format='PNG')
            self.assertEqual((await client.put(f'/atelier/v1/jobs/{identity}/inputs/{asset}',
                                              data=buf.getvalue(), headers=headers)).status, 200)
            pixels, mask = worker.AtelierLoadImage().load(identity + ':' + asset)
            self.assertEqual(tuple(pixels.shape), (1, 32, 32, 3))
            self.assertAlmostEqual(mask[0, 0, 0].item(), 127 / 255, places=5)

            audio = {'waveform': torch.zeros((1, 2, 48000)), 'sample_rate': 48000}
            components = worker.Types.VideoComponents(images=pixels.repeat(24, 1, 1, 1),
                                                       frame_rate=Fraction(24), audio=audio)
            native = worker.InputImpl.VideoFromComponents(components)
            result = worker.AtelierSaveVideo().save(native, identity, 'mp4', 'h264')
            output = result['ui']['videos'][0]
            response = await client.get(f'/atelier/v1/jobs/{identity}/outputs/{output["filename"]}', headers=headers)
            data = await response.read()
            self.assertEqual(response.status, 200)
            self.assertIn(b'ftyp', data[:32])
            self.assertNotIn(b'prompt', data)
            imported = str(uuid.uuid4())
            worker.STORE.put(identity, imported, data)
            video = worker.AtelierLoadVideo().load(identity + ':' + imported)[0]
            decoded = video.get_components()
            self.assertEqual(decoded.images.shape[0], 24)
            self.assertIsNotNone(decoded.audio)
            self.assertEqual(decoded.frame_rate, Fraction(24))
            # Invalid boundary nodes and cross-job handles are rejected before queueing.
            with self.assertRaises(ValueError):
                worker.validate_graph({'prompt_id': identity, 'prompt': {'1': {'class_type': 'SaveImage', 'inputs': {}}}})
            with self.assertRaises(ValueError):
                worker.validate_graph({'prompt_id': identity, 'prompt': {'1': {'class_type': 'AtelierLoadImage',
                                      'inputs': {'image': str(uuid.uuid4()) + ':' + asset}}}})
            worker.validate_graph({'prompt_id': identity, 'prompt': {'1': {'class_type': 'AtelierLoadImage',
                                  'inputs': {'image': identity + ':' + asset}}}})
            worker.STORE.reap(set())
            self.assertIn(identity, worker.STORE.jobs)  # submission in progress cannot race expiry
        finally:
            await client.close()
            worker.STORE.jobs.clear()


if __name__ == '__main__':
    unittest.main()
