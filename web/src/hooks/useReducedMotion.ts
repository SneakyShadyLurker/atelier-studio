import { reducedMotionStore } from '../lib/mediaQueryStore';

export const isReducedMotionPreferred = reducedMotionStore.matches;
export const useReducedMotion = reducedMotionStore.useMatches;
