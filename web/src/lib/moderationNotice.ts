import type { GptModerationCategory, GptModerationNotice, GptModerationReason } from '@atelier/shared';
import { create } from 'zustand';

// Ephemeral UI only. Durable image decisions live on the failed history tile.
export const useModerationNotice = create<{
  notice: GptModerationNotice | null;
  show: (notice: GptModerationNotice) => void;
  dismiss: () => void;
}>((set) => ({
  notice: null,
  show: (notice) => { set({ notice }); },
  dismiss: () => { set({ notice: null }); },
}));

interface ReasonCopy { label: string; explanation: string; guidance: string }

// Historical records contain only this broader classification. Never invent a
// precise nudity/age diagnosis for those requests.
const COPY: Record<GptModerationReason, ReasonCopy> = {
  'sexual-age': {
    label: 'Nudity or sexual content',
    explanation: 'This input was classified as explicit nudity, or sexual content involving a minor or someone whose age is unclear.',
    guidance: 'Remove explicit nudity, even for adults, and sexual content involving minors or unclear ages before submitting a new request.',
  },
  'graphic-violence': {
    label: 'Graphic violence',
    explanation: 'This input was classified as a request for graphic violence, gore or severe bloody injury.',
    guidance: 'Remove the graphic injury details before submitting a new request.',
  },
  'sexual-age-and-violence': {
    label: 'Nudity or sexual content & violence',
    explanation: 'This input was classified as explicit nudity or sexual content involving a minor or an unclear age, together with graphic violence.',
    guidance: 'Remove explicit nudity, disallowed sexual content and graphic injury details before submitting a new request.',
  },
  unavailable: {
    label: 'No classification made',
    explanation: 'The content check could not be completed, so Atelier held this request.',
    guidance: 'This is not a content rejection. Please try again in a moment.',
  },
};

const CATEGORY_COPY: Record<GptModerationCategory, ReasonCopy> = {
  nudity: {
    label: 'Explicit nudity',
    explanation: 'This input was classified as a request for explicit nudity. This restriction applies to adults too.',
    guidance: 'Remove the nudity from your request before trying again.',
  },
  'sexual-age': {
    label: 'Sexual content & age',
    explanation: 'This input was classified as sexual content involving a minor or someone whose adulthood is unclear.',
    guidance: 'Remove sexual content involving minors or people whose adult age is not established.',
  },
  'graphic-violence': COPY['graphic-violence'],
};

export function moderationCopy(notice: GptModerationNotice) {
  const details = notice.reason !== 'unavailable' && notice.categories?.length
    ? notice.categories.map((category) => ({ ...CATEGORY_COPY[category], key: category }))
    : [{ ...COPY[notice.reason], key: notice.reason }];
  return {
    details,
    label: details.map((detail) => detail.label).join(' · '),
    explanation: details.map((detail) => detail.explanation).join(' '),
    guidance: details.map((detail) => detail.guidance).join(' '),
    title: notice.reason === 'unavailable' ? 'Content check unavailable' : 'Request stopped',
    delivery: `Not sent to ${notice.target === 'image' ? 'GPT Image' : notice.modelLabel ?? 'the text model'}`,
  };
}

export class ModerationError extends Error {
  override readonly name = 'ModerationError';
  constructor(readonly moderation: GptModerationNotice) {
    super(moderationCopy(moderation).explanation);
  }
}
