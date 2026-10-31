# Connect a text model

Atelier uses a text model (an LLM) for every feature that writes words
instead of pixels. That covers **Enhance**, `{{ai-fill: …}}` blanks,
**Brainstorm**, story planning, the motion writer for video, Krea prompt
condensing and the AI helpers in the Prompt Library. Image generation works without one, but until an admin
connects a text model those features fail with "No text model is set up".

This guide connects one, step by step. It assumes Atelier already runs, either
locally from [Getting started](getting-started.md) or on a server from
[Deployment](deployment.md).

## Providers and models

A **provider** is a server that answers text requests at one address, such as
Ollama on your own computer, OpenAI or OpenRouter, with an API key if that
server needs one. A **model** is one model on that provider, such as
`llama3.2` on Ollama, and you can add as many models from as many providers as
you like.

Atelier speaks two protocols. **OpenAI-compatible** covers OpenAI, OpenRouter,
Groq, Google Gemini's compatible endpoint, Ollama, LM Studio, vLLM and most
proxies. **Anthropic** covers Claude models through Anthropic's API.

## Before you start

Add these lines to the API's environment file (`api/.env` for a local install,
`infra/docker/.env` for Docker), then restart the API.

1. Name who may manage text models. Use the exact signed-in usernames,
   separated by commas. Nobody else sees the Text models view, and the admin
   routes answer "not found" to them.

   ```dotenv
   TEXT_PROVIDER_ADMINS=alice
   ```

2. If any provider needs an API key, the server must be able to encrypt it.
   Generate a master key once with `openssl rand -hex 32` and set it:

   ```dotenv
   BYOK_ENCRYPTION_KEY=<64 hex characters from openssl rand -hex 32>
   ```

   Production installs already require this key. On a local install without
   it, keyless providers such as Ollama and LM Studio still work, but the
   **API key** field is disabled and the dialog explains why. Keep the key
   safe. If it changes, saved provider keys can no longer be read.

3. Only if you plan to use **Screen requests first** (see
   [below](#screen-requests-first)), add an OpenRouter key:

   ```dotenv
   OPENROUTER_API_KEY=<your OpenRouter key>
   ```

After the restart, sign in as one of the admins. A **Text models** button (a
chip icon) appears at the bottom of the sidebar, next to **API keys**. Click it
to open the Text models view. With nothing connected yet it shows "No text
model yet" and an **Add provider** button.

## Connect a local model

Local models cost nothing per request and keep your prompts on your own
hardware. They need a computer that can run the model, and smaller models
write weaker prompts.

### Ollama

1. Install [Ollama](https://ollama.com), then download a model in a terminal,
   for example `ollama pull llama3.2`. Any model you have pulled works, and
   the name here is only an example.
2. In Atelier's Text models view, click **Add provider**.
3. Under **Preset**, choose **Ollama**. Atelier fills in the name `Ollama` and
   the **Base URL** `http://localhost:11434/v1`.
4. Leave **API key** empty. Ollama does not need one unless you set one up.
5. If Atelier runs in Docker, change the Base URL first. See
   [When Atelier runs in Docker](#when-atelier-runs-in-docker).
6. Click **Test connection**. A working server answers "Connection works." and
   says how many models it listed.
7. Click **Save provider**. It stays disabled until the connection test
   passes. The **Add models from Ollama** dialog opens next, so continue with
   [Add models](#add-models).

### LM Studio

1. Install [LM Studio](https://lmstudio.ai), download a model and start its
   local server from the Developer tab. The server listens on port 1234 by
   default.
2. In the Text models view, click **Add provider** and choose the **LM Studio**
   preset. The Base URL becomes `http://localhost:1234/v1`.
3. Leave **API key** empty, adjust the address for Docker if needed, then click
   **Test connection** and **Save provider**.
4. Pick models in the dialog that follows.

### When Atelier runs in Docker

Inside the Atelier container, `localhost` means the container itself, not your
computer. A Base URL of `http://localhost:11434/v1` therefore fails with a
"Could not reach the server" message even while Ollama runs fine on the host.
Use an address the container can reach instead:

- On Docker Desktop (macOS and Windows): `http://host.docker.internal:11434/v1`
  for Ollama, `http://host.docker.internal:1234/v1` for LM Studio.
- On Linux, or when the model runs on another machine, use that machine's LAN
  address, such as `http://192.168.1.20:11434/v1`.

The model server must also accept connections from outside its own machine.
Ollama listens only on `127.0.0.1` unless you start it with
`OLLAMA_HOST=0.0.0.0`. In LM Studio, turn on serving on the local network in
the server settings. Keep these servers off the public internet, because
neither asks for a key by default.

A local install started with `bun run dev:api` runs outside Docker, so the
preset's `localhost` address works there unchanged.

## Connect a cloud provider

Cloud providers need an API key and charge per request. Set
`BYOK_ENCRYPTION_KEY` first (see [Before you start](#before-you-start)). Atelier
encrypts the key, never sends it to the browser, and shows only its last four
characters afterwards.

### OpenRouter

OpenRouter sells access to models from many companies with one key, and its
model list says which models accept images.

1. Create a key at [openrouter.ai](https://openrouter.ai) under **Keys**.
2. Click **Add provider** and choose the **OpenRouter** preset. The Base URL
   becomes `https://openrouter.ai/api/v1`.
3. Paste the key into **API key**. **Show** reveals it while you check it.
4. Click **Test connection**, then **Save provider**.
5. In **Add models from OpenRouter**, type part of a name into the search box
   and tick the models you want. Hints such as "image input · JSON ·
   reasoning" come from OpenRouter's list.

### OpenAI

1. Create a key at [platform.openai.com](https://platform.openai.com).
2. Click **Add provider**, choose the **OpenAI** preset (Base URL
   `https://api.openai.com/v1`) and paste the key.
3. Click **Test connection**, then **Save provider**, and tick the models you
   want, for example `<your-model-id>` from your OpenAI account's model list.

### Anthropic

1. Create a key at [console.anthropic.com](https://console.anthropic.com).
2. Click **Add provider** and choose the **Anthropic** preset. The Base URL
   becomes `https://api.anthropic.com/v1` and the protocol is set to
   Anthropic for you.
3. Paste the key, click **Test connection**, then **Save provider**, and tick
   the Claude models you want.

### Other servers

The **Groq** and **Google Gemini (OpenAI-compatible)** presets work the same
way. For anything else, choose **Custom OpenAI-compatible** or **Custom
Anthropic-compatible** and enter the server's address, including any path such
as `/v1`. The address must start with `http://` or `https://` and must not
carry a username, password, `?query` or `#fragment`. Local network addresses
are allowed.

Two settings under **Advanced** in the provider form matter for unusual
servers:

- **Output limit field**: OpenAI uses `max_completion_tokens`. Most local and
  older servers expect `max_tokens`. The presets pick the right one.
- **Check the model list**: Atelier reads the server's model list to test the
  connection and to show which models are online. Turn it off for a server
  that has no list. **Model to test with** then appears, and the connection
  test sends one short request to that model instead.

If the test reports that the server has no model list, **Save anyway** appears.
Save the provider and type the model ids yourself.

## Add models

**Add models** opens right after you save a provider. For an existing
provider, click **Add models** at the bottom of its section.

- **From the list.** Atelier loads the provider's model list. Search it, tick
  the models you want and click **Add N models**. Models you already added show
  as "Added".
- **By hand.** If a model is missing from the list, or the provider has no
  list, type its exact id into **Not listed? Enter a model id** and click
  **Add**. The id must match what the provider expects, character for
  character.

Each new model appears in the provider's section with its display name, its
id, small icons for image input, JSON output and reasoning, and a status:

- **available**: the provider lists the model right now.
- **offline**: the provider answered but did not list this model. Atelier
  skips offline models and uses the next one in line.
- **unknown**: Atelier has not been able to check yet, or the provider's
  list is turned off. Unknown models are still used.

Atelier rechecks each provider's list every minute. **Check again** asks
straight away. The switch at the end of each row turns a model on or off
without deleting it.

## Test a model

Imported models start with capabilities guessed from the provider's list, and
models typed by hand start with plain defaults. A model that has never been
tested shows **Untested** on its row. Testing confirms what it can actually do.

1. Click **Untested**, or open the row's **More** menu (the three dots) and
   choose **Test**. The **Edit model** dialog opens and the test starts.
   Inside the dialog, the button is **Test model**.
2. Wait for the four checks. Each one can take up to 20 seconds.
3. Read the results, then click **Apply findings** and **Save**.

| Check | What Atelier sends | What the result means |
|---|---|---|
| Plain reply | "Reply with exactly: OK" | The model answers at all. If this fails, the other three are skipped. |
| JSON output | A request for one small JSON object, first with a strict schema, then plain JSON mode | Which JSON mode the model honours. Prompt Library helpers need structured answers. "The server refused both JSON modes" turns JSON output off. |
| Image input | A tiny test picture | Whether the model can read reference images. A refusal turns **Image input** off. |
| Reasoning | Reasoning effort `low`, then `high` | Whether people can choose a reasoning effort for this model. A refusal turns the levels off. |

"Confirmed by the test" lists what the test proved. "Reported by the provider"
lists extra claims from the provider's list that the test did not exercise,
such as more reasoning levels. They start unticked, so tick the ones you trust.
**Apply findings** never overwrites a field you changed yourself in the
dialog, and nothing is stored until you click **Save**. A model whose test
passed shows "Last tested" with the time.

A test only proves the model handled one tiny request. Try **Enhance** on a
real prompt afterwards to judge the writing.

### Other model settings

The **Edit model** dialog also holds **Display name**, **Max images** (a cap
on reference images per request), **JSON output**, **Reasoning levels** and
**Default effort**. Under **Advanced**:

- **Temperature**, **Top P** and **Fixed output tokens**: leave them empty to
  use the provider's defaults. Fixed output tokens replaces every task's own
  output budget.
- **Slow model**: waits longer and accepts larger replies, for models that
  think for minutes.
- **Prompt style**: **Standard** suits most models. **Kimi-tuned** is a
  variant of the AI fill instructions written for Kimi models.
- **Screen requests first**: see [below](#screen-requests-first).

## Choose which model writes what

The **Routing** panel at the top of the Text models view decides which model
each feature uses.

1. **Default model**: every task uses it unless assigned below. Set this first.
   One default is enough to switch on every text feature.
2. **Task assignments**: give a single task its own model. The tasks are
   Enhance, Motion writer, AI fill, Brainstorm, Krea condense, Story planner,
   Story segments, Dimension inference, Dimension rescue, List drafts and
   Template drafts. **Use default** clears an assignment.
3. **Prompt writers**: pick a model to write every prompt for one image model.
   After you pick one, choose how firmly it applies:
   - **Always use this model** (lock). This model writes every prompt for
     that image model, and people's own picks do not apply. If it is turned off or
     cannot take an attached image, the request fails instead of quietly
     moving to another model.
   - **Use unless the person picked their own** (prefer). This model replaces
     the task assignment and the default for that image model, but a person's
     own pick in Settings still wins.

For each request, Atelier walks this order and uses the first model that is
switched on, not offline, and able to read images when the request carries
some:

1. A locked prompt writer for the selected image model.
2. The person's own pick for the task in Settings.
3. A preferred prompt writer for the selected image model.
4. The task assignment.
5. The default model.

If nothing qualifies, the feature reports "No text model is set up" or, when
images are attached, "None of the available text models accepts images".

## Let people pick their own model

Everyone with the Prompt Library can open **Prompt Library**, then the
**Settings** tab. The **Text models** section lists every task with a model
menu. "Use default" follows what the admin set, and the menu shows which model
that is. A person can pick any model that is switched on and not offline, and
for models with reasoning levels, a reasoning effort. Models without levels
show "Effort fixed by the model".

The picked effort applies only while the picked model actually serves the
task. If a picked model goes offline, Settings says so and the task uses the
default until it is back. Admins see how many people picked a model before
they remove it.

## Screen requests first

**Screen requests first** is a switch under **Advanced** in **Edit model**.
When it is on, Atelier checks the text of every request with a content
screen before the request reaches that model, and blocks requests that ask for
explicit nudity, sexual content involving minors or graphic violence. The
check uses a classifier on OpenRouter, so it needs `OPENROUTER_API_KEY` on the
server, and only the text is checked, never image pixels. Without the key,
requests to a screened model are refused, and the provider shows a warning
until the key is set. Details are in
[Providers](providers.md#gpt-only-input-moderation).

Turn it on for a provider whose terms forbid that content, so a refusal
happens in Atelier rather than on your account. Brainstorm never hands a
screened model's request to an unscreened one when it retries on another
model. Leave the switch off for local models you control.

## Troubleshooting

| What you see | What to do |
|---|---|
| No **Text models** button in the sidebar | Add your exact signed-in username to `TEXT_PROVIDER_ADMINS` and restart the API. |
| "Could not reach the server: …" (connection refused) | Check that the model server is running and that the Base URL, including the port, is right. Under Docker, replace `localhost` (see [When Atelier runs in Docker](#when-atelier-runs-in-docker)). |
| "The server refused the key (401)" or "(403)" | Re-check the API key, then click **Replace key** under **Edit provider** (the pencil next to the provider's name). Check that the key has access and credit. |
| "The server answered with a redirect. Enter the address it redirects to instead." | Atelier never follows redirects. Use the final address, often `https://` instead of `http://`, or with `/v1` added. |
| "The server has no model list at this address (404/405)" | Check the address first. If it is right, turn off **Check the model list** under **Advanced**, enter a **Model to test with**, or use **Save anyway** and add model ids by hand. |
| The model you want is not listed | Type its exact id into **Not listed? Enter a model id**. Some providers only list models your key may use. |
| Keys cannot be stored (the **API key** field is disabled) | Set `BYOK_ENCRYPTION_KEY` and restart the API. |
| "The server refused the image" during **Test model** | The model cannot read images. Atelier turns **Image input** off. Use another model for Enhance or the motion writer with reference images. |
| "The server refused both JSON modes" | The model has no JSON mode. Atelier turns **JSON output** off and asks for JSON in the prompt instead, which works less reliably. Prefer a model that passed this check for the Prompt Library helpers. |
| Requests to a model time out or replies are cut off | Turn on **Slow model** under **Advanced** for models that think for minutes, or choose a lower reasoning effort. |
| "No text model is set up. An admin can add one under Text models." (HTTP 409) | Set a **Default model** in the Routing panel, and check that the model and its provider are switched on. |
| "None of the available text models accepts images. Remove the reference images or ask an admin to enable image input on a model." (HTTP 409) | Remove the reference images, or connect a model that can read images, test it and make sure **Image input** is on. |
| "The text model set for this image model is turned off or unavailable." (HTTP 409) | A locked prompt writer cannot serve. Turn the model back on, or change the writer to another model or to **No writer**. |
| A screened model refuses every request | Set `OPENROUTER_API_KEY`, or turn off **Screen requests first** for that model. |
| A model shows **offline** | The provider answered without listing it. Check the id, or that the local server has the model loaded, then click **Check again**. |
