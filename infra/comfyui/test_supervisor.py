"""Portable supervisor liveness checks: the real script, stubbed process/clock/HTTPS."""
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import ctypes

SCRIPT = Path(__file__).resolve().parent / 'private-worker.py'


class Child:
    def __init__(self, world):
        self.world, self.pid, self.stopped = world, 4242, False

    def poll(self):
        return 0 if self.stopped else None

    def terminate(self):
        self.stopped = True
        self.world.stops.append(self.world.now)

    kill = terminate

    def wait(self, timeout=None):
        return 0


class World:
    """Fake clock, child processes and privacy answers for one supervisor run."""

    def __init__(self, root, answers, stop_at):
        self.root, self.answers, self.stop_at = root, list(answers), stop_at
        self.now, self.children, self.stops, self.probes, self.proxies = 0.0, [], [], [], []
        self.urls = []
        self.starts, self.events, self.commands = [], [], []

    def sleep(self, seconds):
        self.now += seconds
        if self.now >= self.stop_at:
            (self.root / 'atelier-private.stop').touch()

    def popen(self, command, **kwargs):
        self.commands.append(command)
        self.starts.append(self.now)
        self.events.append('spawn')
        self.no_breakaway = not kwargs.get('creationflags', 0) & 0x01000000
        self.children.append(Child(self))
        return self.children[-1]

    def open(self, request, timeout):
        self.probes.append((self.now, timeout, request.headers))
        self.urls.append(request.url)
        self.now += 0.5
        answer = self.answers.pop(0) if self.answers else 'ready'
        if answer == 'late':
            self.now += 300
            answer = 'ready'
        if answer == 'fail':
            raise OSError('synthetic connection failure')
        body = b'{"protocol": 2, "ready": %s}' % (b'true' if answer == 'ready' else b'false')
        return SimpleNamespace(status=200, read=lambda limit: body)

    def run(self, *, windows=False, assignment=True, env=None):
        world = self

        class Response:
            def __init__(self, inner):
                self.inner = inner
                self.status = inner.status

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self, limit):
                return self.inner.read(limit)

        class Opener:
            def open(self, request, timeout):
                return Response(world.open(request, timeout))

        request_module = ModuleType('urllib.request')
        request_module.Request = lambda url, headers: SimpleNamespace(url=url, headers=headers)
        request_module.ProxyHandler = lambda proxies: world.proxies.append(proxies) or 'proxy'
        request_module.HTTPSHandler = lambda context: 'https'
        request_module.build_opener = lambda *handlers: Opener()
        urllib_module = ModuleType('urllib')
        urllib_module.request = request_module
        ssl_module = ModuleType('ssl')
        ssl_module.create_default_context = lambda cafile: SimpleNamespace(cafile=cafile)
        time_module = ModuleType('time')
        time_module.monotonic = lambda: world.now
        time_module.sleep = world.sleep
        process_module = ModuleType('subprocess')
        process_module.Popen = world.popen
        process_module.DEVNULL = -3
        process_module.TimeoutExpired = TimeoutError
        modules = {'urllib': urllib_module, 'urllib.request': request_module, 'ssl': ssl_module,
                   'time': time_module, 'subprocess': process_module}
        kernel = SimpleNamespace(**{name: Mock(return_value=1) for name in (
            'CreateFileW', 'CreateJobObjectW', 'SetInformationJobObject', 'GetCurrentProcess',
            'AssignProcessToJobObject', 'CloseHandle')})

        def assign(job, process):
            world.events.append('join')
            return assignment

        kernel.AssignProcessToJobObject.side_effect = assign
        environ = {key: value for key, value in os.environ.items()
                   if key not in ('ATELIER_WORKER_HOST', 'ATELIER_WORKER_PORT')}
        environ.update(env or {})
        with patch.dict(sys.modules, modules), patch('sys.platform', 'win32' if windows else 'linux'), \
                patch.dict(os.environ, environ, clear=True), \
                patch.object(ctypes, 'WinDLL', lambda *args, **kwargs: kernel, create=True):
            runpy.run_path(str(self.root / 'private-worker.py'), run_name='__main__')
        return self


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        shutil.copyfile(SCRIPT, self.root / 'private-worker.py')
        (self.root / 'atelier-private-secrets').mkdir()
        (self.root / 'atelier-private-secrets' / 'token').write_text('synthetic-token\n')
        self.write_endpoint({'address': '198.51.100.7', 'port': 7860})

    def write_endpoint(self, endpoint):
        (self.root / 'worker.json').write_text(json.dumps(endpoint))

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_unready_child_restarts_after_five_minutes_with_bounded_backoff(self):
        world = World(self.root, ['fail'] * 1000, stop_at=3000).run()
        self.assertGreaterEqual(len(world.children), 8)
        gaps = [start - stop for start, stop in zip(world.starts[1:], world.stops)]
        self.assertEqual(gaps[:7], [2, 4, 8, 16, 32, 60, 60])
        self.assertTrue(all(stop - start >= 300 for start, stop in zip(world.starts[:-1], world.stops)))

    def test_slow_healthy_startup_within_budget_is_not_restarted(self):
        world = World(self.root, ['fail'] * 18 + ['ready'] * 30, stop_at=600).run()
        self.assertEqual(len(world.children), 1)
        self.assertGreaterEqual(world.stops[0], 600)

    def test_stop_marker_interrupts_restart_backoff(self):
        world = World(self.root, ['fail'] * 100, stop_at=301.5).run()
        self.assertEqual(len(world.children), 1)
        self.assertEqual(world.now, world.stop_at)

    def test_readiness_returning_after_startup_deadline_does_not_arm_child(self):
        world = World(self.root, ['late', 'ready'], stop_at=700).run()
        self.assertGreaterEqual(len(world.children), 2)
        self.assertLess(world.stops[0], 400)

    def test_windows_supervisor_joins_job_before_any_child_is_created(self):
        world = World(self.root, ['ready'], stop_at=40).run(windows=True)
        self.assertEqual(world.events[:2], ['join', 'spawn'])
        self.assertTrue(world.no_breakaway)

    def test_windows_assignment_failure_never_starts_a_child(self):
        world = World(self.root, [], stop_at=40)
        with self.assertRaises(SystemExit):
            world.run(windows=True, assignment=False)
        self.assertEqual(world.events, ['join'])
        self.assertEqual(world.children, [])

    def test_restart_needs_two_minutes_of_consecutive_failures_after_ready(self):
        world = World(self.root, ['ready'] + ['fail'] * 9, stop_at=400).run()
        self.assertEqual(len(world.children), 2)
        failed = [at for at, _, _ in world.probes[1:10]]
        self.assertGreaterEqual(failed[-1] - failed[0], 120)
        self.assertEqual(world.stops[0], failed[-1] + 0.5)
        self.assertTrue(all(b - a >= 15 for a, b in zip(failed, failed[1:])))

    def test_one_answer_resets_the_failure_count(self):
        answers = ['ready'] + ['fail'] * 8 + ['alive'] + ['fail'] * 8 + ['ready'] * 20
        world = World(self.root, answers, stop_at=600).run()
        self.assertEqual(len(world.children), 1)

    def test_probe_is_authenticated_bounded_and_bypasses_proxies(self):
        world = World(self.root, ['ready'], stop_at=40).run()
        self.assertEqual(world.proxies, [{}])
        _, timeout, headers = world.probes[0]
        self.assertEqual(timeout, 10)
        self.assertEqual(headers, {'Authorization': 'Bearer synthetic-token'})


    def test_worker_json_port_drives_listener_and_probe(self):
        self.write_endpoint({'address': 'worker.example.internal', 'port': 7999})
        world = World(self.root, ['ready'], stop_at=40).run()
        command = world.commands[0]
        self.assertEqual(command[command.index('--listen') + 1], 'worker.example.internal')
        self.assertEqual(command[command.index('--port') + 1], '7999')
        self.assertEqual(world.urls[0], 'https://worker.example.internal:7999/atelier/v1/privacy')

    def test_port_defaults_to_7860_when_worker_json_omits_it(self):
        self.write_endpoint({'address': '198.51.100.7'})
        world = World(self.root, ['ready'], stop_at=40).run()
        self.assertEqual(world.urls[0], 'https://198.51.100.7:7860/atelier/v1/privacy')

    def test_environment_overrides_worker_json(self):
        world = World(self.root, ['ready'], stop_at=40).run(
            env={'ATELIER_WORKER_HOST': '127.0.0.1', 'ATELIER_WORKER_PORT': '8123'})
        command = world.commands[0]
        self.assertEqual(command[command.index('--listen') + 1], '127.0.0.1')
        self.assertEqual(world.urls[0], 'https://127.0.0.1:8123/atelier/v1/privacy')

    def test_missing_address_refuses_to_start(self):
        for endpoint in (None, {}, {'address': ''}, {'port': 7860}):
            with self.subTest(endpoint=endpoint):
                if endpoint is None:
                    (self.root / 'worker.json').unlink(missing_ok=True)
                else:
                    self.write_endpoint(endpoint)
                world = World(self.root, [], stop_at=40)
                with self.assertRaises(SystemExit):
                    world.run()
                self.assertEqual(world.children, [])

    def test_invalid_port_refuses_to_start(self):
        for port in (0, 65536, 'http', True):
            with self.subTest(port=port):
                self.write_endpoint({'address': '198.51.100.7', 'port': port})
                world = World(self.root, [], stop_at=40)
                with self.assertRaises(SystemExit):
                    world.run()
                self.assertEqual(world.children, [])


if __name__ == '__main__':
    unittest.main()
