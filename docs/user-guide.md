# Using Atelier

Atelier keeps your generations in server-side history, scoped to your signed-in
username. If you have not installed it yet, start with [Getting started](getting-started.md)
or [Deployment](deployment.md).

## Generate your first image

1. Select a model with the model chip in the composer at the bottom of the
   screen. The chip shows a short family name, such as `GPT`, `Banana` or
   `Mock`; hover it for the full model name. The menu groups the models
   available on this installation into Local and Cloud, and marks models that
   need your own key as **Key required**.
2. Enter a prompt describing the picture you want.
3. Choose an aspect ratio with the ratio chip (for example `1:1`) and the number
   of images with the count chip (`×1` to `×4`). The available choices depend
   on the model.
4. Press **Generate**, or **Cmd+Enter** on macOS / **Ctrl+Enter** elsewhere while
   editing the prompt.
5. Watch the tiles. Some providers stream previews; others return only the
   finished image. A queued batch waits for capacity.

Atelier remembers your model, ratio and count for your account in this browser,
so they are still selected after a reload. When nothing is remembered, it opens
on a model you can use without adding a key.

Choose **Mock Fast** only when testing a development installation. Its small
solid-colour images do not reflect your prompt.

For Gemini, open **API keys** at the bottom of the sidebar and save your own
Google key first. If the dialog reports that BYOK is not configured, the server
operator needs to set `BYOK_ENCRYPTION_KEY`. Provider credits and quotas belong
to the configured service or your own key.

Text features such as **Enhance** need a text model, which an admin connects
in the **Text models** view, listed in the sidebar below **Prompt Library**
for admins. If they answer "No text model is set up", ask
your operator, or follow [Connect a text model](connect-a-text-model.md) if
you run the server yourself.

## Open, download and reuse results

Click a finished tile to open the lightbox. Use the arrows to move between
images in the batch and **Escape** to close it. You can zoom an image and
download the finished file. A download is a decrypted copy on your computer;
keep it somewhere appropriate for its contents.

**Edit from this image** puts a finished image into a new reference-based
request when an editing model is available. It leaves the original result in
history. Change the prompt and generate again to create a new batch.

Refresh the page to reconnect to server history. Closing the browser is not a
cancel operation; use the batch's cancel control when you want to stop work.

## Work with reference images

Attach a reference in the composer, then write what you want the model to do
with it. The selected model determines the reference count and supported
workflow: GPT accepts up to four, Gemini up to ten, and the bundled Krea
reference graph uses one face reference. MOSS does not accept references.

Reference uploads are kept with your user data. Removing a reference from the
current prompt changes the next request; it does not rewrite a completed batch.
Use the app's upload controls for removing stored uploads rather than editing
files in `DATA_DIR`.

## Organise your work

The **Library** sidebar contains your collections, **Unsorted** work and
**Pinned** batches. Create a collection with **+ New collection**, then drag
a batch into it. Pin a batch to make it easier to find, and use search to look
for prompt text.

Archiving removes work from the active views. Open **Archive** to restore
archived results, or delete them permanently. Archived work is retained for
30 days before expiry; permanent deletion and **Empty Archive** cannot be
undone. Download anything you want to keep before permanently deleting it.

Your history lives on the server. Changing browser, or clearing browser storage,
does not delete it. Signing in under a different username gives you a different
history; the server does not merge usernames automatically.

## Prompt Library and text assistance

The operator enables **Prompt Library** for selected users. If it is missing,
ask the operator to add your exact signed-in username to `PROMPT_LIBRARY_USERS`.
New installations do not include the operator's personal prompt library.

- **Templates** hold reusable prompt text.
- **Variable lists** provide alternatives for parts of a template.
- **Dimensions** group tags that keep related choices coherent.
- **Settings** picks which text model writes for each task, and its reasoning
  effort where the model offers one.

Start with a simple reusable template, then add variables as you need them.
The **Library** chip in the composer opens the picker. A roll queue lets
you prepare multiple prompts before generating them.

**Enhance** asks a text model to rewrite a prompt. **Brainstorm** produces ideas
for the queue, and `{{ai-fill: instruction}}` asks a text model to fill a part
of a template at generation time. These actions need a text model connected by
an admin. A working image provider or local GPU alone does not provide one.

In **Settings**, each task (Enhance, AI fill, Brainstorm and the rest) shows a
model menu. **Use default** follows what the admin chose and names that model.
Pick another model to use it for that task, and choose a reasoning effort if
the model offers levels. A model that is offline right now cannot be picked,
and if your pick goes offline, the task uses the default until it is back. The
admin can set one text model to write every prompt for a particular image
model. Your pick does not apply there, so the result can come from a different
model than the one you chose.
Read [Prompt Library authoring](prompt-library-authoring.md) for syntax,
weights, dimensions and worked examples.

## Video, Extend and stories

These features appear only when the installation has suitable local models and
the operator has enabled them. Bundled MiniMax H3 graphs are disabled templates
and are unverified on a live host; the operator must validate them before use.

For image-to-video, choose **Animate this image** on a finished still, or select
an image-to-video model and supply a source still. Describe the movement in the
**Motion prompt**, choose an offered duration and press **Animate**. A
text-to-video model starts from text without a still.

**Extend this video** continues a supported clip; Atelier can stitch the
segments into a sequence master for download. AI Storytelling plans and renders
connected segments. Video jobs may take much longer than image jobs. An
offline model or a template that has not been enabled is an operator setup
issue, not a prompt problem. The [local model guide](local-models.md) explains
the requirements.

The optional Ephemera character-card action also needs operator configuration
and a separate Ephemera installation. See [the integration setup](deployment.md#ephemera-character-cards-optional).

## Understand errors and missing features

| What you see | What to do |
|---|---|
| A model is offline | Ask the operator to check the model host, required weights and worker readiness |
| A key or quota error | Check the relevant provider account, access and credits; retry after the stated delay |
| GPT input check unavailable | Ask the operator to check OpenRouter configuration; Atelier blocks GPT requests while the check is unavailable |
| Images cannot be read after a server restart | Ask the operator to check whether encrypted storage has been unsealed |
| Missing local models or Prompt Library | Check the user allowlists with the operator |
| Your history seems empty | Confirm that you are using the same server and signed-in username |

For an issue report, include what you tried, the model name and the visible
error. Do not post API keys, private prompts, images or a populated `.env`.
Operators can find the maintenance commands in [Deployment](deployment.md#day-to-day-operation).
