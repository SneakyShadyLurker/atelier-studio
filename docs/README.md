# Atelier documentation

Start with the guide that matches what you want to do. The public repository
includes everything specific to Atelier; you bring your own hosting, provider
access and, if you use local models, model weights.

## Install and use

| Guide | What you will do |
|---|---|
| [Getting started](getting-started.md) | Download Atelier, run a local test without credentials, then connect a real model |
| [Using Atelier](user-guide.md) | Generate and edit images, organise work, use templates and understand optional features |
| [Admin guide](admin-guide.md) | Become an admin, open the admin panel and set up what Atelier needs to work fully |
| [Connect a text model](connect-a-text-model.md) | Connect Ollama, LM Studio, OpenAI, Anthropic or OpenRouter for Enhance, AI fill and Brainstorm, and choose which model writes what |
| [Deployment](deployment.md) | Set up authentication and encryption; launch, operate, back up and restore a server |
| [ComfyUI worker](../infra/comfyui/README.md) | Provision the included worker on a Windows portable ComfyUI install |
| [Local models](local-models.md) | Inspect model requirements, enable verified graphs and mount custom manifests |

## Technical references

- [`architecture.md`](./architecture.md): system topology, SSE contract,
  provider interface, storage layout, endpoint catalog. **Locked contract.**
  Read before any cross-layer change.
- [`deployment.md`](./deployment.md): Docker Compose deployment, environment,
  artifact encryption, the models directory, the deploy checklist with
  migration rehearsal, and recovery recipes.
- [`providers.md`](./providers.md): `Provider` interface, CLIProxyAPI,
  Gemini and ComfyUI wire shapes, text providers, models and routing,
  error mapping, abort semantics. Read before touching `api/src/providers/*`.
- [`local-models.md`](./local-models.md): local model manifests, the
  external models directory, overrides, `COMFYUI_ENABLE_MODELS` and
  `validate-models`.
- [`prompt-library-authoring.md`](./prompt-library-authoring.md): prompt
  template, variable-list and tag-dimension grammar, pairwise-coherence
  rules, and the per-model prompting contracts (gpt-image-2.5-sunburst,
  Krea 2, MOSS) for template bodies and text-LLM metaprompts.
- [`web-conventions.md`](./web-conventions.md): Web UI conventions, canonical
  component owners and the phone breakpoint contract.
- [Native anchors](./native-anchors.md): overlay relationships, CSS placement,
  browser support, fallback presentations and verification boundaries.

## Subdirectories

- [`handoff/`](./handoff/README.md): pixel-faithful design tokens,
  animations, easing, motion durations. `web/src/styles/tokens.css` mirrors
  the `:root` block from `handoff/design/index.html` verbatim.

## Gitignored working areas

- `specs/`, `plans/`, and `audit/`: local working state and review output,
  not shipped.
- `spikes/`: provider and protocol discovery scratch.
