"""Bounded, process-local payload leases. No filesystem or database backing."""
import io
import threading
import time
from dataclasses import dataclass, field

MAX_BYTES = 512 * 1024 * 1024
MAX_JOBS = 4
PRE_SUBMIT_SECONDS = 120
TERMINAL_SECONDS = 120
TERMINAL_MAX_SECONDS = 600
MAX_PNG_BYTES = 50 * 1024 * 1024
MAX_IMAGES = 4
MAX_TOMBSTONES = 256
# Busy lease requests wait in arrival order. Clients re-poll every second, so a
# waiter silent for longer than this has gone and loses its place.
WAIT_STALE_SECONDS = 5
MAX_WAITING = 64
# Native interruption is cooperative. Released work must stop within this grace,
# and every execution has an immutable budget supplied at admission.
RELEASE_GRACE_SECONDS = 60
OWNER_IDLE_SECONDS = 120
MAX_EXECUTION_SECONDS = 24 * 60 * 60


class WorkerBusy(ValueError):
    def __init__(self, message, position=None):
        super().__init__(message)
        self.position = position


class DuplicateJob(ValueError):
    pass


class BoundedBuffer(io.BytesIO):
    def __init__(self, limit=None):
        super().__init__()
        self.limit = MAX_BYTES if limit is None else limit

    def write(self, data):
        if self.tell() + len(data) > self.limit:
            raise ValueError("memory output exceeds limit")
        return super().write(data)


@dataclass
class Job:
    created: float
    execution_timeout_seconds: int
    owner_seen: float
    inputs: dict = field(default_factory=dict)
    uploads: dict = field(default_factory=dict)
    outputs: dict = field(default_factory=dict)
    output_types: dict = field(default_factory=dict)
    previews: bool = True
    image_outputs: bool = False
    outcome: str | None = None
    submitting: bool = False
    submitted: bool = False
    terminal: float | None = None
    renewed: float | None = None
    release: bool = False


class Store:
    def __init__(self, clock=time.monotonic):
        self.jobs = {}
        self.cancelled = {}
        # UUID -> last poll time, in arrival order. IDs only, never content.
        self.waiting = {}
        self.lock = threading.RLock()
        self.clock = clock

    def _reap_cancelled(self):
        now = self.clock()
        for identity, created in list(self.cancelled.items()):
            if now - created >= PRE_SUBMIT_SECONDS:
                del self.cancelled[identity]

    def check_identity(self, identity):
        with self.lock:
            self._reap_cancelled()
            if identity in self.jobs or identity in self.cancelled:
                raise DuplicateJob("job unavailable")

    def cancel(self, identity):
        """Caller holds queue mutex. Unknown IDs fence late reservation POSTs."""
        with self.lock:
            self._reap_cancelled()
            self.waiting.pop(identity, None)
            job = self.jobs.get(identity)
            if job is not None:
                job.release = True
                return True
            if identity not in self.cancelled:
                if len(self.cancelled) >= MAX_TOMBSTONES:
                    raise WorkerBusy("worker busy")
                self.cancelled[identity] = self.clock()
            return False

    def create(self, identity, *, execution_timeout_seconds, previews=True, image_outputs=False):
        with self.lock:
            if type(previews) is not bool or type(image_outputs) is not bool:
                raise ValueError("invalid controls")
            if type(execution_timeout_seconds) is not int or not 1 <= execution_timeout_seconds <= MAX_EXECUTION_SECONDS:
                raise ValueError("invalid execution budget")
            self.check_identity(identity)
            if len(self.jobs) >= MAX_JOBS:
                raise WorkerBusy("worker busy")
            now = self.clock()
            self.jobs[identity] = Job(now, previews=previews, image_outputs=image_outputs,
                                      execution_timeout_seconds=execution_timeout_seconds, owner_seen=now)

    def admit(self, identity, active, *, execution_timeout_seconds, **controls):
        """Caller holds the native queue mutex and has refreshed terminal state.

        A lease owns preparation and execution, but terminal payload retention
        does not own the execution slot. Native activity always wins over a
        release flag or a cached terminal outcome.
        """
        with self.lock:
            self.check_identity(identity)
            self._reap_waiting()
            busy = (active or len(self.jobs) >= MAX_JOBS or self._total_bytes() >= MAX_BYTES
                    or any(job.terminal is None for job in self.jobs.values()))
            # A free slot belongs to the head of the line, or anyone if none waits.
            if not busy and next(iter(self.waiting), identity) == identity:
                self.create(identity, execution_timeout_seconds=execution_timeout_seconds, **controls)
                self.waiting.pop(identity, None)
                return
            if identity in self.waiting or len(self.waiting) < MAX_WAITING:
                # Updating a key keeps its place; only a new waiter joins the back.
                self.waiting[identity] = self.clock()
                raise WorkerBusy("worker busy", list(self.waiting).index(identity) + 1)
            raise WorkerBusy("worker busy")

    def _reap_waiting(self):
        now = self.clock()
        for identity, seen in list(self.waiting.items()):
            if now - seen > WAIT_STALE_SECONDS:
                del self.waiting[identity]

    def put(self, identity, asset, value, output=False):
        with self.lock:
            job = self.jobs[identity]
            target = job.outputs if output else job.inputs
            if not output:
                self._input_job(identity)
            if asset in target or (not output and asset in job.uploads) or len(target) + (0 if output else len(job.uploads)) >= 3:
                raise ValueError("asset limit")
            if len(value) + self._total_bytes() > MAX_BYTES:
                raise ValueError("memory limit")
            if output and (job.release or self._expired(job)):
                raise ValueError("job unavailable")
            target[asset] = value
            if output:
                job.output_types[asset] = 'video/mp4'

    def image_output_job(self, identity):
        with self.lock:
            job = self.jobs[identity]
            if not job.image_outputs or job.release or self._expired(job):
                raise ValueError("image outputs unavailable")
            return job

    def put_images(self, identity, images):
        """Commit a complete ordered batch atomically against the shared budget."""
        with self.lock:
            job = self.image_output_job(identity)
            if not 1 <= len(images) <= MAX_IMAGES or len(job.outputs) + len(images) > MAX_IMAGES:
                raise ValueError("asset limit")
            assets = [asset for asset, _ in images]
            if len(set(assets)) != len(assets) or any(asset in job.outputs for asset in assets):
                raise ValueError("asset limit")
            if any(not 0 < len(value) <= MAX_PNG_BYTES for _, value in images):
                raise ValueError("image byte limit")
            if self._total_bytes() + sum(len(value) for _, value in images) > MAX_BYTES:
                raise ValueError("memory limit")
            for asset, value in images:
                job.outputs[asset] = value
                job.output_types[asset] = 'image/png'

    def _expired(self, job):
        now = self.clock()
        return ((job.terminal is not None and (
                    now - max(job.terminal, job.renewed or job.terminal) >= TERMINAL_SECONDS
                    or now - job.terminal >= TERMINAL_MAX_SECONDS))
                or (not job.submitted and not job.submitting
                    and now - job.created >= PRE_SUBMIT_SECONDS))

    def renew(self, identity):
        with self.lock:
            job = self.jobs[identity]
            if job.release or self._expired(job):
                raise KeyError(identity)
            # Active renewals must not change the first terminal timestamp.
            # Only terminal owners can extend the idle grace.
            if job.terminal is not None:
                job.renewed = self.clock()

    def snapshot_terminal(self, identity, outcome):
        with self.lock:
            job = self.jobs.get(identity)
            if job is not None and job.outcome is None:
                job.outcome = outcome
                if job.terminal is None:
                    job.terminal = self.clock()
                job.inputs.clear()

    def status(self, identity, *, queued=False, running=False):
        with self.lock:
            job = self.jobs[identity]
            if self._expired(job):
                raise KeyError(identity)
            if queued or running or job.submitting or job.submitted:
                # A late poll cannot revive abandoned or explicitly released
                # execution. Terminal retention remains a separate clock.
                self.release_abandoned({identity})
                if not job.release and job.terminal is None:
                    job.owner_seen = self.clock()
            state = ('released' if job.release else 'running' if running else 'queued' if queued
                     else job.outcome or ('failed' if job.terminal is not None else
                                          'queued' if job.submitted or job.submitting else 'leased'))
            outputs = [] if job.release else [
                {'id': asset, 'bytes': len(value), 'mediaType': job.output_types[asset]}
                for asset, value in job.outputs.items()]
            return {'state': state, 'outputs': outputs}

    def release_abandoned(self, active):
        """Caller holds queue mutex; owner silence uses the normal release fence."""
        with self.lock:
            now = self.clock()
            for identity in active:
                job = self.jobs.get(identity)
                if job is not None and job.terminal is None and now - job.owner_seen >= OWNER_IDLE_SECONDS:
                    job.release = True

    def _input_job(self, identity):
        job = self.jobs[identity]
        if job.release or job.submitted or job.submitting or self.clock() - job.created >= PRE_SUBMIT_SECONDS:
            raise ValueError("job unavailable")
        return job

    def _total_bytes(self):
        return (sum(len(b) for j in self.jobs.values() for d in (j.inputs, j.outputs) for b in d.values())
                + sum(b.tell() for j in self.jobs.values() for b in j.uploads.values()))

    def reserve_input(self, identity, asset):
        with self.lock:
            job = self._input_job(identity)
            if asset in job.inputs or asset in job.uploads or len(job.inputs) + len(job.uploads) >= 3:
                raise ValueError("asset limit")
            buffer = BoundedBuffer()
            job.uploads[asset] = buffer
            return buffer

    def append_input(self, identity, asset, buffer, chunk):
        with self.lock:
            job = self._input_job(identity)
            if job.uploads.get(asset) is not buffer:
                raise ValueError("upload unavailable")
            if self._total_bytes() + len(chunk) > MAX_BYTES:
                raise ValueError("memory limit")
            buffer.write(chunk)

    def commit_input(self, identity, asset, buffer):
        with self.lock:
            job = self._input_job(identity)
            if job.uploads.get(asset) is not buffer:
                raise ValueError("upload unavailable")
            # The bytes already occupy the shared budget; transfer ownership.
            job.inputs[asset] = buffer.getvalue()
            del job.uploads[asset]

    def discard_input(self, identity, asset, buffer):
        with self.lock:
            job = self.jobs.get(identity)
            if job is not None and job.uploads.get(asset) is buffer:
                del job.uploads[asset]
            buffer.close()

    def get(self, identity, asset, output=False):
        with self.lock:
            job = self.jobs[identity]
            if output and (job.release or self._expired(job)):
                raise KeyError(identity)
            return (job.outputs if output else job.inputs)[asset]

    def output(self, identity, asset):
        with self.lock:
            return self.get(identity, asset, output=True), self.jobs[identity].output_types[asset]

    def reap(self, active):
        """Caller holds queue mutex, so task_done cannot insert history later."""
        with self.lock:
            now = self.clock()
            self._reap_cancelled()
            self._reap_waiting()
            removed = []
            for identity, job in list(self.jobs.items()):
                if identity in active or job.submitting:
                    continue
                if job.submitted and job.terminal is None:
                    job.terminal = now
                    job.inputs.clear()
                if job.release or self._expired(job):
                    for buffer in job.uploads.values():
                        buffer.close()
                    job.uploads.clear()
                    del self.jobs[identity]
                    removed.append(identity)
            return removed


class Watchdog:
    """Decides when native execution can no longer be trusted to finish."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.running = {}
        self.released = {}

    def observe(self, running, released, execution_budgets):
        """Caller samples running prompt IDs and their release intent each tick."""
        now = self.clock()
        self.running = {identity: self.running.get(identity, now) for identity in running}
        self.released = {identity: self.released.get(identity, now)
                         for identity in running if identity in released}
        return (any(now - since >= RELEASE_GRACE_SECONDS for since in self.released.values())
                or any(identity not in execution_budgets or now - since >= execution_budgets[identity]
                       for identity, since in self.running.items()))
