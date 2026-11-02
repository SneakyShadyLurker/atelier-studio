import { describe, expect, test } from 'bun:test';
import { legacyTextModelId, testRuntime } from '../test/helpers';
import { imageModelRouting, textModelFailureBody, textProviderForResolved } from './textRouting';

describe('textProviderForResolved', () => {
  test('returns one cached feature provider per model row', () => {
    const runtime = testRuntime({ seedLegacyText: true });
    const kimi = { id: legacyTextModelId(runtime.db, 'kimi') };
    const gpt = { id: legacyTextModelId(runtime.db, 'gpt') };
    const first = textProviderForResolved(runtime.config, runtime.text, kimi);
    expect(textProviderForResolved(runtime.config, runtime.text, kimi)).toBe(first);
    expect(textProviderForResolved(runtime.config, runtime.text, gpt)).not.toBe(first);
  });
});

describe('imageModelRouting', () => {
  test('only a registered image model selects a prompt writer', () => {
    const { config } = testRuntime();
    expect(imageModelRouting(config, 'gpt-image-2.5-sunburst')).toEqual({ imageModelId: 'gpt-image-2.5-sunburst' });
    expect(imageModelRouting(config, 'not-a-model')).toEqual({});
    expect(imageModelRouting(config, undefined)).toEqual({});
  });
});

describe('textModelFailureBody', () => {
  test('maps each resolver failure to its 409 code and plain-English copy', () => {
    expect(textModelFailureBody('not-configured')).toEqual({
      error: 'No text model is set up. An admin can add one under Text models.',
      code: 'TEXT_MODEL_NOT_CONFIGURED',
    });
    expect(textModelFailureBody('no-vision-model')).toEqual({
      error: 'None of the available text models accepts images. Remove the reference images or ask an admin to enable image input on a model.',
      code: 'TEXT_MODEL_NO_VISION',
    });
    expect(textModelFailureBody('pin-unavailable').code).toBe('TEXT_MODEL_UNAVAILABLE');
  });
});
