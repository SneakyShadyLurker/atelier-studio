# Deployment

Atelier ships as two containers (`atelier-api`, `atelier-web`) defined in `infra/docker/docker-compose.yml`. A trusted reverse proxy (the committed configuration targets SWAG with Authelia) is the only route to them. This document covers a first deploy, the environment, artifact encryption, local model manifests, the release checklist and recovery recipes. Topology and contracts are in [`architecture.md`](./architecture.md).

## Requirements

- Docker with Compose v2.
- A reverse proxy on a shared Docker network that authenticates users, clears client-supplied `Remote-*` headers, injects `Remote-User` and the shared `X-Atelier-Proxy-Key`, and disables buffering for SSE. `infra/swag/atelier.subdomain.conf` and `infra/authelia/access-control.yml` are the reference configuration.
- An OpenAI-compatible upstream for cloud image and text calls, such as [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), on a private network.
- Optional: a ComfyUI host running Atelier's private worker ([`infra/comfyui/README.md`](../infra/comfyui/README.md)) for local models.
- Optional: an OpenRouter key for the GPT input-moderation gate ([providers](providers.md#gpt-only-input-moderation)). Without it GPT requests stop before they leave Atelier; other models keep working.

## First deploy

1. **Data directory.** Create the host directory that becomes `DATA_DIR`, ideally on an encrypted volume. The api runs as UID/GID `1000:1000`, so on Linux:

   ```sh
   sudo mkdir -p /srv/atelier
   sudo chown -R 1000:1000 /srv/atelier
   sudo chmod 750 /srv/atelier
   ```

   On Docker Desktop (macOS, Windows) the file-sharing layer maps the host user to the container user, so no `chown` is needed. The compose bind uses `create_host_path: false`: a missing or unmounted directory fails the container start instead of creating an empty one. Use [artifact encryption](#artifact-encryption) to populate it.

2. **Environment.** Copy the template and fill it in:

   ```sh
   cd infra/docker
   cp .env.production.example .env
   chmod 600 .env
   openssl rand -base64 48   # TRUSTED_PROXY_KEY
   openssl rand -hex 32      # BYOK_ENCRYPTION_KEY
   ```

   Required in production: `CLIPROXY_BASE_URL`, `CLIPROXY_TOKEN`, `DATA_DIR`, `SWAG_EXTERNAL_NETWORK`, `TRUSTED_PROXY_KEY`, `BYOK_ENCRYPTION_KEY` and `STORAGE_ROOT_RECIPIENT`. `NODE_ENV=production` is set in `docker-compose.yml` and enables the production auth and CSRF checks. Keep `ENABLE_MOCK_PROVIDER=false`. The user allowlists `PROMPT_LIBRARY_USERS`, `LOCAL_MODELS_USERS` and `EPHEMERA_USERS` default to empty (nobody), so set each one you want. [`architecture.md` § Configuration](./architecture.md#configuration) lists every variable.

   - **CLIProxyAPI auth.** Set `CLIPROXY_TOKEN` to a value already in the proxy's API-key list; a freshly generated token gets `401 Invalid API key`.
   - **CLIProxyAPI reachability.** On Docker Desktop, `host.docker.internal` reaches a proxy only when it listens on the host loopback or all interfaces. A proxy bound to one LAN address must be addressed by that address.
   - **Text model ids.** `CLIPROXY_TEXT_MODEL_*` default to bare ids such as `kimi-latest`. A proxy that namespaces models needs the full id (`<provider>/kimi-latest`). See [providers](providers.md#text-backends-via-cliproxyapi).
   - **Local models.** `COMFYUI_BASE_URL`, `COMFYUI_ATELIER_TOKEN` and `COMFYUI_ATELIER_CA` come from the private worker's provisioning ([`infra/comfyui/README.md`](../infra/comfyui/README.md)). `VIDEO_MODELS_ENABLED=true` requires `COMFYUI_BASE_URL`. See [Models directory](#models-directory).

   Verify the reverse proxy's external network name with `docker network ls` rather than guessing.

3. **Host override.** Copy `infra/docker/docker-compose.override.example.yml` to `infra/docker/docker-compose.override.yml` (gitignored) and adjust the memory and CPU limits, the optional platform pin, any loopback-only ports and the models mount. Compose merges it automatically. The api's 4 GiB `/tmp` tmpfs counts against its memory limit.

4. **Build and start.**

   ```sh
   cd infra/docker
   ATELIER_BUILD_REVISION="$(git rev-parse HEAD)" docker compose build
   docker compose up -d --wait
   docker compose ps
   ```

   `atelier-api` must become `healthy`. Its compose healthcheck calls `/api/ready` with the proxy key, so it only reports healthy once SQLite is reachable. In production the api starts **sealed** until it receives the storage root identity ([Artifact encryption](#artifact-encryption)).

5. **Reverse proxy.** Install `infra/swag/atelier.subdomain.conf` into SWAG's `nginx/proxy-confs/` and substitute the placeholder. SWAG does not envsubst proxy-confs, so the file must be valid as deployed:

   ```sh
   TRUSTED_PROXY_KEY=$(grep '^TRUSTED_PROXY_KEY=' infra/docker/.env | cut -d= -f2-)
   sed "s|__TRUSTED_PROXY_KEY__|$TRUSTED_PROXY_KEY|" infra/swag/atelier.subdomain.conf \
     > /tmp/atelier.subdomain.conf
   sudo mv /tmp/atelier.subdomain.conf /path/to/swag/nginx/proxy-confs/atelier.subdomain.conf
   docker exec swag nginx -t
   docker exec swag nginx -s reload
   ```

   The default `server_name` is `atelier.*`. The conf pins its resolvers to `ipv6=off`: on a dual-stack Docker network the embedded DNS returns AAAA records while Bun binds IPv4 only. Install `infra/swag/atelier-privacy.conf` as described in [`infra/comfyui/README.md`](../infra/comfyui/README.md).

6. **Authelia.** Merge `infra/authelia/access-control.yml` into your access-control rules, replacing the domain regex (or pinning the exact FQDN) for your domain, then reload Authelia and check its logs.

7. **Smoke test** ([below](#smoke-test)).

## Models directory

The built-in local model manifests ship in the api image under `api/src/providers/comfyui/models/`: `krea-2-gonzalomo`, `moss-image-sft`, and the MiniMax H3 pair `minimax-h3-i2v` and `minimax-h3-t2v` as **disabled templates** derived from ComfyUI's official H3 workflow and unverified on a live host. To add or replace rows, mount a directory with the same layout read-only and point `COMFYUI_MODELS_DIR` at it; the override example binds `${COMFYUI_MODELS_HOST_DIR}` at `/run/comfyui-models`. `COMFYUI_ENABLE_MODELS` registers disabled built-ins. Render through each graph against your ComfyUI before enabling a row. Validate a directory before deploying it:

```sh
bun run api/scripts/validate-models.ts <models dir> --builtin api/src/providers/comfyui/models
```

[`local-models.md`](./local-models.md) owns the manifest schema, the override rule and the validation rules.

## Artifact encryption

Every artifact (images, clips, uploads, thumbnails, sequence masters) is stored as an [age](https://age-encryption.org/v1) file encrypted to its owner. Nobody holding a copy of `DATA_DIR` or the SQLite file can read a user's images without the root identity. All cryptography is typage (`age-encryption`); the stock `age` CLI reads everything for offline recovery.

**Keys.** Each user has a post-quantum hybrid age identity (`user_storage_keys`), created on first write and stored encrypted to the deployment root recipient (`STORAGE_ROOT_RECIPIENT`, public, `age1pq1…`, in `.env`). Every file gets a fresh file key wrapped to its owner. `storage_root` binds the database to one root: a different recipient refuses boot. Deleting a user row cascades to their key, which crypto-shreds their files. Keep the root **identity** only in a secret store you control, never on the data volume; losing it loses every artifact, and there is no rotation or re-encryption tooling.

**Sealed and unsealed.** The api boots **sealed**. Writes (generation, uploads, thumbnails) work, because encryption needs only public recipients; reads wait up to 20 s, then return `503 STORAGE_SEALED` with `Retry-After: 5`. Queued work is not dispatched while sealed and resumes on unseal. Unseal by piping the root identity into the container-local socket `/run/atelier/unseal.sock`; the identity is read from stdin only:

```sh
<command that prints the root identity> | docker exec -i atelier-api bun scripts/storage.ts unseal
docker exec atelier-api bun scripts/storage.ts status   # {"sealed":false}
docker exec atelier-api bun scripts/storage.ts verify   # authenticates EVERY artifact; exit 3 on any failure
```

The socket lives on a container tmpfs, so every container start needs a new unseal. A host-side agent that reads the identity from a secret store and runs `unseal` on each container start automates this.

**Guards.** In production the api refuses to boot, before opening the database, unless `DATA_DIR/.atelier-data-volume` exists (written last by the migration below). Decrypted copies exist only in the container's tmpfs `/tmp` and never touch a file on disk: ffmpeg inputs (1.5 GiB budget), seekable playback copies of clips and masters so Bun can answer HTTP Range (1 GiB budget, evicted after 5 idle minutes; a Range request that finds no room gets `503` with `Retry-After`), and HEIC decode scratch. Host swap can still page container memory; disable it on the Docker VM where possible.

**Not protected:** a live attacker with access to the secret store, the Docker socket or container memory; upstream cloud-provider retention; prompt text and metadata in SQLite (protected only by the volume's own encryption).

**Development.** Without `STORAGE_ROOT_RECIPIENT` outside production, the api creates a persistent dev root at `DATA_DIR/.storage-root.dev.txt` (0600), unseals itself at boot, and still serves legacy plaintext files with a warning. Production rejects plaintext files as integrity errors.

### Creating the data volume

1. Build the api image (`docker compose build atelier-api`), then generate the root identity with the image's own age library. It prints the identity (`AGE-SECRET-KEY-PQ-…`) and then its recipient (`age1pq1…`). Move the identity into your secret store without writing it to a file, and keep only the recipient for `.env`:

   ```sh
   docker run --rm --network none --entrypoint bun atelier-atelier-api -e \
     "import { generateHybridIdentity, identityToRecipient } from 'age-encryption'; const i = await generateHybridIdentity(); console.log(i); console.log(await identityToRecipient(i));"
   ```

2. Run the migration into an **empty** destination owned by UID 1000 (it refuses anything else). The source must contain `atelier.sqlite`. For a fresh install, an empty file is enough: the migration snapshots it, creates the current schema and writes the marker. For an existing plaintext `DATA_DIR`, stop the api and use that directory as the source.

   ```sh
   mkdir -p /srv/atelier-plaintext && touch /srv/atelier-plaintext/atelier.sqlite   # fresh install only
   docker run --rm --network none -u 1000:1000 \
     -e STORAGE_ROOT_RECIPIENT=age1pq1… \
     --mount type=bind,src=/srv/atelier-plaintext,dst=/src,readonly \
     --mount type=bind,src=/srv/atelier,dst=/app/data \
     --entrypoint bun atelier-atelier-api scripts/encrypt-migrate.ts --source /src --dest /app/data
   ```

   It snapshots the stopped DB (`VACUUM INTO`), re-syncs the prompt FTS index, migrates to the current schema, encrypts every artifact and verifies each by decrypting it and comparing SHA-256, checks every DB-referenced artifact exists, and writes the marker last. Any failure exits non-zero with no marker; empty the destination and rerun.
3. Set `DATA_DIR` and `STORAGE_ROOT_RECIPIENT` in `.env`, start the stack, unseal, and run `storage.ts verify`; it must report zero failures and zero missing. Then delete the plaintext source and any snapshots of it.

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

`BYOK_ENCRYPTION_KEY` (64 hex characters) encrypts user-supplied provider keys at rest with AES-256-GCM. Changing it requires a restart.

### BYOK master-key loss

If `BYOK_ENCRYPTION_KEY` is lost or rotated without re-encryption, every stored user key becomes undecryptable. Recovery is per user and explicit: the user deletes the old provider key, then re-enters it in the BYOK dialog. A direct `PUT /api/keys/google` over an existing undecryptable row returns `409 { "error": "recovery_required" }` instead of silently overwriting it.

**Boot guard.** The api persists a sentinel ciphertext in the single-row `keystore_proof` table on first boot and verifies it on every later boot. A key that no longer decrypts the sentinel throws `KeystoreProofError` and exits 1 with a message naming this section. The first-boot path also probes existing `user_provider_keys` rows and refuses to seed a sentinel that would bless a wrong key. This does not make rotation recoverable; it replaces a confusing `NEEDS_GOOGLE_KEY` after the first generation with a clear boot-time signal.

To recover from total master-key loss (every BYOK row must be re-entered): the api exits on the wrong key and Compose keeps restarting it, so stop it first, run the two deletes from a one-off container of the same service (it mounts the same `DATA_DIR` read-write at `/app/data`), then start it again. The next boot seeds a fresh sentinel.

```sh
cd infra/docker
docker compose stop atelier-api
docker compose run --rm --no-deps --entrypoint bun atelier-api -e \
  "import {Database} from 'bun:sqlite'; const db = new Database('/app/data/atelier.sqlite'); db.run('DELETE FROM keystore_proof'); db.run('DELETE FROM user_provider_keys'); db.close();"
docker compose start atelier-api
```
 The 409 path is logged at WARN as `event=byok_put_under_rotation` without key material. `user_provider_keys.key_version` is reserved and always `1`; it is not a rotation mechanism.

## Ephemera character cards (optional)

The integration with [Ephemera](https://github.com/SneakyShadyLurker/ephemera) is off while `EPHEMERA_BASE_URL` is unset or empty. To turn it on, set `EPHEMERA_BASE_URL` to an address the api container can reach, `EPHEMERA_ORIGIN` to Ephemera's exact public origin, and `EPHEMERA_INTEGRATION_KEY` to the value Ephemera holds in its own `EPHEMERA_INTEGRATION_KEY` (at least 32 characters, never a placeholder; boot refuses either). List the users who get the action in `EPHEMERA_USERS`. `EPHEMERA_CARD_TIMEOUT_MS` (default `540000`) must leave 60 s under `SWAG_PROXY_READ_TIMEOUT_MS`, and Ephemera's `EPHEMERA_REQUEST_TIMEOUT_MS` (default `600000`) must stay above it; Atelier cannot check Ephemera's value, so confirm it in Ephemera's environment.

Preflight the outbound path from inside the api container before anyone uses the action:

```sh
docker compose exec atelier-api bun -e 'const r = await fetch(process.env.EPHEMERA_BASE_URL + "/api/creator/card/from-image", { method: "POST", redirect: "error", headers: { "X-Ephemera-Proxy-Key": process.env.EPHEMERA_INTEGRATION_KEY, "Remote-User": "alice", Origin: process.env.EPHEMERA_ORIGIN, "Content-Type": "text/plain" }, body: "x" }); console.log(r.status)'
```

It must print `415`: Ephemera is reachable, accepted the key and origin, and ran no model call. `403` means a wrong key or origin; a connection error means the address is not reachable from the container. Behavior: [providers](providers.md#ephemera-character-cards).

## Releasing an update

Atelier applies pending schema migrations at api boot (`api/src/db/migrate.ts`); boot refuses a database newer than the binary. A safe release:

1. **Lock.** Hold one deploy lock per compose directory so a deploy and host maintenance never overlap. `infra/docker/deploy-lock.sh` is a bash 3.2 lock library (BSD and Linux) for this: an owner record in `infra/docker/.deploy.lock`, stale-lock recovery under a kernel flock on `infra/docker/.deploy-reclaim.flock`, and a refusal while a live owner or child holds it. Never delete `.deploy-reclaim.flock`; keep both paths gitignored.
2. **Check the tree.** Build only from a clean checkout of the revision you intend to ship, and label the image with it (`ATELIER_BUILD_REVISION="$(git rev-parse HEAD)"`). A `git archive` build context avoids permission surprises from a working tree.
3. **Tag the running images as `:prev`** so a rollback is one `docker compose up -d --no-build` away. Tag the image ids of the running containers, not `:latest`: an earlier failed build can already have replaced `:latest`, and tagging it would overwrite the last good image with the failed one.

   ```sh
   docker tag "$(docker inspect --format '{{.Image}}' atelier-api)" atelier-atelier-api:prev
   docker tag "$(docker inspect --format '{{.Image}}' atelier-web)" atelier-atelier-web:prev
   ```
4. **Build** with `docker compose build`.
5. **Rehearse migrations** when `api/src/db/migrate.ts`, `api/src/db/migrations/` or `api/src/db/schema.sql` changed since the running revision (below).
6. **Start** with `docker compose up -d --wait`, unseal, and run the [smoke test](#smoke-test).
7. **Roll back** on failure by re-tagging `:prev` as `:latest` and running `docker compose up -d --no-build --wait`, but only when no migration ran: a downgraded image refuses a newer schema. After a migration, fix forward.

Never run two `atelier-api` instances against the same `DATA_DIR`; some migrations rename files outside any SQLite transaction. `docker compose up -d` stops the old container before starting the new one.

### Pre-deploy migration rehearsal

`infra/docker/rehearse-migrations.ts` runs the candidate image's real `migrate()` against a consistent snapshot of the live database, without starting the server. It needs only `DATA_DIR`; do not pass `--env-file .env`, because `docker run` cannot parse the multiline `COMFYUI_ATELIER_CA` value that Compose accepts. Production keeps running during the rehearsal:

```bash
cd infra/docker
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

1. Open the site; the auth proxy must redirect to its portal and return to the Atelier SPA after login.
2. Generate a batch with `gpt-image-2.5-sunburst` (or a local model); tile events must arrive incrementally.
3. Open the tile in the lightbox, download it, delete it, refresh, and confirm the deletion persisted.
4. Spoof check: `curl --header 'Remote-User: attacker' https://<your host>/api/models` must yield the auth portal redirect, not a 200.
5. Check SSE in Safari, Firefox and Chrome. The proxy conf disables buffering and sets a 600 s read timeout so long generations stream.

Inside-container liveness (auth-gated routes return 401 without the proxy headers):

```sh
docker exec atelier-web wget -qO- http://127.0.0.1/          # 127.0.0.1, not localhost (Alpine resolves ::1 first)
docker exec atelier-api bun -e "console.log(await (await fetch('http://127.0.0.1:8787/api/health')).text())"
```

`/api/health` is the only unauthenticated API route; the proxy must not expose a public `location /api/health`.

## Rotating `TRUSTED_PROXY_KEY`

1. Generate a new value with `openssl rand -base64 48`.
2. Update `TRUSTED_PROXY_KEY` in `infra/docker/.env` and the `X-Atelier-Proxy-Key` value in the deployed proxy conf.
3. Restart the api and reload the proxy close together (`docker compose restart atelier-api`, `nginx -t`, `nginx -s reload`).
4. Re-run the spoof check and a generation. During a mismatch, authenticated requests fail with 401.

## Rotating `EPHEMERA_INTEGRATION_KEY`

Rotate Ephemera first: it refuses the old key the moment it restarts, while Atelier keeps working except for the card action. Set the new value (`openssl rand -base64 48`, different from Ephemera's proxy key) in Ephemera's environment and redeploy it, then set the same value in Atelier's `.env` and redeploy, then re-run the [preflight](#ephemera-character-cards-optional).

## Logs

Logs are pino JSON on stdout. Every request has `reqId`; generation paths also log `batchId` and `tileId`.

```sh
docker compose logs -f atelier-api
docker compose logs atelier-api 2>&1 | grep '<batchId>'
docker compose logs atelier-api 2>&1 | grep 'brainstorm_backend_fallback'
docker compose logs atelier-api 2>&1 | grep db_corruption_detected
```

## DB and migration inspection

The api container has no `sqlite3` CLI; use Bun's SQLite read-only:

```sh
docker exec atelier-api bun -e "import {Database} from 'bun:sqlite'; const db=new Database('/app/data/atelier.sqlite',{readonly:true}); console.log(db.query('SELECT * FROM schema_versions ORDER BY version').all())"
```

**Never write to the live `atelier.sqlite` from the host while the api runs**; a second writer has desynced the api's cache and corrupted pages. Run writes inside the container (`docker exec`), or stop the api first. `VACUUM INTO` inside the container produces a consistent snapshot without stopping it.

## Backups

If you back up `DATA_DIR`, copy it as a unit: artifacts are encrypted to per-user identities stored only in that database's `user_storage_keys`, so artifacts without the matching database, or a database restored from before a user's first write, are unreadable. The root identity is never part of the copy.

Take the database and artifact roots from one point in time: stop the api, `.backup` the database, copy `images/`, `thumbs/` and `uploads/`, then start it again. A single filesystem snapshot covering `atelier.sqlite*` and those three roots is also valid. Do not take a live `.backup` and copy artifacts later while writers continue, and never copy raw `atelier.sqlite`, `-wal` and `-shm` files from a running api.

## Database corruption

Docker Desktop's VirtioFS bind mounts have known data-loss bugs under sustained writes ([docker/for-mac#6690](https://github.com/docker/for-mac/issues/6690), [#7494](https://github.com/docker/for-mac/issues/7494)); a lost write shows up as one zero-filled 4 KB page. There is no application-level fix, only detection and repair. Mitigations are switching file sharing to gRPC FUSE or moving `DATA_DIR` to a named volume.

**Detection.** Every signal is tagged `db_corruption_detected`:

- **Boot gate** (`logDbIntegrity`): `PRAGMA integrity_check(20)` after `migrate()`. Non-fatal for serving, because damage confined to a derived index should not become a full outage. A check that cannot run logs `db_integrity_check_failed` instead.
- **Artifact-deletion gate** (`startup-reconcile.ts`): a failed check **refuses to unlink artifacts**, because a damaged database can under-return the keep-set. `RECONCILE_FORCE=true` overrides once the mount is verified.
- **`runDbMaintenance`**, `app.onError`, and the catch-alls in `routes/generate.ts`, `orchestrator/startDetached.ts` and `orchestrator/dequeue.ts` tag corruption before their generic handling.

**Repair.** Identify the damaged objects with `PRAGMA integrity_check(200)`, then work on a copy, never the live file:

```sh
# 1. Stop the api and back up db + wal + shm
docker compose -f infra/docker/docker-compose.yml stop atelier-api
D=<DATA_DIR on host>
B="$D/repair-backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B" && cp -p "$D"/atelier.sqlite* "$B/"

# 2. Checkpoint, then work in a FRESH scratch dir. Piping .recover output into a
#    database that already exists continues past "table already exists" errors
#    and still passes integrity_check, so set -e + mktemp are load-bearing.
set -e
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
docker compose -f infra/docker/docker-compose.yml start atelier-api
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

- `docker compose config` fails: check `SWAG_EXTERNAL_NETWORK`, `DATA_DIR` and the required api values in `infra/docker/.env`.
- The proxy returns 502: confirm both containers are on the proxy's external network and `atelier-api` is healthy.
- The spoof check returns 200: confirm `more_clear_input_headers Remote-User Remote-Groups Remote-Name Remote-Email;` precedes the Authelia include, then reload.
- Tiles arrive in one burst: confirm `/api/` has `proxy_buffering off`, `proxy_set_header X-Accel-Buffering no` and `proxy_read_timeout 600s`.
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
| `BRAINSTORM_OPEN_TIMEOUT_MS` | 45000 | 5000-120000 | Per-attempt open-phase cap for character brainstorming. A transient failure of a non-Kimi backend fails over once to Kimi before any prompt was emitted (`brainstorm_backend_fallback`). |
| `AI_FILL_PER_ATTEMPT_TIMEOUT_MS` | 120000 | 30000-180000 | Per-attempt timeout for ai-fill (`maxAttempts: 2`). `glm-abliterated` uses at least 360000. |
| `KREA_CONDENSE_TIMEOUT_MS` | 150000 | 1000-300000 | Per-call Krea condensation cap; condensation fails open. `glm-abliterated` uses at least 420000. |
| `QUOTA_MIN_RETRY_AFTER_MS` | 300000 | 30000-3600000 | A `429` counts as budget exhaustion (non-retriable, breaker-exempt) only when its `Retry-After` is at least this floor or the body names a token budget. |
| `SWAG_PROXY_READ_TIMEOUT_MS` | 600000 | 60000-3600000 | Mirrors the proxy's `proxy_read_timeout`. |
| `INFER_DIMENSIONS_BATCH_CONCURRENCY` | 12 | 1-16 | Concurrent per-list calls during two-pass infer. |

`loadConfig` cross-validates the infer waves, retry backoff and headroom against `INFER_TOTAL_BUDGET_MS`, and enforces `total_budget + 60 s <= SWAG_PROXY_READ_TIMEOUT_MS`; startup fails with a precise message if either is violated. Breakers are per capability and per container. Telemetry events: `infer_dimensions_upstream`, `infer_dimensions_failed_after_retry`, `infer_dimensions_breaker_skipped_wave2`.
