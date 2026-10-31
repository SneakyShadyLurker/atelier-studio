# Getting started

This guide takes you from a download to a working local Atelier installation.
The first test needs no API key, model download or GPU. It uses a mock provider
that returns small coloured images. [Connect a real model](#connect-a-real-model)
once that test works.

For a shared server, use [Deployment](deployment.md). The local proxy below
signs every request in as `alice`; it is for use on your own computer only.

## 1. Install the tools

- Install [Bun 1.4.4](https://bun.sh/docs/installation#installing-older-versions), the version
  pinned in this project's `package.json` and Docker builds.
- Install [Git](https://git-scm.com/downloads), or download the repository as a
  ZIP from GitHub and extract it.
- Use Terminal on macOS or Linux, or a WSL terminal on Windows. The commands
  below use a POSIX shell. Keep the project and its data inside the WSL
  filesystem if you use WSL.

Check that Bun is available:

```sh
bun --version
```

## 2. Download and install Atelier

```sh
git clone https://github.com/SneakyShadyLurker/atelier-studio.git
cd atelier-studio
bun install --frozen-lockfile
```

If you downloaded a ZIP, open a terminal in the extracted folder containing
`package.json`, then run `bun install --frozen-lockfile`. This folder is the
**project root**. Start every terminal in the following steps there.

The lockfile fixes dependency versions. Use Bun rather than npm, pnpm or Yarn.

## 3. Create your local configuration

The API reads its environment from `api/.env`. Create that file in your editor
with the following contents. If it already exists, edit it instead of replacing
it. Replace `/absolute/path/to/atelier-data` with an absolute directory path
that your account can write to, such as `/Users/yourname/atelier-data` on macOS
or `/home/yourname/atelier-data` on Linux or WSL. Do not use a literal `~`.

```dotenv
DATA_DIR=/absolute/path/to/atelier-data
API_HOST=127.0.0.1
API_PORT=8786
ENABLE_MOCK_PROVIDER=true
PROMPT_LIBRARY_USERS=alice
TEXT_PROVIDER_ADMINS=alice
```

Create the directory you chose, substituting the same path:

```sh
mkdir -p /absolute/path/to/atelier-data
chmod 600 api/.env
```

`PROMPT_LIBRARY_USERS` and `TEXT_PROVIDER_ADMINS` give the local user `alice`
the Prompt Library and the Text models view. Leave CLIProxyAPI, ComfyUI and
`STORAGE_ROOT_RECIPIENT` unset for now. Use a fresh data directory, separate
from any production data.

## 4. Start the API

In **terminal 1**, at the project root:

```sh
bun run dev:api
```

Wait for `atelier api listening` in the log. Keep this terminal open.
The API runs at `127.0.0.1:8786`. It creates its database and a development
encryption identity in your data directory automatically.

## 5. Start the local sign-in proxy

Atelier normally receives the signed-in username from an authentication proxy.
For this local test, **terminal 2** supplies the fixed username `alice`:

```sh
bun -e '
Bun.serve({
  hostname: "127.0.0.1",
  port: 8787,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = "8786";
    const headers = new Headers(req.headers);
    headers.set("Remote-User", "alice");
    return fetch(url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
  },
});
console.log("Local sign-in proxy: http://127.0.0.1:8787");
'
```

Keep this terminal open too. This proxy forwards response streams without
buffering them. It does not authenticate anyone. Keep it bound to loopback
and do not expose it or the development servers to your network.

## 6. Open the app and generate a test image

In **terminal 3**, at the project root:

```sh
bun run dev:web
```

Open **[http://localhost:5173](http://localhost:5173)**. Then:

1. Check the model chip in the composer at the bottom of the screen. Without
   any provider configured it already shows `Mock`; otherwise open it and
   choose **Mock Fast**. The chip shows a short family name; hover it for the
   full model name.
2. Enter a short prompt, such as `A blue ceramic cup on a wooden table`.
3. Open the count chip (`×2`), choose `×1`, and press **Generate**.
4. Open the resulting tile and download it.
5. Refresh the page and confirm that the batch is still in your history. The
   composer keeps Mock Fast and `×1` selected.

The result is a **32 × 32 solid-colour PNG**, regardless of the prompt. That
checks the app, API, identity forwarding, storage and download path. It is not
an AI-generated picture. Enhance and the other text actions answer "No text
model is set up" until you [connect a text model](connect-a-text-model.md).
Because `alice` is a text-model admin, **Text models** appears in the sidebar
below **Prompt Library**.

Continue with [Using Atelier](user-guide.md) for the normal workflow.

## Stop, restart and keep your work

Press **Ctrl+C** in each of the three terminals to stop the local installation.
To return later, run steps 4, 5 and 6 again from the project root. After editing
`api/.env`, stop and restart the API so the new configuration is loaded.

Your batches and images live in `DATA_DIR`, not in the browser. The development
identity is `DATA_DIR/.storage-root.dev.txt`; keep it with your development data.
Losing it makes encrypted files unreadable. Development stores this identity on
disk for convenience; production uses the separate unseal procedure in the
[deployment guide](deployment.md#artifact-encryption). Never commit `.env`,
the identity or your data directory.

## Connect a real model

Atelier is an interface and server, not a model-hosting service. Provider access
may cost money, and local generation needs suitable hardware and model weights.
Choose one image path, and add a text model if you want the text features. You
do not need every provider.

| Path | What you supply | What to configure |
|---|---|---|
| Google Gemini, with your own key | A Google AI Studio key with access and quota for a supported image model | Server BYOK encryption key, then your Google key in the app |
| GPT Image through an upstream proxy | A service supporting Atelier's GPT image adapter and model ID, plus an OpenRouter key for the GPT input check | `CLIPROXY_BASE_URL`, `CLIPROXY_TOKEN`, `OPENROUTER_API_KEY` |
| Local ComfyUI | GPU host, required weights and the included authenticated worker | Worker URL, token, certificate and `LOCAL_MODELS_USERS` |
| Any text model, for Enhance, AI fill, Brainstorm and the other text features | A local Ollama or LM Studio, or a key for OpenAI, Anthropic, OpenRouter or another OpenAI-compatible service | `TEXT_PROVIDER_ADMINS`, then the provider in the app's Text models view. See [Connect a text model](connect-a-text-model.md) |

### Google Gemini

1. Generate a server encryption key with `openssl rand -hex 32`. Save the result
   as `BYOK_ENCRYPTION_KEY` in `api/.env` and keep a secure backup. This encrypts
   stored provider keys; it is separate from your Google API key.
2. Restart the API.
3. Obtain your Google key from [Google AI Studio](https://aistudio.google.com/apikey).
4. Open **API keys** at the bottom of Atelier's sidebar, enter the Google key
   and save it. The server verifies it before saving.
5. Choose a Gemini image model and generate a single image to check access.

The Google key belongs to the current user. Direct Gemini image generation does
not need CLIProxyAPI. Text-assisted features need a text model of their own,
described in [Connect a text model](connect-a-text-model.md).

### GPT Image

Configure your own [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
or compatible service first. Atelier's cloud image adapter requests
`gpt-image-2.5-sunburst` and uses its image generation, edit and streaming
contracts. A generic OpenAI-compatible chat endpoint alone is insufficient.
The [provider reference](providers.md#cliproxyapi-cloud) describes the contract.

Set the service's bare origin, without `/v1`, as `CLIPROXY_BASE_URL`, and use a
token that service already accepts. Set both or neither. Set `OPENROUTER_API_KEY`
for Atelier's GPT input-moderation check. GPT requests fail closed when that
check is unavailable. Restart the API, select GPT Image and generate a test image.

These settings serve only GPT Image. Text features use the text models you
connect in the app. If your CLIProxyAPI also serves chat models, add it there as
a **Custom OpenAI-compatible** provider with the base URL ending in `/v1`. See
[Connect a text model](connect-a-text-model.md#other-servers).

### Local ComfyUI

Follow the [ComfyUI worker installation](../infra/comfyui/README.md) and the
[local model requirements](local-models.md). The included provisioning procedure
targets a **Windows portable ComfyUI installation**. Plain ComfyUI without the
Atelier worker is not a supported substitute. The word “private” in the worker
name describes its privacy controls; its code is included in this public repo.

Configure `COMFYUI_BASE_URL`, `COMFYUI_ATELIER_TOKEN`, `COMFYUI_ATELIER_CA` and
`LOCAL_MODELS_USERS=alice` in `api/.env`, then restart the API. Keep the worker's
certificate newlines intact. Install every weight and custom node required by
the selected graph. Atelier does not download weights or turn arbitrary
ComfyUI workflows into model-menu entries automatically.

Video uses disabled MiniMax H3 templates that require verification on your own
host before enabling. See [bundled rows](local-models.md#bundled-rows).

## If something does not work

| Symptom | Check |
|---|---|
| API exits with `ConfigError` | Read the named field, check `api/.env`, and use an absolute writable `DATA_DIR` |
| App opens but requests fail with 401 | Terminal 2 must be running; the local username is supplied by that proxy |
| Vite reports a busy port | Stop the process you started on 5173, or finish the other local session before starting this one |
| Proxy or API cannot bind | Another process owns 8787 or 8786; do not stop processes you do not own |
| Mock Fast is missing | Check `ENABLE_MOCK_PROVIDER=true`, ensure `NODE_ENV` is not `production`, and restart the API |
| Google key dialog says BYOK is not configured | Set a valid `BYOK_ENCRYPTION_KEY` and restart the API |
| Enhance or AI fill says "No text model is set up" | Connect a text model and set a default. See [its troubleshooting table](connect-a-text-model.md#troubleshooting) |
| No local model appears | Check the worker configuration and exact username in `LOCAL_MODELS_USERS` |
| A real provider returns an error | Check the API log, provider credentials, model access and quota; the mock test does not verify upstream access |

For development checks, the root scripts are `bun run typecheck`, `bun run lint`
and `bun run test`. The full test command also needs Python 3.11+ as `python3`.
