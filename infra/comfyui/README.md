# Atelier private ComfyUI worker

The worker is included in this public repository. “Private” describes its
authenticated, in-memory transport; no private repository is required. This
installation procedure targets **Windows portable ComfyUI**, including its
embedded Python. It is not a generic Linux or macOS ComfyUI installer, and
Atelier does not support substituting plain ComfyUI for this worker.

Before provisioning, install the model weights and custom nodes required by
your chosen [local model graphs](../../docs/local-models.md). Weights and GPU
hardware are not supplied. The disabled MiniMax H3 graphs are templates that
must be verified on your own host before enabling them. For the application
server, start with [Deployment](../../docs/deployment.md).

This worker processes content in memory and returns it to Atelier for encrypted
storage. It runs as an exclusive mode of one Windows ComfyUI portable install;
the protocol itself has no fixed host or hardware identity. The adapter requires its authenticated TLS
handshake before uploading inputs or submitting prompts.

## Installation and host prerequisites

Stage this directory as `atelier-private-stage` directly inside the ComfyUI
portable install root (written `<root>` below); the existing embedded Python and
ComfyUI dependencies suffice. Run `test_store.py`, `test_supervisor.py` and
`test_worker.py` with `python_embeded\python.exe -B`. The first two are portable
(`test_store.py` also runs the `test_protocol.py` boundary checks). The last uses
the installed native media implementations and synthetic image/video/audio in memory.
The root `bun run test` also runs the portable store/protocol and supervisor
suites through `bun run test:comfyui`; local development and CI need Python 3.11+
as `python3`. The native media suite remains a separate staging check.

Run `provision-private.py <address> [--port 7860]` from the stage directory to
install the extension, supervisor and an account/SYSTEM-only credential
directory. `<address>` is the IP address or DNS name the api uses to reach the
worker; a wildcard address is refused. Provisioning creates a random worker
token and a one-year self-signed TLS certificate whose subject alternative name
is that address; existing credentials are preserved, so changing the address
needs a new key pair. It also writes `<root>\worker.json`. Transfer only the
token and public certificate to the api's secret configuration without printing
either. Configure:

- `COMFYUI_BASE_URL=https://<address>:<port>`
- `COMFYUI_ATELIER_TOKEN`: the token file's contents
- `COMFYUI_ATELIER_CA`: the PEM certificate, with newlines preserved

`worker.json` holds the non-secret endpoint, for example
`{"address": "<address>", "port": 7860}`. It is the single source of the listen
address and port for the supervisor, the launcher's listener check and its
readiness probe. The address has no default: without it the supervisor and the
launcher refuse to start rather than fall back to a wildcard listener. A
missing `port` means 7860. For tests only, `ATELIER_WORKER_HOST` and
`ATELIER_WORKER_PORT` override the file's values in the supervisor; the
launcher reads the file alone.

Provisioning runs `harden-install-permissions.ps1` after securing the credential
directory and before touching credentials or installing code. Stop the private
worker first: its lifetime lock, a concurrent launcher, any listener on the
worker port (`--port`, passed on as `-Port`, default 7860) or an installed/embedded-Python `main.py` process on another port makes
hardening fail. Process detection uses native CIM metadata without logging
command lines. The installation root becomes protected, with
inheritable FullControl for the current operator SID, SYSTEM and Administrators,
and Users ReadAndExecute. Native inheritance removes broad inherited writes;
owners, explicit descendant rules and protected credential ACLs stay intact.
The drive ACL is unchanged. Unsafe effective ancestor delete-child/ACL/ownership grants,
and DELETE grants on non-volume ancestors,
reparse points, unexpected owners and untrusted explicit mutation grants stop
the procedure. A full subtree scan verifies propagation, including the embedded
Python, site-packages, core, models, custom nodes and configuration.

Before applying, the helper saves root owner/group/DACL SDDL and protected or
explicit descendant ACLs as a uniquely named
`<root>\atelier-private-secrets\install-acl-before-*.json`. These recovery
files contain ACL metadata only. Before snapshot and application, the helper
requires time remaining for twice the measured prescan (at least five seconds)
plus a 60-second propagation margin. Insufficient budget stops before root
mutation; the estimate cannot predict every storage stall. The helper checks
its 540-second budget and provisioning enforces a 600-second process deadline,
reporting timeouts without a traceback. The prescan's cost grows with the
item count under the root, so keep recovery copies, such as a saved
`python_embeded`, outside it, in a sibling directory with the root's protected
DACL. If propagation fails or times out, leave the worker stopped and restore
the chosen snapshot's root DACL with the same operator identity:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <root>\atelier-private-stage\harden-install-permissions.ps1 -Root <root> -RollbackSnapshot <root>\atelier-private-secrets\install-acl-before-<chosen-snapshot>.json
```

Add `-Port <port>` when the worker does not listen on 7860.

Rollback verifies saved owner/group identity and preserves protected descendants;
if descendant verification fails after the root restore, it reports that the
restore was applied and keeps the worker stopped.
It restores the former inheritance boundary, so repeat hardening before
production startup. Never reset descendant ACLs or widen the whole drive to
work around a failed check.

Paging is explicitly accepted by the operator. This procedure does not change
pagefiles, host swap, hibernation or dump policy and does not require an OS reboot.
The readiness gate covers ComfyUI's private transport, disabled metadata,
offline mode, disabled Manager/partner nodes and assets, in-memory database and
active Python write guard. `--offline` replaces deprecated `--disable-api-nodes`
and implies `--disable-partner-nodes`. Explicit `--disable-assets` overrides
the assets enabled by `--windows-standalone-build` (since ComfyUI 0.40.0).

## Start, stop and recovery

Stop only the existing ComfyUI listener after confirming its queue is idle.
Coordinate maintenance with producers so no new local jobs are submitted during shutdown.
Preserve the stock `run_*.bat` interactive launchers and authored files. Double-click
`<root>\LAUNCH ATELIER PRIVATE.bat` to start the private worker. Its PowerShell
helper uses WMI with `DETACHED_PROCESS` and `CREATE_BREAKAWAY_FROM_JOB`, then waits
up to two minutes for authenticated TLS readiness. The window closes on success;
failures remain visible. Repeated clicks reuse the existing supervisor, and a
kernel file lock serializes concurrent launches. The supervisor holds its own
lifetime lock, so desktop and elevated SSH launches cannot create duplicates. Another listener on the
`worker.json` port is left alone and stops the launch. The supervisor writes no console log. `LAUNCH ATELIER PRIVATE.bat`
is the supported startup entrypoint. Provisioning also replaces `LAUNCH THIS.bat`
with a forwarder that calls the private BAT relative to its own directory. It
does not start a separate unauthenticated network listener, Manager or wildcard CORS.
A differing pre-existing `LAUNCH THIS.bat` is preserved once before replacement
at `<root>\atelier-private-secrets\launcher-before-private.bat`, under the
account/SYSTEM-only directory ACL. Re-provisioning keeps that first recovery
copy. Inspect it when recovering authored launcher settings; production starts
through the named private BAT.

Startup is manual only. No scheduled task, service, registry Run entry or Startup
shortcut is installed. After Windows restarts, double-click the private BAT
again. The supervisor restarts its child only while this manually started
session is running. See Microsoft's [process creation documentation](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process)
and [detached startup flags](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processstartup).
Before creating a child, the supervisor joins a Windows Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and holds its only, non-inheritable handle.
Windows atomically gives child processes the parent's job membership; the child
does not use breakaway flags. Supervisor death closes the handle and kills its
children without a post-creation assignment window. Job creation or supervisor
assignment failure exits before any child starts. Portable tests mock this
Windows ordering; actual Windows containment still needs staging acceptance.

Four automatic recoveries need no operator, and none writes a log or file:

- **Stuck execution.** Each second the reaper records when every running native
  prompt was first seen running and when its release intent was first observed.
  A released prompt still running 60 seconds later, or a prompt exceeding its
  admitted execution budget, makes the worker drop readiness and exit, and the
  supervisor starts a clean process. Native interruption is cooperative, so a
  CUDA fault or hung sampler would otherwise hold the queue indefinitely. The
  current contract requires an explicit, immutable per-job budget up to 24 hours;
  Atelier forwards its
  canonical deadline, including step overrides and continuation frames, rather
  than recomputing it in the worker. Renewal and status polling never extend
  execution time. Authenticated status polls prove active ownership, including
  while native submission/history is catching up. After 120 seconds without an
  owner observation, active work is released through the same prompt-scoped
  dequeue/interrupt path as DELETE. A noncooperative running job then reaches
  the existing 60-second release watchdog, independently of its long execution
  budget. A late status poll cannot revive released or abandoned work. A client
  reaching its own deadline also releases its job. Payloads held by other
  leases are lost on a watchdog restart. Unexpected native running work without
  an owned budget fails closed and restarts the worker.
- **Stuck startup.** A child must first report readiness within 300 seconds.
  Failed probes and `ready: false` cannot keep an unready child alive forever;
  a first readiness answer arriving after the deadline is rejected. Repeated
  failures restart with delays of 2, 4, 8, 16, 32 and at most 60 seconds.
  Readiness resets this backoff. Stop-marker checks remain active during delays.
- **Blocked event loop.** Once the child has answered the authenticated
  `GET /atelier/v1/privacy` with `ready: true`, the supervisor probes it every
  15 seconds through the pinned `cert.pem`, with the worker token, a 10-second
  timeout and no proxy. Nine consecutive unanswered probes, two minutes of
  silence, terminate and restart the child. Any answer resets the count. The
  probe route takes no queue mutex, so model loading on the execution thread
  does not trip it. Before first readiness, the separate startup budget applies.
- **Idle VRAM.** Ten minutes after the last job, with no native work queued or
  running, the reaper sets the native `unload_models` and `free_memory` flags
  under the queue mutex, once per idle period. These are the flags `/free`
  sets; `set_flag` wakes ComfyUI v0.42's idle worker, which unloads models and
  resets its caches. The next job reloads its models.

To stop this mode, create `<root>\atelier-private.stop`; the supervisor stops
its own child and exits. Once it has stopped, the private BAT removes that marker
on the next manual launch. Never kill every Python process. A manual-launcher rollback makes the
production privacy check fail closed; it must not restore legacy uploads.

The supervisor reuses model loaders between jobs, unloads them after 10 idle
minutes and recycles ComfyUI after 180 idle minutes. Only the restart releases
core's retained last-prompt stack as well as cached tensors. Autotune disk caching is disabled. The supervisor uses `--cache-ram` with upstream's default RAM pressure
thresholds, alongside the existing fast-disk, fp16 accumulation and attention
settings.
Upstream v0.42.3's [RAMPressureCache](https://github.com/Comfy-Org/ComfyUI/blob/v0.42.3/comfy_execution/caching.py#L476) retains prior node outputs across jobs until pressure eviction, free or reset; lease payload expiry affects the separate Store and does not flush core node caches.
Python file writes are denied after
startup; native codecs use BytesIO. This Python audit hook is defense in depth,
not an OS sandbox for arbitrary native code. Keep the approved node allowlist
and pinned install; review native writers when changing dependencies.

The worker reads `atelier_private/allowed_nodes.json` once at import and checks
it only at `/prompt`; `/object_info` is unfiltered. A stale staged allowlist
therefore leaves a row looking healthy while every submit is rejected. Restage
the allowlist and restart the worker before deploying an API build that ships a
new node class. Removing a class needs no restage, since a staged superset is
harmless.

## Leases and endpoints

All routes, including WebSockets, require the worker token. Other ComfyUI routes
are unavailable. No CORS wildcard, Manager, partner API nodes or persistent asset
database is enabled in this mode. Only the allowlisted graph classes can execute.

| Endpoint | Purpose |
| --- | --- |
| `GET /atelier/v1/privacy` | Protocol version, active readiness, capabilities and submission bounds |
| `GET /system_stats` | Runtime inventory |
| `GET /object_info` | Loaded node/model inventory; submission is allowlisted |
| `GET /ws` | Authenticated progress, previews and reconciliation hints |
| `POST /free` | Release model and execution caches when native work is idle |
| `POST /atelier/v1/jobs/{uuid}` | Reserve a client-chosen job ID |
| `GET /atelier/v1/jobs/{uuid}` | Lease-scoped sanitized state and ordered PNG/MP4 output handles |
| `POST /atelier/v1/jobs/{uuid}/renew` | Renew a valid owner's terminal idle grace; no body |
| `PUT /atelier/v1/jobs/{uuid}/inputs/{uuid}` | Raw bounded input bytes |
| `POST /prompt` | Submit an owned, allowlisted graph |
| `GET /atelier/v1/jobs/{uuid}/outputs/{uuid}` | Read an owned memory PNG or MP4 |
| `DELETE /atelier/v1/jobs/{uuid}` | Acknowledge storage or cancel/release |

Private mode requires `protocol: 2` and `ready: true`, with
`capabilities: {job_status: true, image_outputs: true, preview_control: true,
video_outputs: true, lease_renewal: true, job_admission: true,
execution_budget: true, residency_tracking: true}`. Image consumers
require every capability except `video_outputs`; Atelier video requires it too.
Both privacy and lease-create responses report protocol 2. Old private workers
fail readiness; there is no socket-only or unrenewed private fallback.
The worker and all producers must use this current contract together:
`execution_budget` requires `limits.max_execution_seconds`, and
`residency_tracking` requires `previous_prompt_id` on successful lease admission.

The privacy response also includes these required top-level fields:

| Field | Meaning |
| --- | --- |
| `worker_build` | SHA-256 hex of worker.py, store.py and allowed_nodes.json bytes, concatenated in that order at import; excludes secrets and runtime state |
| `allowed_nodes` | Sorted submission class allowlist, after private node transforms |
| `limits` | Positive integer bounds listed below, in snake_case |

`limits` contains `max_jobs: 4`, `max_payload_bytes: 536870912`,
`max_image_bytes: 52428800`, `max_images: 4`, `pre_submit_seconds: 120`,
`terminal_idle_seconds: 120`, `terminal_max_seconds: 600` and
`max_execution_seconds: 86400`.
Consumers read fresh metadata and may tighten their own limits from it, never widen their project
bounds. A registered class outside `allowed_nodes` fails readiness. Known input
sizes and requested counts are checked before uploads; output status and bytes
are bounded during retrieval.

Atelier image leases enable `previews` and `imageOutputs`; video leases disable
both. Every lease includes its execution budget. A lease JSON object accepts strictly boolean `previews`
and `imageOutputs`, defaulting to `true` and `false`, plus required positive
integer `executionTimeoutSeconds` up to the advertised maximum. Atelier always
sends the rounded-up canonical timeout. Missing or incompatible budgets fail
before lease allocation, GPU preparation or upload.
`previews: false` sets the native per-prompt `preview_method` to `none`; caller-supplied prompt metadata
cannot override it.

Successful admission requires `previous_prompt_id` as a canonical prompt UUID
or null, captured under the native queue mutex. The
worker updates it before every validated prompt attempt reaches the native
handler, including failed or canceled attempts, and starts at null after a
restart. It carries no model or producer identity. Atelier skips eviction only
when this UUID matches its cached successful lease and the residency key also
matches. Intervening producers, failed switches, restarts and unknown state
therefore require eviction; missing tracking fails readiness. The UUID does not
claim that VRAM is still physically resident after idle unloading.

Native workflow JSON can retain `SaveImageWebsocket` for portability. Private
dispatch always replaces each such sink
with `AtelierSaveImages`, preserving the `images` edge and setting `job_id` to
the lease UUID. The socket-only sink is absent from the private allowlist and
launcher whitelist. The worker rejects the memory sink without opt-in or with another
lease's UUID. It encodes PNGs entirely in memory, with no metadata or disk writes,
in batches of one to four images, at most 32 million pixels and 50 MiB per PNG.
Atelier applies its configured `maxResponseBytes` to status and downloads
(`CLIPROXY_MAX_RESPONSE_BYTES`, default 50 MiB); Ephemera independently retains
its 8 MiB client limit. The shared 512 MiB payload budget below is unchanged.
Batch commits are atomic and retain image order. Input slots remain separate.

Status returns only `{state, outputs}`. State is `leased`, `queued`, `running`,
`completed`, `failed` or `released`; outputs are ordered
`{id, bytes, mediaType}` handles, with `image/png` or `video/mp4` as appropriate.
Image-only leases return PNGs.
Queue state is read under the native
queue mutex. The reaper snapshots only terminal success/failure from native
history before deleting it. An absent queue/history entry during submission is
never treated as success. Status exposes no prompt, inputs, raw errors, paths or
native history. Missing or expired leases return 404. PNG downloads use the same
authenticated lease-scoped endpoint as MP4s, with the correct media type and
`Cache-Control: no-store`; released outputs cannot be downloaded. Clients can
poll this status at bounded intervals and recover downloads without rerendering,
while native WebSocket progress remains available.

The store permits four leases, three input slots and three MP4 outputs per lease
(four outputs for opted-in PNGs),
and 512 MiB of stored plus in-flight upload payload bytes across all leases.
Input slots are reserved before reading a body; each streamed chunk and MP4
or PNG output commit checks that shared budget. Duplicate inputs, unfinished input
submissions and uploads to released/submitting/submitted jobs are rejected.
Upload reservations are returned on every exit, and expired leases close their
in-flight buffers. The budget does not include native encoder or model memory.
Raw uploads have a 60-second deadline and never use multipart parsing.
Unsubmitted leases expire after 120 seconds. Terminal leases have a 120-second
idle grace. `POST /atelier/v1/jobs/{uuid}/renew` accepts no body and returns
`{ok: true}` for a valid, nonreleased, nonexpired lease, otherwise 404. A terminal
renewal extends the idle grace by 120 seconds, with an absolute 600-second cap
from the first terminal snapshot. An active renewal cannot move the eventual
terminal cap; leases that are never renewed retain their original expiry.
Status, downloads and the reaper use the same expiration predicate;
pending/running jobs retain inputs for their actual lifetime. Queue mutex checks
prevent terminal events from racing history insertion or active-job cleanup.
Creation initializes a monotonic owner-observation timestamp; accepting a valid
prompt refreshes it so bounded preparation does not consume execution ownership.
Rejected, expired, released or duplicate submissions cannot refresh it, and the
preparation deadline stays anchored to creation. Successful status
reads refresh it only for nonreleased, nonterminal queued/running or submitting
leases; unsubmitted preparation remains bounded from creation. Terminal status,
downloads and renewal do not participate in the active-owner clock or change
the terminal absolute cap. Active renewal does not keep execution ownership alive.
Released active jobs retain cancellation intent, and the reaper retries native
`interrupt_if_running(job_id)` each second until terminal. Its queue mutex and
ID check prevent a retry from interrupting a successor after the native
get/execute handoff resets an earlier signal. A released prompt that is still
running 60 seconds after release intent was first observed restarts the worker.
The reaper expires terminal/unsubmitted leases and also marks native
queued/running leases released after `OWNER_IDLE_SECONDS` (120 seconds) without
a status observation. It dequeues abandoned queued work before recalculating
admission, and retries interruption only for the released prompt ID. Producer
death or undelivered DELETE therefore initiates cancellation through owner
silence instead of waiting for a long execution ceiling. Terminal MP4 and PNG
outputs remain governed by storage acknowledgment or terminal expiry.

Admission reserves one preparation/submission/execution slot across all clients
on this worker. Native queue activity blocks admission, including released jobs
that have not actually left the queued/running set. Admission refreshes terminal
history under the native queue mutex before deciding, so completed payloads do
not block the next generation while downloads/storage overlap. Retention still
obeys four total leases and the shared memory budget. All native queue access
uses queue-mutex-before-Store-lock order. Duplicate lease identity returns a
definitive 409. Busy execution or capacity returns HTTP 429 with
`Retry-After: 1`, `Cache-Control: no-store` and `{error: "worker_busy"}`.

Busy lease requests join a first-come waiting list of job IDs, capped at 64. A
busy 429 carries `Atelier-Queue-Position: <n>`, where 1 is next in line; the
body stays exactly `{error: "worker_busy"}`, so clients that ignore the header
keep working. Clients keep their place by re-POSTing the same job ID; an entry
not re-polled within 5 seconds is dropped and a returning ID rejoins at the
back. When the worker is free, only the head of the list is admitted, or anyone
while the list is empty. DELETE of a waiting ID removes it and records the
usual cancellation tombstone. A full list refuses new waiters without a
position. Other 429 responses, such as `/free` while busy or a full tombstone
set, carry no position.

An unknown UUID DELETE records cancellation intent before acknowledging it. The
worker keeps at most 256 UUID-only tombstones, with no prompts or media. Each
expires after `PRE_SUBMIT_SECONDS` (120 seconds) from its first cancellation;
idempotent DELETE retries do not extend that TTL. Lease creation for a retained
UUID returns definitive 409 even while another job runs. After expiry that UUID
can be admitted again. A full tombstone set
returns busy for a new unknown DELETE instead of acknowledging intent it cannot
retain. Existing known job releases still succeed and keep durable release
intent in the job record until native work leaves the queue/running set. New
UUID admission does not consume tombstone capacity. Unknown cancellations never
interrupt a native successor.

`/free` applies the same sanitized 429 refusal whenever native work is queued or
running, including calls from other consumers. It accepts POST only, parses at
most 1 KiB of JSON within four seconds before acquiring the queue mutex, and
accepts only boolean `unload_models`/`free_memory` controls. When idle it sets
requested true queue flags synchronously, matching native ComfyUI semantics;
false/absent values do not clear pending flags. No await or downstream HTTP
middleware runs under the threading mutex, and no CUDA query runs in this
handler. Forced eviction, sampler, inference and cache flags otherwise
keep their existing behavior. Native ComfyUI's serial queue and worker admission
need no peer application, cross-repository package, shared app identity or
third-party coordinator. Consumers can run on different hosts/architectures and
deploy independently against protocol 2. Plain native ComfyUI, where supported
by a consumer, is a separate deployment mode.

Atelier retries lease creation only after a 429 with a bounded body exactly
`{error: "worker_busy"}`, re-POSTing the same job ID so it keeps its place in
line. It does not display the queue position. Generic, malformed or proxy 429 responses remain
ambiguous: the lease POST is not replayed, and cleanup targets the original ID.
Numeric Retry-After is clamped to 250 ms–5 seconds; date or malformed values use
one second. Admission waits at most 120 seconds inside the
unchanged overall generation deadline. It never replays an ambiguous accepted
lease POST or `/prompt`. Queue waiting does not grant a fresh render budget or
extend request/retention lifetimes.

Atelier polls status every second independently of WebSocket activity, with at
most three reconnects using the same client/job IDs and no prompt resubmission.
Three consecutive transient status failures terminate recovery, with four seconds
per status read; a successful read resets the failure counter.
Terminal socket events trigger immediate authoritative status reconciliation,
with 100 ms retries while native history insertion catches up. Sink events never
prove success. The submission acknowledgment has an eight-second
header/body deadline and socket opening has a four-second cap. Caller cancellation remains authoritative; received
definitive HTTP rejection or invalid acknowledgment still fails.
Rejection diagnostics have an additional four-second read
ceiling. `/prompt` 408/429/5xx responses and ambiguous loss reconcile the original
lease without resubmission. Other received HTTP rejections and invalid successful
identity fail. This differs from lease creation, which can be replayed only for
an exact `worker_busy` 429 body. Recovered batches validate count, IDs, bytes, media and positive PNG
dimensions within Atelier's existing canonical `sniffImage` limit of
24 × 1024 × 1024 pixels; the worker retains its separate 32-million-pixel
ceiling. Native workflow output sizes within Atelier's limit are preserved,
including hires passes, rather than requiring base latent dimensions. Native
progress fractions are forwarded only for sampler graph nodes; prompt/node/state
checks and duplicate suppression remain.
Renewal is awaited before retrieval and repeats at most every 30
seconds through encrypted storage ownership, with a four-second request deadline
and at most three total attempts. Downloads allow three total attempts for
408/429/5xx, network or body-read failures, with 60 seconds per attempt; auth,
404 and invalid content are terminal. At most four concurrent image readers
preserve order and abort/join siblings on failure. Retrieval conservatively
bounds the absolute cap from the last nonterminal observation or submission
start. Release stops renewal first, then retries idempotent DELETE independently
of request cancellation, with bounded backoff for at most 30 seconds per delivery
cycle. Concurrent release and shutdown drain coalesce. A release during lease
reservation cancels admission immediately, waits for the POST outcome, then
delivers DELETE; an early unknown DELETE response cannot memoize success while
the reservation remains unresolved. Drain also fences pending handshakes and
busy waits, and lease cancellation aborts preparation/submission and rejects
later use of the job. Worker tombstones fence an aborted network request whose
POST reaches the worker within the cancellation TTL. Only success or 404 after
reservation settlement ends ownership. Failed delivery emits a content-free warning
when exhausted. The API process retains at most 64 owned/unresolved cleanup
entries and at most one retry cycle per entry. Before new lease admission and
after definite busy responses, a coalesced recovery pass retries exhausted
release intents only. It never releases live generation or storage leases.
Each delivery cycle remains independently bounded to 30 seconds; callers can
cancel their wait without canceling cleanup. A full registry gets this recovery
opportunity before refusing new work, so restored connectivity can free capacity
on the next request without a shutdown drain. Exhausted entries have no retry
timers between request-triggered recovery passes. Successful outputs remain owned until durable encrypted storage
acknowledgment or bounded expiry.

Protocol 2 rollout requires the current worker, including reservation tombstones
and guarded synchronous `/free`, before either updated consumer is enabled.
Verify `worker_build` against the staged worker/store/allowlist source. Atelier
and Ephemera deploy independently of one another; each needs the current server
contract, and neither supports an older private worker fallback.

## Ingress and acceptance

Install `../swag/atelier-privacy.conf` as `/config/nginx/atelier-privacy.conf`
and include that file inside the `http` block of SWAG's `nginx.conf`.
Apply the Atelier proxy configuration while preserving its deployed hostname,
upstream addresses, Authelia includes and secret proxy key. Mount
`/tmp/atelier-body` as tmpfs in SWAG. Host paging is an accepted exception. The API location
streams request bodies with HTTP/1.1; unavoidable spill is RAM only. Atelier
access logs contain operational fields only, and its nginx error log is disabled
because nginx error messages can quote query strings. Run `nginx -t` before
reload and verify authenticated upload/SSE behavior afterward.

Before routing production traffic, verify active worker controls, TLS certificate
checks, unauthenticated rejection and fail-closed behavior with the old launcher.
Exercise Krea plain/reference and H3 text/image/continuation, including audio,
encrypted storage acknowledgment, cancellation, disconnect and process restart.
Use synthetic canaries, inspect only aggregate content-match counts, and observe
file writes during execution as well as directory state afterward. Native-media
unit tests alone do not prove the deployed GPU or host boundary.

Historical inputs, outputs and logs need a separate provenance-based purge.
Attribute media through exact production hashes or graph/job provenance before
removal. Prefixes, dimensions and seeds alone do not justify deleting shared
manual files. Do not create plaintext media backups. Ordinary deletion and
pagefile removal cannot promise forensic erasure of prior SSD writes.

## Upstream evidence

The source links below pin ComfyUI v0.41.3 and v0.42.3. Native offline, partner-node and asset controls are required alongside the private routes and diskless media transport. v0.43.0 adds two server surfaces that this launch keeps closed: the Deploy to Cloud routes return 403 under `--offline` ([#17203](https://github.com/Comfy-Org/ComfyUI/pull/17203)), and the local agent loads only with `--enable-agent` ([#17241](https://github.com/Comfy-Org/ComfyUI/pull/17241)), which the supervisor must never pass. Record the running checkout rather than inferring its version from this document:

```sh
git describe --tags --always --dirty
git rev-parse HEAD
```

Run these inside the operator-owned ComfyUI checkout. The API's source inventory (`bun run inventory:comfyui`) describes declared graphs and dependencies, not the live host. Native in-memory video support does not replace the private worker's authorization, lease, acknowledgment and diskless-output contract above.

- [ComfyUI v0.41.3 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.41.3)
- [Native video implementation at v0.41.3](https://github.com/Comfy-Org/ComfyUI/blob/v0.41.3/comfy_api/latest/_input_impl/video_types.py)
- [Cancellation implementation at v0.41.3](https://github.com/Comfy-Org/ComfyUI/blob/v0.41.3/server.py)
- [Native LightVAE with separate encoder/decoder support](https://github.com/Comfy-Org/ComfyUI/pull/17049)
- [Native launch controls at v0.42.3](https://github.com/Comfy-Org/ComfyUI/blob/v0.42.3/comfy/cli_args.py)
- [Official MiniMax H3 tutorial](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)
- [Workflow metadata](https://docs.comfy.org/development/api-development/workflow-metadata)
