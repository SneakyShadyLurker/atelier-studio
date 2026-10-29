// Reads a Krea graph's sampling recipe from its single KSampler, so the shared
// workflow tests can hold every row to the same contract.

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export type Link = [string, number];

export interface KreaSampling {
  /** Node whose output 0 is the denoised latent. */
  nodeId: string;
  model: Link;
  positive: Link;
  negative: Link;
  latent: Link;
  seed: unknown;
  steps: unknown;
  cfg: unknown;
  sampler_name: unknown;
  scheduler: unknown;
  denoise: unknown;
}

const isLink = (value: unknown): value is Link =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && value[1] === 0;

function link(node: WorkflowNode, input: string): Link {
  const value = node.inputs[input];
  if (!isLink(value)) throw new Error(`${node.class_type}.${input} is not a link to output 0`);
  return value;
}

export function kreaSampling(graph: Record<string, WorkflowNode>): KreaSampling {
  const samplers = Object.entries(graph).filter(([, node]) => node.class_type.includes('Sampler'));
  const [entry] = samplers;
  if (samplers.length !== 1 || !entry) throw new Error(`expected one sampler, found ${samplers.length}`);
  const [nodeId, sampler] = entry;
  if (sampler.class_type !== 'KSampler') throw new Error(`expected a KSampler, found ${sampler.class_type}`);

  const { seed, steps, cfg, sampler_name, scheduler, denoise } = sampler.inputs;
  return {
    nodeId,
    model: link(sampler, 'model'),
    positive: link(sampler, 'positive'),
    negative: link(sampler, 'negative'),
    latent: link(sampler, 'latent_image'),
    seed, steps, cfg, sampler_name, scheduler, denoise,
  };
}
