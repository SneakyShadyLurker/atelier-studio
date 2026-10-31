import { describe, expect, test } from 'bun:test';
import type { LanguageModelV4FinishReason } from '@ai-sdk/provider';
import { PermanentUpstreamError, TransientUpstreamError } from '../../lifecycle/resilient-call';
import { classifyFinish, TextFinishError } from './finish';

function finish(unified: LanguageModelV4FinishReason['unified'], raw?: string): { finishReason: LanguageModelV4FinishReason } {
  return { finishReason: { unified, raw } };
}

describe('classifyFinish', () => {
  test('stop completes the stream', () => {
    expect(classifyFinish(finish('stop', 'stop'))).toBeNull();
  });

  test('length is a permanent truncation', () => {
    const err = classifyFinish(finish('length', 'length'));
    expect(err).toBeInstanceOf(TextFinishError);
    expect(err).toBeInstanceOf(PermanentUpstreamError);
    expect(err).toMatchObject({ reason: 'length' });
  });

  test('content-filter is reported as content-filter and keeps the raw wording', () => {
    const err = classifyFinish(finish('content-filter', 'content_filter'));
    expect(err).toBeInstanceOf(TextFinishError);
    expect(err).toMatchObject({ reason: 'content-filter', raw: 'content_filter' });
    expect(err?.message).toBe('content_filter');
  });

  test('tool-calls, error and other are permanent', () => {
    for (const unified of ['tool-calls', 'error', 'other'] as const) {
      const err = classifyFinish(finish(unified, unified === 'other' ? 'weird' : undefined));
      expect(err).toBeInstanceOf(PermanentUpstreamError);
      expect(err).toMatchObject({ reason: unified });
    }
  });

  test('a missing finish part is a transient incomplete stream', () => {
    const err = classifyFinish(undefined);
    expect(err).toBeInstanceOf(TransientUpstreamError);
    expect(err).toMatchObject({ category: 'socket' });
  });

  test('an interrupted stream is a transient incomplete stream', () => {
    expect(classifyFinish(finish('interrupted'))).toBeInstanceOf(TransientUpstreamError);
  });

  test('raw insufficient_system_resource stays transient', () => {
    const err = classifyFinish(finish('other', 'insufficient_system_resource'));
    expect(err).toBeInstanceOf(TransientUpstreamError);
    expect(err).toMatchObject({ category: 'socket', message: 'insufficient_system_resource' });
  });
});
