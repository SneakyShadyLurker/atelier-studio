import type { Config } from '../config';
import { decUserFloored, incUser } from './userCounter';

export type LlmAdmissionAcquireResult =
  | { readonly ok: true; release(): void }
  | { readonly ok: false; readonly reason: 'per-user' | 'global' };

export interface LlmAdmissionPool {
  readonly name: string;
  acquire(userId: string): LlmAdmissionAcquireResult;
}

interface ConfigurableLlmAdmissionPool extends LlmAdmissionPool {
  configure(maxPerUser: number, globalCap?: number): void;
  resetForTests(): void;
}

interface PoolCaps {
  readonly maxPerUser: number;
  readonly globalCap: number | undefined;
}

// Shared across the four pools: every LLM call counts against one total.
// The caps live only in config (MAX_CONCURRENT_LLM_*); `createApp` applies
// them once via configureLlmAdmissionPools before any route or queue worker
// can acquire, so an unconfigured pool is a wiring bug and throws.
const llmGlobal = { inFlightTotal: 0, maxTotal: 0 };

function createLlmAdmissionPool(name: string): ConfigurableLlmAdmissionPool {
  let caps: PoolCaps | null = null;
  const inFlightByUser = new Map<string, number>();
  let poolInFlight = 0;

  return {
    name,
    configure(maxPerUser, globalCap?) {
      // Caps only: never touch live accounting, or reconfiguring with slots
      // held would silently disable the sub-cap.
      caps = { maxPerUser, globalCap };
    },
    acquire(userId) {
      if (caps === null) throw new Error(`LLM admission pool '${name}' used before configureLlmAdmissionPools`);
      const userCount = inFlightByUser.get(userId) ?? 0;
      if (userCount >= caps.maxPerUser) {
        return { ok: false, reason: 'per-user' };
      }
      if (caps.globalCap !== undefined && poolInFlight >= caps.globalCap) {
        return { ok: false, reason: 'global' };
      }
      if (llmGlobal.inFlightTotal >= llmGlobal.maxTotal) {
        return { ok: false, reason: 'global' };
      }

      llmGlobal.inFlightTotal += 1;
      poolInFlight += 1;
      incUser(inFlightByUser, userId, 1);
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          llmGlobal.inFlightTotal = Math.max(0, llmGlobal.inFlightTotal - 1);
          poolInFlight = Math.max(0, poolInFlight - 1);
          decUserFloored(inFlightByUser, userId, 1);
        },
      };
    },
    // Zeroes live accounting; keeps the configured caps.
    resetForTests() {
      poolInFlight = 0;
      inFlightByUser.clear();
    },
  };
}

export const enhancePool = createLlmAdmissionPool('enhance');
export const draftPool = createLlmAdmissionPool('draft');
export const inferPool = createLlmAdmissionPool('infer');
export const rescuePool = createLlmAdmissionPool('rescue');

export function configureLlmAdmissionPools(config: Config): void {
  llmGlobal.maxTotal = config.MAX_CONCURRENT_LLM_TOTAL;
  enhancePool.configure(config.MAX_CONCURRENT_LLM_ENHANCE_PER_USER, config.MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP);
  draftPool.configure(config.MAX_CONCURRENT_LLM_DRAFT_PER_USER, config.MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP);
  inferPool.configure(config.MAX_CONCURRENT_LLM_INFER_PER_USER);
  rescuePool.configure(config.MAX_CONCURRENT_LLM_RESCUE_PER_USER);
}

export function resetLlmAdmissionForTests(): void {
  llmGlobal.inFlightTotal = 0;
  enhancePool.resetForTests();
  draftPool.resetForTests();
  inferPool.resetForTests();
  rescuePool.resetForTests();
}
