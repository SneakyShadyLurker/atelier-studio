# Deployment

Atelier runs as two containers, `atelier-api` and `atelier-web`, built from this
repository. A trusted authentication proxy is the only route to them. The
included configuration uses SWAG and Authelia. No private deployment repository
or operator-specific overlay is required.

Use [Getting started](getting-started.md) for a local trial. This guide is for
an operator setting up a persistent server. After installation, [Using Atelier](user-guide.md)
covers the app itself; [Architecture](architecture.md) describes its contracts.

The checked-in `patches/` directory is required input to Bun installs, including frozen-lockfile installs and both Docker build stages. Root `patchedDependencies` applies the `range-parser@1.3.0` suffix-range correction automatically. Include these files when preparing a source or manifest-only build context; do not install from manifests and lockfile alone.

## Requirements

- A Docker host with [Compose v2](https://docs.docker.com/compose/install/), Git
  and OpenSSL. The commands below use a Linux POSIX shell. Docker builds include
  Bun and the media tools; you do not need to install them on the production host.
- A domain with DNS pointing at your ingress, a valid TLS certificate, and a
  working authentication proxy. Atelier does not create accounts or provide a
  login service. Set up [SWAG](https://docs.linuxserver.io/general/swag/) and
  [its Authelia integration](https://www.authelia.com/integration/proxies/swag/)
  first, including at least one user who can log in. These are separate services,
  not containers installed by Atelier's Compose file.
- A Docker network shared with that proxy. The proxy must remove client-supplied
  `Remote-*` headers, inject the verified `Remote-User` and shared
  `X-Atelier-Proxy-Key`, preserve the public host and stream SSE without buffering.
  Another proxy is possible if it meets all [authentication requirements](architecture.md#authentication).
- An empty writable data directory, preferably on an encrypted volume, and a
  secret manager or secure store for the storage identity and server keys.
- At least one real generation path from the [provider setup guide](getting-started.md#connect-a-real-model):
  Google BYOK, a compatible GPT image upstream, or your own ComfyUI worker.
  Model weights, provider credentials and credits are not supplied.
- For Enhance, AI fill, Brainstorm and the other text features, a text model
  you connect in the app after launch, local or cloud. See
  [Connect a text model](connect-a-text-model.md).

For GPT, the upstream must support Atelier's configured image model and adapter
contract; a chat-only OpenAI-compatible endpoint will not work. GPT also needs
`OPENROUTER_API_KEY` for its [input-moderation check](providers.md#gpt-only-input-moderation).
Local models need the included [ComfyUI worker](../infra/comfyui/README.md), whose
provisioning procedure targets Windows portable ComfyUI. “Private worker” means
the privacy transport included in this public repository, not separate private
code. Plain ComfyUI without that worker is not supported.

## First deploy

These steps create a **fresh installation**. For existing plaintext data, use
[Creating the data volume](#creating-the-data-volume) with the stopped existing
directory as the source. For an existing encrypted installation, keep its data,
recipient and keys and follow [Releasing an update](#releasing-an-update).

Stop at any failed command and resolve the error before continuing. Never
initialize over an existing installation or create its volume marker by hand.
Multi-command maintenance blocks use a subshell, `( ... )`, to stop on failure
without changing your interactive shell options or closing your session.

### 1. Download the project

```sh
git clone https://github.com/SneakyShadyLurker/atelier-studio.git
cd atelier-studio/infra/docker
```

**Run the remaining Compose commands from `infra/docker`.** Paths beginning
with `../../` below refer to the repository root. If you downloaded a ZIP,
extract it and enter its `infra/docker` directory instead.

### 2. Prepare the data directory

The examples use `/srv/atelier`. On Linux, create a new empty directory owned
by the container's UID/GID `1000:1000`:

```sh
sudo mkdir /srv/atelier
sudo chown 1000:1000 /srv/atelier
sudo chmod 750 /srv/atelier
```

If that path already exists, inspect it and choose a new empty destination
instead of overwriting its contents. On Docker Desktop, choose a shared host
path and verify that UID 1000 can write through the mount; host ownership
mapping differs from Linux. The bind mount does not create a missing host
directory, so a locked or unmounted volume causes startup to fail safely.

### 3. Configure the environment

Copy the template only if you have no existing `.env`:

```sh
cp .env.production.example .env
chmod 600 .env
openssl rand -base64 48   # Generate TRUSTED_PROXY_KEY
openssl rand -hex 32     # Generate BYOK_ENCRYPTION_KEY
docker network ls
```

Edit `.env` and replace the placeholders. Keep the generated keys in your
secret store, and do not paste them into an issue or commit them.

| Setting | What to enter |
|---|---|
| `DATA_DIR` | The absolute host path created in step 2 |
| `SWAG_EXTERNAL_NETWORK` | The existing network shared with your proxy, as shown by `docker network ls` |
| `TRUSTED_PROXY_KEY` | The generated base64 value; the same value goes into the proxy configuration |
| `BYOK_ENCRYPTION_KEY` | The generated 64-character hex value; required in production even if you do not use Gemini. It also encrypts the API keys of text providers |
| `STORAGE_ROOT_RECIPIENT` | The public recipient generated in step 5; leave its placeholder only until then |
| `TEXT_PROVIDER_ADMINS` | Comma-separated signed-in usernames who manage text providers, models and routing in the Text models view; empty means nobody |
| `CLIPROXY_BASE_URL` / `CLIPROXY_TOKEN` | Optional, and used only for GPT Image: your upstream's bare origin and an accepted API token. Set both or neither |
| `OPENROUTER_API_KEY` | Your OpenRouter key if you use GPT Image or text models with "Screen requests first"; without it those requests are refused |

Inside a container, `127.0.0.1` means that container. Use a reachable private
address or a service name on a shared network for your upstream. Docker Desktop
offers `host.docker.internal` for host services; check their bind address and
firewall. A newly invented token will not work unless the upstream accepts it.
The URL must not include `/v1`, a query or credentials. The same container rule
applies to a text model served from the host, such as Ollama. See
[When Atelier runs in Docker](connect-a-text-model.md#when-atelier-runs-in-docker).

Keep ComfyUI fields empty unless you have provisioned the worker. If you use
it, set its URL, token and pinned certificate, then list exact signed-in
usernames in `LOCAL_MODELS_USERS`. Set `PROMPT_LIBRARY_USERS` for users who
should have the Prompt Library. These lists default to nobody. Text actions
need a text model, which a `TEXT_PROVIDER_ADMINS` user connects in the app
after the first start ([Connect a text model](connect-a-text-model.md)).
Keep `ENABLE_MOCK_PROVIDER=false` and `VIDEO_MODELS_ENABLED=false` for the
first deployment. [Architecture](architecture.md#configuration) describes the
configuration reference.

### 4. Build the images

```sh
ATELIER_BUILD_REVISION="$(git rev-parse HEAD)" docker compose build
```

If you downloaded a ZIP, run `docker compose build` instead. There is no Git
revision to label, so the image revision is `unknown`. For later updates, use
a Git clone of the intended revision and carry over your private configuration.
The update and migration-rehearsal procedure below requires Git so it can label
and check the candidate image. Do not run Git update commands in a ZIP directory.

The default image names are `atelier-atelier-api` and `atelier-atelier-web`.
Do not start the containers yet: encrypted storage must be initialized first.

The host override is optional. If you copy
`docker-compose.override.example.yml` to `docker-compose.override.yml`, adjust
the resource limits for your host. **Remove its `COMFYUI_MODELS_DIR`
environment entry and models volume block unless you are mounting a custom
model directory.** Those blocks are active in the example and otherwise
require a host path that does not exist on a fresh install. Built-in models
do not need that mount. The API's 4 GiB `/tmp` tmpfs counts against its memory
limit. Keep the API and web containers unpublished; the proxy reaches them
over the Docker network.

### 5. Initialize encrypted storage

Follow [Creating the data volume](#creating-the-data-volume) now, before
`docker compose up`: generate the root identity, save it in your secret store,
put only its public recipient in `.env`, then initialize the empty data
directory. Return here when initialization succeeds and writes
`.atelier-data-volume`. The identity is essential for reading every user's
artifacts; there is no recovery if it is lost.

### 6. Connect the authentication proxy

The following paths are inside SWAG's persistent `/config` mount. Install the
repository's `../../infra/swag/atelier-privacy.conf` as
`/config/nginx/atelier-privacy.conf`. Add this line **inside the `http` block**
of SWAG's `nginx.conf`, not inside a `server` block:

```nginx
include /config/nginx/atelier-privacy.conf;
```

Give SWAG a tmpfs mount for `/tmp/atelier-body` in its own container
configuration, then recreate SWAG. For example, merge this into its service:

```yaml
tmpfs:
  - /tmp/atelier-body:mode=1777
```

This keeps request-body spill in RAM; it does not disable host paging. The
privacy log format is required for the supplied site configuration even if
you do not use ComfyUI.

Copy `../../infra/swag/atelier.subdomain.conf` to SWAG's
`/config/nginx/proxy-confs/atelier.subdomain.conf`. In that deployed copy:

1. Set `server_name` to your actual hostname, such as `atelier.example.org`.
2. Replace `__TRUSTED_PROXY_KEY__` with the exact value from `.env`. SWAG does
   not expand environment variables in this file. Edit it privately and make
   it readable only by the operator and SWAG; do not commit the substituted file.
3. Preserve the header-clearing, Authelia includes, public `Host`, SSE settings
   and upstream container names.

In Authelia, add an access-control rule for that exact hostname under
`access_control.rules`, before any broader rule that would take precedence:

```yaml
- domain: atelier.example.org
  policy: one_factor
```

The [included rule fragment](../infra/authelia/access-control.yml) is another
starting point. Restrict the audience according to your own policy. Reload
Authelia and confirm the config is accepted. Use your actual SWAG container
name if it differs from `swag`:

```sh
docker exec swag nginx -t
docker exec swag nginx -s reload
```

Do not reload if the configuration test fails. Confirm SWAG and both Atelier
services use the network named by `SWAG_EXTERNAL_NETWORK`.

### 7. Start, unseal and verify

```sh
docker compose config --quiet
docker compose up -d --wait
docker compose ps
```

Both containers must be running and the API must be healthy. That healthcheck
only verifies the database responds; it does **not** prove storage is unsealed
or an upstream can generate images.

For a manual unseal, paste your saved one-line root identity into this hidden
prompt. It does not echo the identity or put it in shell history or arguments:

```sh
bash -c 'read -r -s -p "Storage root identity: " atelier_root_identity || exit 1; printf "\n" >&2; printf "%s\n" "$atelier_root_identity" | docker exec -i atelier-api bun scripts/storage.ts unseal'
docker exec atelier-api bun scripts/storage.ts status
docker exec atelier-api bun scripts/storage.ts verify
```

Status must report `"sealed":false`; verification must report zero user-key
failures, failures and missing files. Every API container start needs another
unseal. For automation, pipe the output of your own secret-store read command
directly into `docker exec -i atelier-api bun scripts/storage.ts unseal`.

Run the [smoke test](#smoke-test), then give users the site address and
[Using Atelier](user-guide.md). Do not treat a healthy container as a completed
first deployment without checking a real generation and download.

## Day-to-day operation

Run these commands from `infra/docker`:

| Task | Command | Follow-up |
|---|---|---|
| Check status | `docker compose ps` | API health checks SQLite, not storage or provider access |
| Read recent logs | `docker compose logs --tail 100 atelier-api` | Keep credentials and private content out of issue reports |
| Stop the app | `docker compose stop` | Data stays in the host data directory |
| Start it again | `docker compose up -d --wait` | Unseal the API and check a generation |
| Restart the API | `docker compose restart atelier-api` | Unseal again; this does not reload `.env` |
| Apply environment changes | `docker compose up -d --force-recreate atelier-api` | Unseal again, then check the affected feature |
| Check storage | `docker exec atelier-api bun scripts/storage.ts status` | `sealed: true` needs the saved root identity |

Use the [manual unseal prompt](#7-start-unseal-and-verify) after any API start,
restart, recreation or host reboot. A production API never reads the storage
root identity from `.env`. Keep `STORAGE_ROOT_RECIPIENT` unchanged for an
existing database.

For new users, create their account in your authentication service. Atelier
uses the exact `Remote-User` value as the user's identity; it does not have a
separate account-registration screen. Add usernames to the feature allowlists
you need, recreate the API to load changes, and send users the
[user guide](user-guide.md). Renaming an authentication username does not move
its existing Atelier history.

## Models directory

The built-in local model manifests ship in the api image under `api/src/providers/comfyui/models/`: `krea-2-gonzalomo`, `moss-image-sft`, and the MiniMax H3 pair `minimax-h3-i2v` and `minimax-h3-t2v` as **disabled templates** derived from ComfyUI's official H3 workflow and unverified on a live host. To add or replace rows, mount a directory with the same layout read-only and point `COMFYUI_MODELS_DIR` at it; the override example binds `${COMFYUI_MODELS_HOST_DIR}` at `/run/comfyui-models`. `COMFYUI_ENABLE_MODELS` registers disabled built-ins. Render through each graph against your ComfyUI before enabling a row.

For optional model authoring, validate the directory on a workstation with Bun
and project dependencies installed. Run this command from the **repository
root**, replacing `<models dir>` with the external directory path; it is not
part of the Docker-only first deployment:

```sh
bun run api/scripts/validate-models.ts <models dir> --builtin api/src/providers/comfyui/models
```

[`local-models.md`](./local-models.md) owns the manifest schema, the override rule and the validation rules.

## Artifact encryption

Every artifact (images, clips, uploads, thumbnails, sequence masters) is stored as an [age](https://age-encryption.org/v1) file encrypted to its owner. Nobody holding a copy of `DATA_DIR` or the SQLite file can read a user's images without the root identity. All cryptography is typage (`age-encryption`); the stock `age` CLI reads everything for offline recovery.

**Keys.** Each user has a post-quantum hybrid age identity (`user_storage_keys`), created on first write and stored encrypted to the deployment root recipient (`STORAGE_ROOT_RECIPIENT`, public, `age1pq1…`, in `.env`). Every file gets a fresh file key wrapped to its owner. `storage_root` binds the database to one root: a different recipient refuses boot. Deleting a user row cascades to their key, which crypto-shreds their files. Keep the root **identity** only in a secret store you control, never on the data volume; losing it loses every artifact, and there is no rotation or re-encryption tooling.

**Sealed and unsealed.** The api boots **sealed**. Encryption needs only public
recipients, but reading encrypted artifacts needs the root identity. Reads wait
up to 20 seconds, then return `503 STORAGE_SEALED` with `Retry-After: 5`.
Queued generation is not dispatched while sealed and resumes on unseal. Unseal
by piping the root identity into the container-local socket
`/run/atelier/unseal.sock`; the identity is read from stdin only:

```sh
<command that prints the root identity> | docker exec -i atelier-api bun scripts/storage.ts unseal
docker exec atelier-api bun scripts/storage.ts status   # {"sealed":false}
docker exec atelier-api bun scripts/storage.ts verify   # authenticates EVERY artifact; exit 3 on any failure
```

The socket lives on a container tmpfs, so every container start needs a new unseal. A host-side agent that reads the identity from a secret store and runs `unseal` on each container start automates this.

**Guards.** In production the api refuses to boot, before opening the database, unless `DATA_DIR/.atelier-data-volume` exists (written last by the migration below). Decrypted copies exist only in the container's tmpfs `/tmp` and never touch a file on disk: ffmpeg inputs (1.5 GiB budget), seekable playback copies of clips and masters with HTTP Range support (1 GiB budget, retired after 5 idle minutes; active reader leases retain their files and budget until completion, cancellation, or error; readers making no byte progress for 5 minutes are cancelled and their responses error; a Range request that finds no room gets `503` with `Retry-After`), and HEIC decode scratch. Host swap can still page container memory; disable it on the Docker VM where possible.

**Not protected:** a live attacker with access to the secret store, the Docker socket or container memory; upstream cloud-provider retention; prompt text and metadata in SQLite (protected only by the volume's own encryption).

**Development.** Without `STORAGE_ROOT_RECIPIENT` outside production, the api creates a persistent dev root at `DATA_DIR/.storage-root.dev.txt` (0600), unseals itself at boot, and still serves legacy plaintext files with a warning. Production rejects plaintext files as integrity errors.

### Creating the data volume

Run these commands from `infra/docker`, after building the API image. A fresh
installation and a plaintext migration both use the same initializer.

1. Generate the root identity with the image's age library. It prints the secret
   identity (`AGE-SECRET-KEY-PQ-…`) and then its public recipient (`age1pq1…`).
   Run this in a private terminal, save the identity in your secret store, and
   set `STORAGE_ROOT_RECIPIENT` in `.env` to the public recipient. Keep a secure
   backup of the identity, separate from the data volume. Do not generate a new
   identity for an existing encrypted installation.

   ```sh
   docker run --rm --network none --entrypoint bun atelier-atelier-api -e \
     "import { generateHybridIdentity, identityToRecipient } from 'age-encryption'; const i = await generateHybridIdentity(); console.log(i); console.log(await identityToRecipient(i));"
   ```

2. For a fresh installation, prepare a temporary source with an empty database.
   The permissions below let the container's UID 1000 read it. This source
   contains no user data:

   ```sh
   atelier_initial_source="$(mktemp -d /tmp/atelier-initial-source.XXXXXX)" &&
   chmod 755 "$atelier_initial_source" &&
   touch "$atelier_initial_source/atelier.sqlite" &&
   chmod 644 "$atelier_initial_source/atelier.sqlite"
   ```

   For an existing plaintext installation, **stop the API first** and set
   `atelier_initial_source` to the absolute path of its existing `DATA_DIR`
   instead. Preserve the whole source, including SQLite WAL files, and take a
   backup before migrating. The destination must be a different, empty directory
   writable by UID 1000. Do not use the fresh-install `touch` command on existing
   data.

3. Replace `age1pq1…` with the exact public recipient you saved in `.env`.
   Replace `/srv/atelier` if your destination differs. Run:

   ```sh
   docker run --rm --network none -u 1000:1000 \
     -e STORAGE_ROOT_RECIPIENT=age1pq1… \
     --mount "type=bind,src=$atelier_initial_source,dst=/src,readonly" \
     --mount type=bind,src=/srv/atelier,dst=/app/data \
     --entrypoint bun atelier-atelier-api scripts/encrypt-migrate.ts --source /src --dest /app/data
   ```

   The initializer snapshots the stopped DB, updates its schema and prompt
   index, encrypts artifacts and verifies their bytes. It checks every referenced
   artifact exists and writes `.atelier-data-volume` last. A failed run leaves
   a partial destination, including a database snapshot, without a valid marker.
   Preserve the source and diagnose the error. To retry, create a new empty
   destination with the same ownership and permissions, change the destination
   mount's `src=` in the command above, and set `DATA_DIR` in `.env` to that same
   new path before starting the API. Keep the original recipient.

   The tool's suggestion to empty the destination applies only to a known failed
   attempt, never the source or an existing installation. Protect partial
   destinations as user data and retire them under your storage policy after
   the successful installation and backups have been verified. Never create the
   marker by hand to bypass a failed initializer.

4. For a first installation, return to [Connect the authentication proxy](#6-connect-the-authentication-proxy),
   then start, unseal and verify. If your proxy is already configured for an
   existing plaintext installation, proceed to [Start, unseal and verify](#7-start-unseal-and-verify).
   Do not remove
   an old plaintext source until the encrypted installation is verified and its
   backups have been tested. Retire plaintext backups according to your storage
   policy; ordinary deletion does not promise forensic erasure.

### Recovery with the stock age CLI

Pipe the secrets; never write the root identity to a file:

```sh
sqlite3 -readonly /srv/atelier/atelier.sqlite \
  "SELECT hex(wrapped_identity) FROM user_storage_keys WHERE user_id = 'alice'" \
  | xxd -r -p \
  | age -d -i <(<command that prints the root identity>) \
  | { read -r user_identity; age -d -i <(printf '%s\n' "$user_identity") \
      /srv/atelier/images/alice/<tileId>.png; } > recovered.png
```

## BYOK keys

`BYOK_ENCRYPTION_KEY` (64 hex characters) encrypts user-supplied provider keys
and the API keys of text providers at rest with AES-256-GCM. Preserve it across
updates and restores. Changing an existing key without re-encrypting its stored
data makes those keys unreadable. Text-provider keys are recovered by an admin
choosing **Replace key** under **Edit provider** in the Text models view.

### BYOK master-key loss

If `BYOK_ENCRYPTION_KEY` is lost or rotated without re-encryption, every stored user key becomes undecryptable. Recovery is per user and explicit: the user deletes the old provider key, then re-enters it in the BYOK dialog. A direct `PUT /api/keys/google` over an existing undecryptable row returns `409 { "error": "recovery_required" }` instead of silently overwriting it.

**Boot guard.** The api persists a sentinel ciphertext in the single-row `keystore_proof` table on first boot and verifies it on every later boot. A key that no longer decrypts the sentinel throws `KeystoreProofError` and exits 1 with a message naming this section. The first-boot path also probes existing `user_provider_keys` rows and refuses to seed a sentinel that would bless a wrong key. This does not make rotation recoverable; it replaces a confusing `NEEDS_GOOGLE_KEY` after the first generation with a clear boot-time signal.

To recover from total master-key loss (every BYOK row must be re-entered): the api exits on the wrong key and Compose keeps restarting it, so stop it first, run the two deletes from a one-off container of the same service (it mounts the same `DATA_DIR` read-write at `/app/data`), then start it again. The next boot seeds a fresh sentinel.

```sh
docker compose stop atelier-api
docker compose run --rm --no-deps --entrypoint bun atelier-api -e \
  "import {Database} from 'bun:sqlite'; const db = new Database('/app/data/atelier.sqlite'); db.run('DELETE FROM keystore_proof'); db.run('DELETE FROM user_provider_keys'); db.close();"
docker compose up -d --force-recreate atelier-api
```
Unseal again after the API starts. The 409 path is logged at WARN as
`event=byok_put_under_rotation` without key material.
`user_provider_keys.key_version` is reserved and always `1`; it is not a rotation
mechanism.

## Ephemera character cards (optional)

The integration with [Ephemera](https://github.com/SneakyShadyLurker/ephemera) is off while `EPHEMERA_BASE_URL` is unset or empty. To turn it on, set `EPHEMERA_BASE_URL` to an address the api container can reach, `EPHEMERA_ORIGIN` to Ephemera's exact public origin, and `EPHEMERA_INTEGRATION_KEY` to the value Ephemera holds in its own `EPHEMERA_INTEGRATION_KEY` (at least 32 characters, never a placeholder; boot refuses either). List the users who get the action in `EPHEMERA_USERS`. `EPHEMERA_CARD_TIMEOUT_MS` (default `540000`) must leave 60 s under `SWAG_PROXY_READ_TIMEOUT_MS`, and Ephemera's `EPHEMERA_REQUEST_TIMEOUT_MS` (default `600000`) must stay above it; Atelier cannot check Ephemera's value, so confirm it in Ephemera's environment.

Preflight the outbound path from inside the api container before anyone uses the action:

```sh
docker compose exec atelier-api bun -e 'const r = await fetch(process.env.EPHEMERA_BASE_URL + "/api/creator/card/from-image", { method: "POST", redirect: "error", headers: { "X-Ephemera-Proxy-Key": process.env.EPHEMERA_INTEGRATION_KEY, "Remote-User": "alice", Origin: process.env.EPHEMERA_ORIGIN, "Content-Type": "text/plain" }, body: "x" }); console.log(r.status)'
```

It must print `415`: Ephemera is reachable, accepted the key and origin, and ran no model call. `403` means a wrong key or origin; a connection error means the address is not reachable from the container. Behavior: [providers](providers.md#ephemera-character-cards).

## Releasing an update

Build and deploy the API and web images from the same revision. The new web
requires the matching API's `/api/history/refresh` endpoint; update the API before
the web. The supplied Compose configuration waits for API health before starting
the web container. Updating only the web against an older API is unsupported.

Atelier applies pending schema migrations at api boot (`api/src/db/migrate.ts`); boot refuses a database newer than the binary.

Schema v57 adds a partial index for upload references held by rendering stories;
it leaves existing rows intact. Rehearse this migration before promotion. Once
v57 is recorded, a v56 image refuses the database, so retain a forward-fix path
instead of relying on the previous image alone.

Schema v58 replaces the fixed text backends with text providers and models
managed in the app's Text models view. **Upgrade note:** the `CLIPROXY_TEXT_MODEL_*` variables are removed in schema 58, and the migration reads them once on the first boot after upgrading. Keep your existing `CLIPROXY_*` values set for that boot so the migration can move your text models, and your users' saved picks, into a provider named CLIProxyAPI. Afterwards manage them in the Text models view and delete those per-model variables, which only cause a boot warning from then on.

Without `CLIPROXY_BASE_URL` and `CLIPROXY_TOKEN` on that boot nothing is moved,
and saved text-model picks are dropped. The moved provider reads its key from
`CLIPROXY_TOKEN` on every request, so leave that set while you use it. Set
`TEXT_PROVIDER_ADMINS` before the upgrade so someone can open the view.

Follow these steps for a release:

1. **Lock.** Hold one deploy lock per compose directory so a deploy and host maintenance never overlap. `infra/docker/deploy-lock.sh` is a bash 3.2 lock library (BSD and Linux) for this: an owner record in `infra/docker/.deploy.lock`, stale-lock recovery under a kernel flock on `infra/docker/.deploy-reclaim.flock`, and a refusal while a live owner or child holds it. Never delete `.deploy-reclaim.flock`; keep both paths gitignored.
2. **Check the tree.** Build only from a clean checkout of the revision you intend to ship, and label the image with it (`ATELIER_BUILD_REVISION="$(git rev-parse HEAD)"`). A `git archive` build context avoids permission surprises from a working tree.
3. **Tag the running images as `:prev`** so a rollback is one `docker compose up -d --no-build` away. Tag the image ids of the running containers, not `:latest`: an earlier failed build can already have replaced `:latest`, and tagging it would overwrite the last good image with the failed one.

   ```sh
   docker tag "$(docker inspect --format '{{.Image}}' atelier-api)" atelier-atelier-api:prev
   docker tag "$(docker inspect --format '{{.Image}}' atelier-web)" atelier-atelier-web:prev
   ```
4. **Back up**, then **build** with `ATELIER_BUILD_REVISION="$(git rev-parse HEAD)" docker compose build`.
5. **Rehearse migrations** when `api/src/db/migrate.ts`, `api/src/db/migrations/` or `api/src/db/schema.sql` changed since the running revision (below).
6. **Start** with `docker compose up -d --wait`, unseal, and run the [smoke test](#smoke-test).
7. **Roll back** on failure by re-tagging `:prev` as `:latest` and running `docker compose up -d --no-build --wait`, but only when no migration ran: a downgraded image refuses a newer schema. After a migration, fix forward.

Never run two `atelier-api` instances against the same `DATA_DIR`; some migrations rename files outside any SQLite transaction. `docker compose up -d` stops the old container before starting the new one.

### Pre-deploy migration rehearsal

`infra/docker/rehearse-migrations.ts` runs the candidate image's real `migrate()` against a consistent snapshot of the live database, without starting the server. It needs only `DATA_DIR`; do not pass `--env-file .env`, because `docker run` cannot parse the multiline `COMFYUI_ATELIER_CA` value that Compose accepts. Production keeps running during the rehearsal:

```bash
(
set -e
candidate_revision="$(git rev-parse HEAD)"
ATELIER_BUILD_REVISION="$candidate_revision" docker compose build atelier-api
live_data_dir="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' atelier-api)"
scratch="$(mktemp -d "$(dirname "$live_data_dir")/.atelier-migration-rehearsal.XXXXXX")"
snapshot_basename=".atelier-migration-rehearsal-manual-$$.sqlite"
trap 'rm -f "$live_data_dir/$snapshot_basename"; rm -rf "$scratch"' EXIT
chmod 0777 "$scratch"
docker compose exec -T -e "ATELIER_REHEARSAL_SNAPSHOT=/app/data/$snapshot_basename" atelier-api bun -e \
  'import {Database} from "bun:sqlite"; const p=process.env.ATELIER_REHEARSAL_SNAPSHOT; if (!p) throw new Error("snapshot path missing"); const db=new Database("/app/data/atelier.sqlite",{readonly:true}); try { db.query("VACUUM INTO ?").run(p); } finally { db.close(); }'
mv "$live_data_dir/$snapshot_basename" "$scratch/atelier.sqlite"
candidate_api_image="$(docker image inspect --format '{{.Id}}' atelier-atelier-api:latest)"
candidate_api_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate_api_image")"
if [ "$candidate_api_revision" != "$candidate_revision" ]; then
  echo "migration rehearsal refused: candidate image revision is $candidate_api_revision, expected $candidate_revision" >&2
  exit 1
fi
docker run --rm --entrypoint bun \
  -v "$scratch:/app/data" \
  -v "$PWD/rehearse-migrations.ts:/rehearse.ts:ro" \
  -e DATA_DIR=/app/data \
  "$candidate_api_image" /rehearse.ts
)
```

The rehearsal fails, and the release must stop, when any of these assertions fails:

- `migrate()` throws: a pending migration cannot run on the copied schema and data.
- `MAX(schema_versions.version)` differs from `BINARY_SCHEMA_VERSION`.
- `PRAGMA foreign_key_check` returns a row.
- `PRAGMA integrity_check` returns anything other than its single `ok` row.
- `sqlite_master.sql` still references `_old`, `__atelier_rebuild_` or the re-parse probe suffix: a rebuild artefact escaped cleanup.
- The schema re-parse probe fails: with `legacy_alter_table=OFF`, every user table is transactionally renamed to a probe name and back, which forces SQLite to re-parse dependent triggers and views.

Table additions, drops and row-count deltas are printed as advisory output. The rehearsal matters because the Linux container's bundled SQLite and a development machine's SQLite can differ in rename behavior, so a passing local migration test does not prove the production path.

## Smoke test

From a clean browser session:

1. Open the site; confirm that the proxy requires login and returns you to
   Atelier after successful authentication.
2. Generate a batch with a configured **real provider**: Gemini BYOK, GPT Image
   or a verified local model. For Gemini, save the user's key through **API
   keys** first. Confirm the generation finishes; Mock Fast does not establish
   upstream access.
3. Open the result in the lightbox and download it. Archive a test result,
   refresh, and confirm it appears in Archive. Restore it and check it returns
   to the active history.
4. Without a session cookie, run
   `curl --header 'Remote-User: attacker' https://<your-host>/api/models` with
   your actual hostname. It must require authentication through a login
   redirect or an unauthenticated 401/403 response. A 200 response granting
   access as the supplied attacker is a failed trust boundary.
5. Check updates and completion in the browsers you support. For a provider
   that emits previews, confirm they arrive during generation rather than in
   one buffered burst. Gemini and some other paths return only finished
   images. The supplied proxy disables SSE buffering and uses a 600-second
   read timeout.

Inside-container liveness (auth-gated routes return 401 without the proxy headers):

```sh
docker exec atelier-web wget -qO- http://127.0.0.1/          # 127.0.0.1, not localhost (Alpine resolves ::1 first)
docker exec atelier-api bun -e "console.log(await (await fetch('http://127.0.0.1:8787/api/health')).text())"
```

`/api/health` is the only unauthenticated API route; the proxy must not expose a public `location /api/health`.

## Rotating `TRUSTED_PROXY_KEY`

1. Generate a new value with `openssl rand -base64 48`.
2. Update `TRUSTED_PROXY_KEY` in `infra/docker/.env` and the `X-Atelier-Proxy-Key` value in the deployed proxy conf.
3. Recreate the API to load the changed `.env` and reload the proxy close together
   (`docker compose up -d --force-recreate atelier-api`, `nginx -t`,
   `nginx -s reload`). Unseal the recreated API.
4. Re-run the spoof check and a generation. During a mismatch, authenticated requests fail with 401.

## Rotating `EPHEMERA_INTEGRATION_KEY`

Rotate Ephemera first: it refuses the old key the moment it restarts, while Atelier keeps working except for the card action. Set the new value (`openssl rand -base64 48`, different from Ephemera's proxy key) in Ephemera's environment and redeploy it, then set the same value in Atelier's `.env` and redeploy, then re-run the [preflight](#ephemera-character-cards-optional).

## Logs

Logs are pino JSON on stdout. Every request has `reqId`; generation paths also log `batchId` and `tileId`.

```sh
docker compose logs --tail 100 atelier-api
docker compose logs --since 1h atelier-api 2>&1 | grep '<batchId>'
docker compose logs --since 1h atelier-api 2>&1 | grep 'brainstorm_backend_fallback'
docker compose logs --since 1h atelier-api 2>&1 | grep db_corruption_detected
```

## DB and migration inspection

The api container has no `sqlite3` CLI; use Bun's SQLite read-only:

```sh
docker exec atelier-api bun -e "import {Database} from 'bun:sqlite'; const db=new Database('/app/data/atelier.sqlite',{readonly:true}); console.log(db.query('SELECT * FROM schema_versions ORDER BY version').all())"
```

**Never write to the live `atelier.sqlite` from the host while the api runs**; a second writer has desynced the api's cache and corrupted pages. Run writes inside the container (`docker exec`), or stop the api first. `VACUUM INTO` inside the container produces a consistent snapshot without stopping it.

## Backups

Back up the **whole `DATA_DIR` from one point in time**: the database and any
SQLite sidecars, `images/`, `uploads/`, `thumbs/` and `.atelier-data-volume`.
Artifacts require their matching per-user keys in the database. Files without
that database, or a database from before a user's first write, are unreadable.

Keep separate secure backups of the root identity, `BYOK_ENCRYPTION_KEY`, the
production `.env`, proxy configuration and any custom model manifests. The
root identity should remain in your secret store, separate from the data
backup. SQLite contains prompts and metadata, so protect the backup with
volume or backup encryption even though media files are already encrypted.

For a simple stopped backup, choose a secure backup path **outside `DATA_DIR`**
and adapt both paths below. Use a new archive name; do not overwrite the last
good backup. From `infra/docker`:

```sh
(
set -e
docker compose stop atelier-api
sudo tar -C /srv/atelier -cpf /secure/backup/atelier-data-YYYYMMDD.tar .
docker compose start atelier-api
)
```

Unseal again and confirm the app works. If the archive command fails, preserve
the error, resolve it and start/unseal the API when safe; do not claim that a
backup was taken. A single filesystem snapshot covering the entire data
directory is another option. Never copy raw database and WAL files from a
running API, or take a live database snapshot and copy artifacts later while
writers continue.

### Restore a backup

1. Stop the API. Preserve the current data directory separately; do not extract
   a backup over it or mix files from different backups.
2. Use the application revision that created the backup, or a compatible newer
   revision. A binary refuses a database with a newer schema. Restore your
   saved environment and model/proxy configuration privately.
3. Create a **new empty** destination and extract the complete stopped backup,
   preserving ownership. For example, with paths adapted to your machine:

   ```sh
   (
   set -e
   sudo mkdir /srv/atelier-restored
   sudo tar -C /srv/atelier-restored -xpf /secure/backup/atelier-data-YYYYMMDD.tar
   sudo chown -R 1000:1000 /srv/atelier-restored
   )
   ```

4. Set `DATA_DIR` in `.env` to that destination. Restore the matching
   `BYOK_ENCRYPTION_KEY` and `STORAGE_ROOT_RECIPIENT`. Do not run the plaintext
   initializer on encrypted backup data or generate replacement keys.
5. Run `docker compose config --quiet`, then
   `docker compose up -d --force-recreate --wait`. Unseal using the matching
   root identity and run `storage.ts verify`; it must report zero failures and
   missing files. Check history, a download, a real generation and BYOK access
   if used.

Test restoration before relying on a backup. To rehearse alongside production,
use an isolated Docker host or separately adapted stack: this Compose file
uses fixed container names, and two API instances must never share a data
directory.

## Database corruption

Docker Desktop's VirtioFS bind mounts have known data-loss bugs under sustained writes ([docker/for-mac#6690](https://github.com/docker/for-mac/issues/6690), [#7494](https://github.com/docker/for-mac/issues/7494)); a lost write shows up as one zero-filled 4 KB page. There is no application-level fix, only detection and repair. Mitigations are switching file sharing to gRPC FUSE or moving `DATA_DIR` to a named volume.

**Detection.** Every signal is tagged `db_corruption_detected`:

- **Boot gate** (`logDbIntegrity`): `PRAGMA integrity_check(20)` after `migrate()`. Non-fatal for serving, because damage confined to a derived index should not become a full outage. A check that cannot run logs `db_integrity_check_failed` instead.
- **Artifact-deletion gate** (`startup-reconcile.ts`): a failed check **refuses to unlink artifacts**, because a damaged database can under-return the keep-set. `RECONCILE_FORCE=true` overrides once the mount is verified.
- **`runDbMaintenance`**, `app.onError`, and the catch-alls in `routes/generate.ts`, `orchestrator/startDetached.ts` and `orchestrator/dequeue.ts` tag corruption before their generic handling.

**Repair.** Identify the damaged objects with `PRAGMA integrity_check(200)`, then work on a copy, never the live file:

```sh
(
set -e
# 1. Stop the api and back up db + wal + shm
docker compose stop atelier-api
D=<DATA_DIR on host>
B="$D/repair-backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B" && cp -p "$D"/atelier.sqlite* "$B/"

# 2. Checkpoint, then work in a FRESH scratch dir. Piping .recover output into a
#    database that already exists continues past "table already exists" errors
#    and still passes integrity_check, so set -e + mktemp are load-bearing.
W=$(mktemp -d)
S=sqlite3   # needs SQLite >= 3.39 for .recover
"$S" "$D/atelier.sqlite" 'PRAGMA wal_checkpoint(TRUNCATE);'
cp "$D/atelier.sqlite" "$W/broken.db"

# 3. Cheap path first; it can itself fail if the damage is inside the FTS index.
"$S" "$W/broken.db" "INSERT INTO batch_prompt_fts(batch_prompt_fts) VALUES('rebuild');" || true

# 4. Full recovery
"$S" "$W/broken.db" ".recover" > "$W/recovered.sql"
[ ! -e "$W/recovered.db" ]
"$S" -bail "$W/recovered.db" < "$W/recovered.sql"
"$S" "$W/recovered.db" "PRAGMA integrity_check;"   # must print "ok"

# 5. Rebuild the FTS table if it inherited lost_and_found rows
"$S" "$W/recovered.db" <<'SQL'
DROP TABLE batch_prompt_fts;
CREATE VIRTUAL TABLE batch_prompt_fts USING fts5(
  user_id UNINDEXED, batch_id UNINDEXED, prompt, tokenize = 'trigram'
);
INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
SELECT rowid, user_id, id, prompt FROM batches WHERE archived_at IS NULL;
DROP TABLE lost_and_found;
SQL

# 6. Verify: per-table row counts match, schema identical, FTS rowids align
#    (SELECT count(*) FROM batch_prompt_fts f JOIN batches b ON b.rowid=f.rowid
#    WHERE b.id <> f.batch_id; must be 0), and an archive + delete cycle works.

# 7. Swap in (stale -wal/-shm must not survive) and restart
mv "$D/atelier.sqlite" "$D/atelier.sqlite.corrupt-$(date +%Y%m%d-%H%M%S)"
rm -f "$D/atelier.sqlite-wal" "$D/atelier.sqlite-shm"
cp "$W/recovered.db" "$D/atelier.sqlite"
docker compose start atelier-api
)
```

### WAL grows unexpectedly

Boot-time maintenance (`runDbMaintenance`) runs `PRAGMA wal_checkpoint(TRUNCATE)` and an FTS5 `optimize`, and `journal_size_limit = 64 MB` caps the retained WAL on every checkpoint. For a long-running instance, checkpoint manually during a quiet period or restart the api. Reclaiming freed pages needs a manual `VACUUM` (exclusive lock, api stopped), and **`VACUUM` must be paired with a `batch_prompt_fts` re-sync in the same session**: `batches` is a rowid table with a TEXT primary key, so `VACUUM` renumbers its hidden rowids and the FTS rows keyed on them would point at the wrong batches. A plain FTS5 `'rebuild'` does not fix this; re-sync explicitly:

```sh
sqlite3 /srv/atelier/atelier.sqlite <<'SQL'
VACUUM;
DELETE FROM batch_prompt_fts;
INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
SELECT rowid, user_id, id, prompt FROM batches WHERE archived_at IS NULL;
SQL
```

Check for a desync with `SELECT count(*) FROM batch_prompt_fts_content c JOIN batches b ON b.rowid=c.id WHERE b.id <> c.c1;` (must be `0`); a nonzero count calls for this re-sync, not the `.recover` path above.

## Troubleshooting

- `docker compose config --quiet` fails: check `SWAG_EXTERNAL_NETWORK`, `DATA_DIR` and the required API values in `.env`.
- API exits with a missing `.atelier-data-volume` marker: confirm the correct
  volume is mounted and storage initialization succeeded. Do not create the
  marker by hand or point the API at a fresh empty directory to suppress it.
- Images return `503 STORAGE_SEALED`, or queued work never starts after a
  restart: check `storage.ts status` and unseal with the saved root identity.
- Key or recipient mismatch at boot: restore the matching configuration and
  keys; do not generate replacement keys for an existing data directory.
- Compose reports a missing models mount: remove the optional models environment
  and volume blocks from the example override if you do not use an external catalog.
- Local model menu is empty: check `COMFYUI_BASE_URL`, the exact signed-in name
  in `LOCAL_MODELS_USERS` and the model's enabled state. An offline row also
  needs worker credentials, a valid pinned certificate, weights and node classes.
- The proxy returns 502: confirm both containers are on the proxy's external network and `atelier-api` is healthy.
- The spoof check returns 200: confirm `more_clear_input_headers Remote-User Remote-Groups Remote-Name Remote-Email;` precedes the Authelia include, then reload.
- A preview-capable provider's updates arrive in one burst: confirm `/api/`
  has `proxy_buffering off`, `proxy_set_header X-Accel-Buffering no` and
  `proxy_read_timeout 600s`. Final-only providers do not emit previews.
- Authenticated requests return 401: the proxy's `X-Atelier-Proxy-Key` must match `TRUSTED_PROXY_KEY` exactly.
- `GET /api/img/:tileId` returns 404 for another user: expected; image reads are scoped by `Remote-User`.
- `GET /api/img/:tileId` returns 500: a row likely points at a missing artifact. Restart the api to run startup reconciliation, then search the logs for the `tileId`.
- Container logs grow: both services cap json-file logs at 10 MB × 5 files.

## Thumbnail cache

Thumbnails at `${DATA_DIR}/thumbs/<userId>/<tileId>.webp` are derived data, regenerated on the next `GET /api/img/:tileId/thumb`. Clear them with `docker exec atelier-api sh -c 'rm -rf /app/data/thumbs/*'`; no restart is needed. A `503` with `Retry-After: 5` from the thumb route means the per-process generation queue is saturated; the web client falls back to the full image.

## Client cache reset

The web app persists a narrow slice of the React Query cache in IndexedDB under a per-user key (`atelier-rq-cache-v1:<cacheScope>`). A change to a persisted wire shape must bump `PERSIST_CACHE_VERSION` in `web/src/lib/persister.ts` in the same change; otherwise clients hydrate stale-shape data for up to 5 minutes. To clear it manually, delete that key in DevTools → Application → IndexedDB → `keyval-store`.

## Resilience knobs

The text-call resilience layer wraps every upstream call in Cockatiel retry, circuit-breaker and timeout policies. `api/src/config.ts` owns the defaults; override only deliberately:

| Var | Default | Range | What it does |
|---|---:|---|---|
| `INFER_TOTAL_BUDGET_MS` | 500000 | 120000-580000 | Hard cap for the whole `/infer` SSE call. Must leave at least 60 s under `SWAG_PROXY_READ_TIMEOUT_MS`. |
| `RESILIENT_PER_ATTEMPT_TIMEOUT_MS` | 70000 | 15000-180000 | Per-attempt timeout for draft-list and infer calls. |
| `RESILIENT_MAX_ATTEMPTS` | 2 | 1-5 | Total provider invocations per policy call, including the first. |
| `RESILIENT_INITIAL_BACKOFF_MS` | 800 | 100-10000 | Backoff base, with decorrelated jitter. |
| `RESILIENT_MAX_BACKOFF_MS` | 8000 | 500-60000 | Backoff ceiling. |
| `RESILIENT_BREAKER_THRESHOLD` | 8 | 3-32 | Consecutive transient failures before the breaker opens, per capability. |
| `RESILIENT_HALF_OPEN_AFTER_MS` | 30000 | 5000-120000 | Cooldown before the breaker tries half-open. |
| `ENHANCE_OPEN_TIMEOUT_MS` | 15000 | 5000-60000 | Per-attempt cap for the `/enhance` open phase. The stream drain stays outside the policy. |
| `BRAINSTORM_OPEN_TIMEOUT_MS` | 45000 | 5000-120000 | Per-attempt open-phase cap for character brainstorming. A transient failure before any prompt was emitted fails over once to the next model in routing order (`brainstorm_backend_fallback`). |
| `AI_FILL_PER_ATTEMPT_TIMEOUT_MS` | 120000 | 30000-180000 | Per-attempt timeout for ai-fill (`maxAttempts: 2`). Models marked Slow model use at least 360000. |
| `KREA_CONDENSE_TIMEOUT_MS` | 150000 | 1000-300000 | Per-call Krea condensation cap; condensation fails open. Models marked Slow model use at least 420000. |
| `QUOTA_MIN_RETRY_AFTER_MS` | 300000 | 30000-3600000 | A `429` counts as budget exhaustion (non-retriable, breaker-exempt) only when its `Retry-After` is at least this floor or the body names a token budget. |
| `SWAG_PROXY_READ_TIMEOUT_MS` | 600000 | 60000-3600000 | Mirrors the proxy's `proxy_read_timeout`. |
| `INFER_DIMENSIONS_BATCH_CONCURRENCY` | 12 | 1-16 | Concurrent per-list calls during two-pass infer. |

`loadConfig` cross-validates the infer waves, retry backoff and headroom against `INFER_TOTAL_BUDGET_MS`, and enforces `total_budget + 60 s <= SWAG_PROXY_READ_TIMEOUT_MS`; startup fails with a precise message if either is violated. Breakers are per capability and per container. Telemetry events: `infer_dimensions_upstream`, `infer_dimensions_failed_after_retry`, `infer_dimensions_breaker_skipped_wave2`.
