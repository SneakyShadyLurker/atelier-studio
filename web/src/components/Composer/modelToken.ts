import type { Model } from '@atelier/shared';

const HOST_LABELS: Readonly<Record<string, string>> = { comfyui: 'ComfyUI' };

/**
 * Display name for a local model's host tag: `comfyui` → `ComfyUI`; any other
 * tag is capitalized (`studio` → `Studio`).
 */
export function hostLabel(id: string): string {
  return HOST_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Compact model-family token for the Composer Model chip. The full name stays
 * available in the dropdown, the batch header, and the chip hover title, so
 * collapsing `Nano Banana Pro` / `Nano Banana 2` → `Banana` and
 * `GPT Image 2.5 Sunburst` → `GPT` only defers variant distinction, never loses it.
 * Local models keep their variant identity (`GonzaLomo`); the
 * serving host is status, not identity — the chip carries it as a health dot
 * plus hover title.
 */
export function shortModelToken(model: Model): string {
  if (model.backend === 'local') {
    const variant = model.name.replace(/^krea\s*2\s+/i, '');
    if (variant !== model.name && variant.length > 0) return variant;
    return model.name.split(/\s+/)[0] ?? model.name;
  }
  if (model.tag === 'google') return 'Banana';
  if (model.id.startsWith('gpt')) return 'GPT';
  return model.name.split(/\s+/)[0] ?? model.name;
}
