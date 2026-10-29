import { describe, expect, test } from 'bun:test';
import { joinBrainstormPrompt, splitBrainstormPrompt } from './brainstormPrompt';

describe('brainstorm prompt sections', () => {
  test('round-trips the labelled scaffold', () => {
    const prompt = [
      'Scene / Image type: a candid smartphone snapshot',
      'Subject: a woman in a red dress',
      'Details: she leans on a railing at dusk',
      'Constraints: shown full body from head to feet',
    ].join('\n');
    expect(joinBrainstormPrompt(splitBrainstormPrompt(prompt))).toBe(prompt);
  });

  test('round-trips the fallback prose shape', () => {
    const prompt = 'a quiet portrait in winter\nConstraints: shown full body from head to feet';
    expect(splitBrainstormPrompt(prompt)).toEqual([
      { key: 'prompt', text: 'a quiet portrait in winter' },
      { key: 'constraints', text: 'shown full body from head to feet' },
    ]);
    expect(joinBrainstormPrompt(splitBrainstormPrompt(prompt))).toBe(prompt);
  });

  test('keeps multi-line Details content together', () => {
    const prompt = 'Details: first line\nsecond line\nthird line';
    expect(splitBrainstormPrompt(prompt)).toEqual([
      { key: 'details', text: 'first line\nsecond line\nthird line' },
    ]);
    expect(joinBrainstormPrompt(splitBrainstormPrompt(prompt))).toBe(prompt);
  });

  test('appends repeated labels to the existing canonical section', () => {
    expect(splitBrainstormPrompt('Subject: first\nDetails: moment\nSubject: second')).toEqual([
      { key: 'subject', text: 'first\nsecond' },
      { key: 'details', text: 'moment' },
    ]);
  });

  test('returns no sections for empty input', () => {
    expect(splitBrainstormPrompt('')).toEqual([]);
  });
});
