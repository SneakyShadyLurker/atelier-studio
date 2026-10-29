# Atelier documentation

Index of project documentation. The repository [README](../README.md) covers
the quick start; this directory holds the durable architectural and
operational references.

## Documents

- [`architecture.md`](./architecture.md): system topology, SSE contract,
  provider interface, storage layout, endpoint catalog. **Locked contract.**
  Read before any cross-layer change.
- [`deployment.md`](./deployment.md): Docker Compose deployment, environment,
  artifact encryption, the models directory, the deploy checklist with
  migration rehearsal, and recovery recipes.
- [`providers.md`](./providers.md): `Provider` interface, CLIProxyAPI,
  Gemini and ComfyUI wire shapes, text routing, error mapping, abort
  semantics. Read before touching `api/src/providers/*`.
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
