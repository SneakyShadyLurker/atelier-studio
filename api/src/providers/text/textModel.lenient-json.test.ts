import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TEST_SERVER_HOSTNAME } from '../../test/server';
import { restoreFetch } from '../../test/helpers';
import { genericTextModel, testTextModelProvider } from '../../test/textModelProvider';

// Every model-output JSON parse goes through the repairing parser after the
// strict path: a stray `]` closing an object and a raw newline inside a
// string (the measured DeepSeek defects) parse in each accumulating call.

const servers: Bun.Server<unknown>[] = [];
beforeEach(() => { restoreFetch(); });
afterEach(async () => {
  restoreFetch();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});

/** A streamed answer whose content is `text` verbatim. */
function provider(text: string) {
  const server = Bun.serve({
    port: 0,
    hostname: TEST_SERVER_HOSTNAME,
    fetch: () => {
      const frames = [
        JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        '[DONE]',
      ];
      return new Response(frames.map((f) => `data: ${f}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  servers.push(server);
  return testTextModelProvider({ origin: `http://127.0.0.1:${server.port}`, token: 't', model: genericTextModel('m') });
}

const signal = (): AbortSignal => new AbortController().signal;

describe('model-output JSON repair', () => {
  test('infer: stray bracket and raw newline', async () => {
    const bracket = await provider('{"ops":[{"op":"createDimension","name":"X","tags":["a"]}]]}').inferDimensions('{}', signal());
    expect(bracket).toEqual({ type: 'ok', ops: [{ op: 'createDimension', name: 'X', tags: ['a'] }] });
    const newline = await provider('{"ops":[{"op":"renameDimension","dimIdx":0,"newName":"Two\nlines"}]}').inferDimensions('{}', signal());
    expect(newline).toEqual({ type: 'ok', ops: [{ op: 'renameDimension', dimIdx: 0, newName: 'Two\nlines' }] });
  });

  test('rescue: stray bracket and raw newline', async () => {
    const args = {
      previewSnapshot: { dimensions: [], lists: [] },
      templateLists: [],
      targetListName: 'colours',
      conflictReason: 'test',
    };
    const op = { op: 'addOption' as const, listIdx: 0, tags: [{ dimName: 'Hue', label: 'cool' }] };
    const bracket = await provider(`${JSON.stringify({ ops: [{ ...op, value: 'teal' }] }).slice(0, -1)}]}`).rescueDimension(args, signal());
    expect(bracket).toEqual({ type: 'ok', ops: [{ ...op, value: 'teal' }] });
    const newline = await provider(JSON.stringify({ ops: [{ ...op, value: 'deep_teal' }] }).replace('deep_teal', 'deep\nteal'))
      .rescueDimension(args, signal());
    expect(newline).toEqual({ type: 'ok', ops: [{ ...op, value: 'deep\nteal' }] });
  });

  test('list draft: stray bracket and raw newline', async () => {
    const input = { name: 'Colours', existing: [], target: 5 };
    expect(await provider('{"kind":"clarify","question":"Which?"]}').draftList(input, signal()))
      .toEqual({ type: 'ok', payload: { kind: 'clarify', question: 'Which?' } });
    expect(await provider('{"kind":"entries","entries":["navy\nblue"]}').draftList(input, signal()))
      .toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['navy\nblue'] } });
  });

  test('template draft: stray bracket and raw newline', async () => {
    const input = { name: 'T', existingBody: '', library: { lists: [] } };
    expect(await provider('{"kind":"clarify","question":"Which?"]}').draftTemplate(input, signal()))
      .toEqual({ type: 'ok', payload: { kind: 'clarify', question: 'Which?' } });
    expect(await provider('{"kind":"body","body":"a portrait\nat dusk","warnings":[]}').draftTemplate(input, signal()))
      .toEqual({ type: 'ok', payload: { kind: 'body', body: 'a portrait\nat dusk', warnings: [] } });
  });
});
