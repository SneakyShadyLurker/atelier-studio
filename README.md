<p align="center">
  <img src="web/src/assets/atelier-mark.png" width="96" height="96" alt="Atelier">
</p>

<h1 align="center">Atelier</h1>

<p align="center">
  <strong>One prompt box. Many backends. Your images stay yours.</strong><br>
  Cloud, bring-your-own-key and local ComfyUI image and video models behind a single self-hosted interface.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-c77f1e"></a>
  <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-2a231e">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-2a231e">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-c77f1e">
</p>

<p align="center">
  <img src="docs/assets/atelier-hero.webp" alt="Atelier: a canvas of generated images above the prompt composer, with the Library rail of collections and history on the left" width="900">
</p>

---

Atelier is a self-hosted web app for AI image and video generation. You pick a
model, write a prompt and get a batch of tiles; the server routes the request
to the right backend, streams previews as they render and keeps every batch in
server-side history. It sits behind your own authentication proxy and keeps
each user's work separate, down to the encryption of every stored file.

## Highlights

### ✦ One prompt box, every backend
Cloud generation through CLIProxyAPI or another OpenAI-compatible upstream,
Google Gemini with each user's own key, and local Krea 2 and MOSS models on
ComfyUI share one composer, one model menu and one history. Partial previews
stream over SSE, batches queue when a pool is busy, and in-flight tiles can be
canceled.

### ✦ Prompt Library
Reusable templates, weighted variable lists and tag dimensions that keep random
picks coherent. `{{ai-fill: …}}` blanks let a text model fill parts of a prompt
at generate time while your own text stays byte for byte, and Brainstorm
streams fresh character concepts into the roll queue. Enhance rewrites a prompt
for the selected model in one click.

### ✦ Local models as data
Each local model is a manifest and its ComfyUI graphs, validated at startup and
extendable from a mounted directory without rebuilding the image. Generation
runs through a hardened ComfyUI worker: bearer-token TLS on every route,
per-job leases, a node allowlist and in-memory inputs and outputs.

### ✦ Video, Extend and AI Storytelling
MiniMax H3 turns a still or a text prompt into a clip with native audio.
Extend continues a clip from its last frames and soundtrack and stitches the
sequence, and AI Storytelling plans an outline into segments and renders them
one after another. The bundled H3 graphs follow ComfyUI's official templates
and ship disabled until you verify them against your own ComfyUI.

### ✦ Encrypted at rest, per user
Every stored artifact is an age file encrypted to its owner, and the server
starts sealed until it receives the root identity. Provider keys are encrypted
separately. Prompts and other metadata in SQLite rely on the encryption of the
volume they live on.

## Also included

- **Reference images**: attach up to 4 (GPT) or 10 (Gemini); HEIC, AVIF, GIF
  and TIFF are converted on the server, and Krea rows take a face reference
- **Collections and archive**: drag batches into collections, pin favourites,
  search prompts, and restore archived work for 30 days
- **Gemini BYOK**: each user brings their own Google key, encrypted on the server
- **Ephemera character cards**: turn a finished image into a character card in
  [Ephemera](https://github.com/SneakyShadyLurker/ephemera)
- **Polish**: light and dark themes, a lightbox with zoom, keyboard shortcuts,
  and layouts built for phones, tablets and desktops

## Quick start

Requirements: [Bun](https://bun.sh), an OpenAI-compatible upstream such as
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) for cloud models,
and a trusted authentication proxy that injects `Remote-User` and the proxy key
(for example SWAG with Authelia). ComfyUI is optional.

```sh
bun install
cp .env.example api/.env   # the api reads .env from its own directory; point DATA_DIR at a writable path
```

Outside production the mock provider is on, so the `Mock` models generate
without any upstream. The api answers only requests that carry `Remote-User`,
so in development run it behind a small header-injecting proxy on :8787, the
port Vite proxies `/api` to:

```sh
API_PORT=8786 bun run dev:api
bun -e 'Bun.serve({ port: 8787, idleTimeout: 0, fetch(req) { const url = new URL(req.url); url.port = "8786"; const headers = new Headers(req.headers); headers.set("Remote-User", "alice"); return fetch(url, { method: req.method, headers, body: req.body, redirect: "manual" }); } })'
bun run dev:web            # http://localhost:5173
```

`bun run typecheck`, `bun run lint` and `bun run test` run the checks.

Production runs in Docker Compose behind the proxy; the deploy steps, the
encryption setup and the release checklist are in
[docs/deployment.md](docs/deployment.md).

## Documentation

[Architecture](docs/architecture.md) · [Deployment](docs/deployment.md) ·
[Providers](docs/providers.md) · [Local models](docs/local-models.md) ·
[Prompt Library authoring](docs/prompt-library-authoring.md) ·
[Web conventions](docs/web-conventions.md) · [All docs](docs/README.md)

## License

[GNU AGPL v3.0 only](LICENSE). For use without the AGPL obligations, open an
issue titled Commercial license. Issues are welcome; pull requests are not
accepted at this time. Atelier is meant for adults; operators decide who they
admit.
