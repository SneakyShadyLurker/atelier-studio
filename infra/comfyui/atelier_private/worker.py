"""Private transport for a dedicated ComfyUI worker. Fail closed by default."""
import asyncio
import hashlib
import hmac
import io
import json
import logging
import os
from pathlib import Path
import sys
import time
import uuid

import numpy as np
import torch
from PIL import Image, ImageOps
from aiohttp import web
from comfy.cli_args import args
from comfy_api.latest import InputImpl, Types
from server import PromptServer
from .store import (Store, Watchdog, BoundedBuffer, WorkerBusy, DuplicateJob, MAX_PNG_BYTES,
                    MAX_BYTES, MAX_JOBS, MAX_IMAGES, PRE_SUBMIT_SECONDS,
                    TERMINAL_SECONDS, TERMINAL_MAX_SECONDS, MAX_EXECUTION_SECONDS)

STORE = Store()
WATCHDOG = Watchdog()
SERVER = PromptServer.instance
TOKEN = os.environ.get('ATELIER_WORKER_TOKEN', '')
ALLOWED = set(json.loads(Path(__file__).with_name('allowed_nodes.json').read_text()))
# Import-time fingerprint covers only non-secret transport source, never host
# paths, environment, credentials, weights or runtime state.
WORKER_BUILD = hashlib.sha256(b''.join(
    Path(__file__).with_name(name).read_bytes()
    for name in ('worker.py', 'store.py', 'allowed_nodes.json'))).hexdigest()
HOST_READY = False
LAST_JOB = time.monotonic()
HAS_RUN = False
WRITE_GUARD = False
IDLE_RESTART_SECONDS = 180 * 60
IDLE_UNLOAD_SECONDS = 10 * 60
UNLOADED_AT = None
LAST_PROMPT_ID = None


def deny_persistent_writes(event, arguments):
    # Defense in depth for Python/custom-node writers. Native encoders must
    # still use BytesIO; this hook is not an OS sandbox for arbitrary C code.
    if event == 'open':
        path, mode, flags = arguments
        writing = flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
        if writing and str(path).lower() != os.devnull.lower():
            raise PermissionError('persistent writes disabled in Atelier worker')
    if event in ('os.rename', 'os.remove', 'os.mkdir', 'os.rmdir', 'os.link', 'os.symlink'):
        raise PermissionError('filesystem mutations disabled in Atelier worker')


def valid_id(value):
    try:
        return str(uuid.UUID(value, version=4)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def host_ready():
    # Paging is explicitly accepted by the operator. This gate covers ComfyUI's
    # own transport, nodes, metadata, logging and filesystem writers.
    # Match v0.42.3's selector: classic takes precedence; otherwise RAM pressure
    # is the default unless LRU or no-cache is selected.
    # https://github.com/Comfy-Org/ComfyUI/blob/v0.42.3/main.py#L301
    return (len(TOKEN) >= 32 and logging.root.manager.disable >= logging.CRITICAL and WRITE_GUARD and os.environ.get('ATELIER_PRIVATE_WORKER') == '1'
            and args.disable_metadata and args.offline and args.disable_partner_nodes and args.disable_assets and args.disable_all_custom_nodes
            and (getattr(args, 'cache_classic', False)
                 or (getattr(args, 'cache_ram', None) is not None
                     and not getattr(args, 'cache_none', False) and getattr(args, 'cache_lru', 0) <= 0))
            and not args.enable_manager and bool(args.tls_keyfile)
            and bool(args.tls_certfile) and args.database_url == 'sqlite:///:memory:')


def input_bytes(token):
    identity, asset = token.split(':')
    return STORE.get(identity, asset)


class AtelierLoadImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'image': ('STRING',)}}
    RETURN_TYPES = ('IMAGE', 'MASK')
    FUNCTION = 'load'
    CATEGORY = 'Atelier/private'

    def load(self, image):
        with Image.open(io.BytesIO(input_bytes(image))) as source:
            if source.width * source.height > 32_000_000:
                raise ValueError('image pixel limit')
            source = ImageOps.exif_transpose(source)
            if source.mode == 'I':
                source = source.point(lambda i: i * (1 / 255))
            rgb = np.array(source.convert('RGB')).astype(np.float32) / 255.0
            if 'A' in source.getbands():
                mask = 1.0 - torch.from_numpy(np.array(source.getchannel('A')).astype(np.float32) / 255.0)
            else:
                mask = torch.zeros((64, 64), dtype=torch.float32)
        return (torch.from_numpy(rgb)[None,], mask.unsqueeze(0))


class AtelierLoadVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'file': ('STRING',)}}
    RETURN_TYPES = ('VIDEO',)
    FUNCTION = 'load'
    CATEGORY = 'Atelier/private'

    def load(self, file):
        return (InputImpl.VideoFromFile(io.BytesIO(input_bytes(file))),)


class AtelierSaveVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'video': ('VIDEO',), 'job_id': ('STRING',),
                             'format': (['mp4'],), 'codec': (['h264'],)}}
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = 'save'
    CATEGORY = 'Atelier/private'

    def save(self, video, job_id, format, codec):
        with BoundedBuffer() as buffer:
            video.save_to(buffer, format=Types.VideoContainer(format), codec=Types.VideoCodec(codec), metadata=None)
            asset = str(uuid.uuid4())
            STORE.put(job_id, asset, buffer.getvalue(), output=True)
        return {'ui': {'videos': [{'filename': asset, 'subfolder': job_id, 'type': 'atelier-memory'}]}}


class AtelierSaveImages:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'images': ('IMAGE',), 'job_id': ('STRING',)}}
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = 'save'
    CATEGORY = 'Atelier/private'

    def save(self, images, job_id):
        STORE.image_output_job(job_id)
        if len(images.shape) != 4 or not 1 <= images.shape[0] <= 4 or not 0 < images.shape[1] * images.shape[2] <= 32_000_000:
            raise ValueError('image batch limit')
        outputs = []
        for image in images:
            pixels = np.clip(image.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
            with BoundedBuffer(MAX_PNG_BYTES) as buffer:
                Image.fromarray(pixels).save(buffer, format='PNG')
                outputs.append((str(uuid.uuid4()), buffer.getvalue()))
        STORE.put_images(job_id, outputs)
        return {'ui': {'images': [{'filename': asset, 'subfolder': job_id, 'type': 'atelier-memory'}
                                  for asset, _ in outputs]}}


NODE_CLASS_MAPPINGS = {cls.__name__: cls for cls in (AtelierLoadImage, AtelierLoadVideo, AtelierSaveVideo, AtelierSaveImages)}


def validate_graph(body):
    identity = body.get('prompt_id')
    graph = body.get('prompt')
    with STORE.lock:
        job = STORE.jobs.get(identity)
        if job is None or job.submitted or job.submitting or job.release or STORE._expired(job) or job.uploads or not isinstance(graph, dict) or not 1 <= len(graph) <= 64:
            raise ValueError('invalid job')
        for node in graph.values():
            kind = node['class_type']
            if kind not in ALLOWED:
                raise ValueError('node not allowed')
            fields = node['inputs']
            if kind in ('AtelierLoadImage', 'AtelierLoadVideo'):
                token = fields['image' if kind == 'AtelierLoadImage' else 'file']
                owner, asset = token.split(':')
                if owner != identity or asset not in job.inputs:
                    raise ValueError('invalid input owner')
            if kind in ('AtelierSaveVideo', 'AtelierSaveImages') and fields.get('job_id') != identity:
                raise ValueError('invalid output owner')
            if kind == 'AtelierSaveImages' and not job.image_outputs:
                raise ValueError('image outputs unavailable')
        # Reserved before awaiting Comfy validation to prevent duplicate submits.
        # Give accepted work a full observation window after bounded preparation.
        job.owner_seen = STORE.clock()
        job.submitting = True
    return identity


@web.middleware
async def private_boundary(request, handler):
    global LAST_PROMPT_ID
    if not TOKEN or not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
        return web.Response(status=401)
    path = request.path
    allowed = path.startswith('/atelier/v1/') or path in ('/system_stats', '/object_info', '/free', '/ws', '/prompt')
    if not allowed:
        return web.Response(status=404)
    if path != '/atelier/v1/privacy' and not HOST_READY:
        return web.Response(status=503)
    try:
        if path == '/prompt':
            if request.method != 'POST':
                return web.Response(status=405)
            body = await request.json()
            with SERVER.prompt_queue.mutex:
                identity = validate_graph(body)
                # Publish every possible model-loading attempt before native
                # validation yields, including rejected or canceled attempts.
                LAST_PROMPT_ID = identity
            # No caller-provided workflow metadata, plugins or hidden secrets.
            image_job = any(node['class_type'] == 'AtelierSaveImages' for node in body['prompt'].values())
            with STORE.lock:
                previews = STORE.jobs[identity].previews
            body['extra_data'] = {'preview_method': 'auto' if image_job and previews else 'none'}
            request._read_bytes = json.dumps(body).encode()
            try:
                response = await handler(request)
            finally:
                queue = SERVER.prompt_queue
                with queue.mutex:
                    with STORE.lock:
                        STORE.jobs[identity].submitting = False
                        STORE.jobs[identity].submitted = True
                        released = STORE.jobs[identity].release
                    if released:
                        queue.delete_queue_item(lambda item: item[1] == identity)
                        queue.interrupt_if_running(identity)
            if response.status != 200:
                with STORE.lock:
                    STORE.jobs[identity].release = True
                return web.json_response({'error': 'workflow rejected'}, status=400)
            return response
        if path == '/free':
            if request.method != 'POST':
                return web.Response(status=405)
            # Parse a small body before locking. Never await downstream native
            # middleware while holding a threading mutex on the event loop.
            raw = bytearray()
            async with asyncio.timeout(4):
                async for chunk in request.content.iter_chunked(1024):
                    raw.extend(chunk)
                    if len(raw) > 1024:
                        return web.Response(status=400)
            controls = json.loads(raw)
            if (not isinstance(controls, dict) or set(controls) - {'unload_models', 'free_memory'}
                    or any(type(value) is not bool for value in controls.values())):
                return web.Response(status=400)
            queue = SERVER.prompt_queue
            with queue.mutex:
                if queue.queue or queue.currently_running:
                    return busy_response()
                # Same synchronous flags as native /free; no CUDA access here.
                for flag in ('unload_models', 'free_memory'):
                    if controls.get(flag, False):
                        queue.set_flag(flag, True)
            return web.json_response({}, headers={'Cache-Control': 'no-store'})
        return await handler(request)
    except DuplicateJob:
        return web.json_response({'error': 'job_unavailable'}, status=409,
                                 headers={'Cache-Control': 'no-store'})
    except WorkerBusy as busy:
        return busy_response(busy.position)
    except (ValueError, KeyError, TypeError, web.HTTPRequestEntityTooLarge):
        return web.Response(status=400)
    except Exception:
        # Neither raw exceptions nor tracebacks may reach server access logs.
        return web.Response(status=500)


SERVER.app.middlewares.insert(0, private_boundary)
SERVER.app._client_max_size = 2 * 1024 * 1024
# Disable library logging before any content can reach this worker.
logging.disable(logging.CRITICAL)


@SERVER.routes.get('/atelier/v1/privacy')
async def privacy(request):
    return web.json_response({'protocol': 2, 'ready': HOST_READY,
                             'worker_build': WORKER_BUILD,
                             'allowed_nodes': sorted(ALLOWED),
                             'limits': {'max_jobs': MAX_JOBS, 'max_payload_bytes': MAX_BYTES,
                                        'max_image_bytes': MAX_PNG_BYTES, 'max_images': MAX_IMAGES,
                                        'pre_submit_seconds': PRE_SUBMIT_SECONDS,
                                        'terminal_idle_seconds': TERMINAL_SECONDS,
                                        'terminal_max_seconds': TERMINAL_MAX_SECONDS,
                                        'max_execution_seconds': MAX_EXECUTION_SECONDS},
                             'capabilities': {'job_status': True, 'image_outputs': True, 'preview_control': True,
                                              'video_outputs': True, 'lease_renewal': True, 'job_admission': True,
                                              'execution_budget': True, 'residency_tracking': True}},
                            headers={'Cache-Control': 'no-store'})


def busy_response(position=None):
    # Clients parse this body strictly; the waiting-list place is a header only.
    headers = {'Retry-After': '1', 'Cache-Control': 'no-store'}
    if position is not None:
        headers['Atelier-Queue-Position'] = str(position)
    return web.json_response({'error': 'worker_busy'}, status=429, headers=headers)


@SERVER.routes.post('/atelier/v1/jobs/{job}')
async def create_job(request):
    global LAST_JOB, HAS_RUN
    identity = request.match_info['job']
    if not valid_id(identity):
        return web.Response(status=400)
    controls = await request.json() if request.can_read_body else {}
    if (not isinstance(controls, dict) or set(controls) - {'previews', 'imageOutputs', 'executionTimeoutSeconds'}
            or any(type(controls[key]) is not bool for key in ('previews', 'imageOutputs') if key in controls)
            or type(controls.get('executionTimeoutSeconds')) is not int
            or not 1 <= controls['executionTimeoutSeconds'] <= MAX_EXECUTION_SECONDS):
        return web.Response(status=400)
    queue = SERVER.prompt_queue
    with queue.mutex:
        # Identity conflicts are definitive even if this lease would be reaped.
        STORE.check_identity(identity)
        active, _ = reap_queue(queue)
        STORE.admit(identity, active, previews=controls.get('previews', True),
                    image_outputs=controls.get('imageOutputs', False),
                    execution_timeout_seconds=controls['executionTimeoutSeconds'])
        previous_prompt_id = LAST_PROMPT_ID
    # Record even short failures and unsubmitted uploads. Queue sampling alone
    # misses executions that complete between reaper ticks.
    LAST_JOB, HAS_RUN = time.monotonic(), True
    return web.json_response({'ok': True, 'protocol': 2, 'ready': True,
                             'previous_prompt_id': previous_prompt_id})


@SERVER.routes.put('/atelier/v1/jobs/{job}/inputs/{asset}')
async def upload(request):
    identity, asset = request.match_info['job'], request.match_info['asset']
    if not valid_id(asset):
        return web.Response(status=404)
    # Reserve before reading any body bytes; stored and in-flight payloads share
    # one budget. Store methods never acquire the queue mutex.
    try:
        buffer = STORE.reserve_input(identity, asset)
    except KeyError:
        return web.Response(status=404)
    # Raw streaming deliberately avoids aiohttp's multipart temporary files.
    try:
        async with asyncio.timeout(60):
            async for chunk in request.content.iter_chunked(64 * 1024):
                STORE.append_input(identity, asset, buffer, chunk)
        STORE.commit_input(identity, asset, buffer)
    finally:
        STORE.discard_input(identity, asset, buffer)
    return web.json_response({'ok': True})


@SERVER.routes.get('/atelier/v1/jobs/{job}/outputs/{asset}')
async def download(request):
    try:
        data, media_type = STORE.output(request.match_info['job'], request.match_info['asset'])
    except KeyError:
        return web.Response(status=404)
    return web.Response(body=data, content_type=media_type, headers={'Cache-Control': 'no-store'})


def snapshot_history(queue, active):
    """Queue mutex must be held; retain no native history content in the lease."""
    for identity, history in queue.history.items():
        if identity not in active:
            status = history.get('status') or {}
            outcome = 'completed' if status.get('status_str') == 'success' and status.get('completed') is True else 'failed'
            STORE.snapshot_terminal(identity, outcome)


@SERVER.routes.get('/atelier/v1/jobs/{job}')
async def job_status(request):
    identity = request.match_info['job']
    queue = SERVER.prompt_queue
    with queue.mutex:
        queued = {item[1] for item in queue.queue}
        running = {item[1] for item in queue.currently_running.values()}
        snapshot_history(queue, queued | running)
        try:
            result = STORE.status(identity, queued=identity in queued, running=identity in running)
        except KeyError:
            return web.Response(status=404)
    return web.json_response(result, headers={'Cache-Control': 'no-store'})


@SERVER.routes.delete('/atelier/v1/jobs/{job}')
async def release(request):
    identity = request.match_info['job']
    if not valid_id(identity):
        return web.Response(status=400)
    queue = SERVER.prompt_queue
    with queue.mutex:
        if STORE.cancel(identity):
            # Same primitives as native cancellation; never unscoped interrupt.
            queue.delete_queue_item(lambda item: item[1] == identity)
            queue.interrupt_if_running(identity)
    return web.json_response({'ok': True})


@SERVER.routes.post('/atelier/v1/jobs/{job}/renew')
async def renew_job(request):
    if request.can_read_body:
        return web.Response(status=400)
    try:
        STORE.renew(request.match_info['job'])
    except KeyError:
        return web.Response(status=404)
    return web.json_response({'ok': True}, headers={'Cache-Control': 'no-store'})


def reap_queue(queue):
    # Preserve queue-before-Store lock ordering, including cancellation retries.
    with queue.mutex:
        active = {item[1] for item in queue.queue} | {item[1] for item in queue.currently_running.values()}
        STORE.release_abandoned(active)
        with STORE.lock:
            released = {identity for identity, job in STORE.jobs.items() if job.release and identity in active}
        # Native get() publishes running before execute_async resets its flag.
        # Durable release intent retries that handoff until the job is terminal.
        for identity in released:
            queue.delete_queue_item(lambda item: item[1] == identity)
            queue.interrupt_if_running(identity)
        # Dequeued abandoned work no longer owns admission or payload lifetime.
        active = {item[1] for item in queue.queue} | {item[1] for item in queue.currently_running.values()}
        snapshot_history(queue, active)
        # History is not an Atelier persistence interface.
        for identity in list(queue.history):
            if identity not in active:
                queue.history.pop(identity, None)
        STORE.reap(active)
        with STORE.lock:
            idle = not active and not STORE.jobs
        return active, idle


def unload_when_idle(queue, now):
    """Release VRAM once per idle period through the flags native /free sets."""
    global UNLOADED_AT
    if not HAS_RUN or now - LAST_JOB < IDLE_UNLOAD_SECONDS or (UNLOADED_AT is not None and UNLOADED_AT >= LAST_JOB):
        return
    with queue.mutex:
        if queue.queue or queue.currently_running:
            return
        # set_flag wakes the idle native worker, which unloads models and resets
        # its caches outside this mutex; no CUDA access here.
        queue.set_flag('unload_models', True)
        queue.set_flag('free_memory', True)
        UNLOADED_AT = now


def execution_stuck(queue):
    with queue.mutex:
        running = {item[1] for item in queue.currently_running.values()}
        with STORE.lock:
            released = {identity for identity in running
                        if identity in STORE.jobs and STORE.jobs[identity].release}
            budgets = {identity: STORE.jobs[identity].execution_timeout_seconds
                       for identity in running if identity in STORE.jobs}
    return WATCHDOG.observe(running, released, budgets)


async def reaper():
    global HOST_READY, LAST_JOB, HAS_RUN
    checked = 0.0
    while True:
        now = time.monotonic()
        if now - checked >= 30:
            HOST_READY = host_ready()
            checked = now
        queue = SERVER.prompt_queue
        if queue is not None:
            active, idle = reap_queue(queue)
            if active:
                LAST_JOB, HAS_RUN = now, True
            if execution_stuck(queue):
                # Interruption is cooperative; a hung sampler or CUDA fault never
                # yields. Refuse new work, then let the supervisor start clean.
                HOST_READY = False
                os._exit(1)
            unload_when_idle(queue, now)
            if HAS_RUN and idle and now - LAST_JOB > IDLE_RESTART_SECONDS:
                # Core's worker stack keeps its last prompt even after cache reset.
                # A supervised restart also releases those references and VRAM.
                os._exit(0)
        await asyncio.sleep(1)


async def start(app):
    global WRITE_GUARD
    sys.addaudithook(deny_persistent_writes)
    WRITE_GUARD = True
    app['atelier_reaper'] = asyncio.create_task(reaper())


async def stop(app):
    app['atelier_reaper'].cancel()
    try:
        await app['atelier_reaper']
    except asyncio.CancelledError:
        pass
    STORE.jobs.clear()
    STORE.cancelled.clear()


SERVER.app.on_startup.append(start)
SERVER.app.on_cleanup.append(stop)
