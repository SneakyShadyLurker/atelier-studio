"""Supervisor for the single, dedicated Atelier ComfyUI instance on this host."""
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent


def endpoint():
    """Listen address and port: worker.json beside this script, written by
    provisioning. ATELIER_WORKER_HOST and ATELIER_WORKER_PORT override it for
    tests. The address has no default; the port defaults to 7860."""
    try:
        config = json.loads((ROOT / 'worker.json').read_text())
    except (OSError, ValueError):
        config = {}
    if not isinstance(config, dict):
        config = {}
    host = os.environ.get('ATELIER_WORKER_HOST') or config.get('address')
    port = os.environ.get('ATELIER_WORKER_PORT') or config.get('port', 7860)
    if isinstance(port, str) and port.isdecimal():
        port = int(port)
    if not isinstance(host, str) or not host or type(port) is not int or not 0 < port < 65536:
        sys.exit('worker.json must name the listen address (and an optional port); run provisioning first.')
    return host, str(port)


HOST, PORT = endpoint()
URL_HOST = f'[{HOST}]' if ':' in HOST else HOST
# Liveness covers a blocked event loop, which the in-process reaper cannot see.
# Cold startup has a five-minute budget. Once ready, a restart needs nine
# consecutive failed probes 15 seconds apart: two minutes of silence.
PROBE_INTERVAL_SECONDS = 15
PROBE_TIMEOUT_SECONDS = 10
PROBE_FAILURES = 9
STARTUP_TIMEOUT_SECONDS = 300
RESTART_INITIAL_SECONDS = 2
RESTART_MAX_SECONDS = 60
# A kernel-owned lifetime lock works across desktop/SSH privilege boundaries,
# unlike inspecting another process's command line. The empty file holds no
# prompts or media. Windows closes the handle automatically on process death.
if sys.platform == 'win32':
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    instance_handle = kernel.CreateFileW(str(ROOT / 'atelier-private.instance.lock'),
                                        0xC0000000, 0, None, 4, 0x80, None)
    if instance_handle == ctypes.c_void_p(-1).value:
        sys.exit(1)

    class BasicLimits(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                    ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD),
                    ('SchedulingClass', wintypes.DWORD)]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', BasicLimits), ('IoInfo', ctypes.c_uint64 * 6),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    # Join before creating any child. Windows atomically inherits job membership
    # on child creation; there is no runnable, uncontained post-Popen interval.
    job_handle = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not job_handle or not kernel.SetInformationJobObject(job_handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        sys.exit(1)
    if not kernel.AssignProcessToJobObject(job_handle, kernel.GetCurrentProcess()):
        sys.exit(1)


def stop(child):
    child.terminate()
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        child.kill()


SECRETS = ROOT / 'atelier-private-secrets'
env = os.environ.copy()
env['ATELIER_PRIVATE_WORKER'] = '1'
env['ATELIER_WORKER_TOKEN'] = (SECRETS / 'token').read_text().strip()
env['PYTHONDONTWRITEBYTECODE'] = '1'
command = [sys.executable, '-s', str(ROOT / 'ComfyUI' / 'main.py'),
           '--windows-standalone-build', '--disable-auto-launch', '--listen', HOST, '--port', PORT,
           '--tls-keyfile', str(SECRETS / 'key.pem'), '--tls-certfile', str(SECRETS / 'cert.pem'),
           '--disable-metadata', '--offline', '--disable-assets', '--disable-all-custom-nodes',
           '--whitelist-custom-nodes', 'atelier_private', 'ComfyUI-Krea2-Ostris-Edit',
           '--cache-ram', '--database-url', 'sqlite:///:memory:',
           '--fast', 'fp16_accumulation', '--force-channels-last', '--fast-disk',
           '--preview-method', 'none']
# Same authenticated, pinned-certificate route as the launcher; never via a proxy.
probe_request = urllib.request.Request(f'https://{URL_HOST}:{PORT}/atelier/v1/privacy',
                                       headers={'Authorization': 'Bearer ' + env['ATELIER_WORKER_TOKEN']})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(
    context=ssl.create_default_context(cafile=str(SECRETS / 'cert.pem'))))


def probe():
    """Return (answered, ready). Errors stay silent: no console or file logs."""
    try:
        with opener.open(probe_request, timeout=PROBE_TIMEOUT_SECONDS) as response:
            status = json.loads(response.read(65536))
            return response.status == 200, isinstance(status, dict) and status.get('ready') is True
    except Exception:
        return False, False


# Core retains its last execution stack. The extension exits after its configured
# idle interval or a stuck execution, and this supervisor starts a clean process.
restart_delay = RESTART_INITIAL_SECONDS
while not (ROOT / 'atelier-private.stop').exists():
    with open(os.devnull, 'wb') as sink:
        child = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=sink, stderr=sink,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        started_at = time.monotonic()
        armed, failures, next_probe = False, 0, started_at + PROBE_INTERVAL_SECONDS
        while child.poll() is None:
            if (ROOT / 'atelier-private.stop').exists():
                stop(child)
                break
            if not armed and time.monotonic() - started_at >= STARTUP_TIMEOUT_SECONDS:
                stop(child)
                break
            if time.monotonic() >= next_probe:
                next_probe = time.monotonic() + PROBE_INTERVAL_SECONDS
                answered, ready = probe()
                if not armed and time.monotonic() - started_at >= STARTUP_TIMEOUT_SECONDS:
                    stop(child)
                    break
                armed = armed or ready
                if ready:
                    restart_delay = RESTART_INITIAL_SECONDS
                failures = 0 if answered else failures + 1
                if armed and failures >= PROBE_FAILURES:
                    stop(child)
                    break
            time.sleep(1)
    # Stop remains responsive even during repeated startup failures.
    restart_at = time.monotonic() + restart_delay
    while not (ROOT / 'atelier-private.stop').exists() and time.monotonic() < restart_at:
        time.sleep(min(1, restart_at - time.monotonic()))
    restart_delay = min(RESTART_MAX_SECONDS, restart_delay * 2)
