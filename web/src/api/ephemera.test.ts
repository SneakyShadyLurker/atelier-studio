import type { CharacterCardPhase } from '@atelier/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createCharacterCard } from './ephemera';

const originalFetch = globalThis.fetch;
const tileId = '7b0c9a8e-3f43-4d0f-9d4a-6c1f1f2b9e10';
const characterId = '0d8f6b52-3c1a-4e7e-9b2f-5a6c7d8e9f01';

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe('createCharacterCard', () => {
  test('resolves on the result frame and reports each status phase', async () => {
    const fetchMock = mock(() => Promise.resolve(sseResponse([
      'event: status\ndata: {"phase":"reading"}\n\n',
      ': keepalive\n\n',
      'event: status\ndata: {"phase":"writing"}\n\n',
      'event: status\ndata: {"phase":"saving"}\n\n',
      'event: result\ndata: {"characterId":"c-1","name":"Mara Voss","url":"https://ephemera.example/characters/c-1"}\n\n',
    ].join(''))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const phases: CharacterCardPhase[] = [];

    const result = await createCharacterCard(tileId, characterId, '', 'subject', (phase) => { phases.push(phase); });

    expect(result).toEqual({ characterId: 'c-1', name: 'Mara Voss', url: 'https://ephemera.example/characters/c-1' });
    expect(phases).toEqual(['reading', 'writing', 'saving']);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(input).toBe(`/api/tiles/${tileId}/character-card`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ characterId, kind: 'subject' });
  });

  test('sends the trimmed direction only when it has text, and always the kind', async () => {
    const result = 'event: result\ndata: {"characterId":"c-1","name":"Mara Voss","url":"https://ephemera.example/characters/c-1"}\n\n';
    const fetchMock = mock(() => Promise.resolve(sseResponse(result)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await createCharacterCard(tileId, characterId, '  a retired sea captain \n', 'group', () => undefined);
    await createCharacterCard(tileId, characterId, '   ', 'scenario', () => undefined);

    const bodies = (fetchMock.mock.calls as unknown as [string, RequestInit][])
      .map(([, init]) => JSON.parse(init.body as string) as unknown);
    expect(bodies).toEqual([
      { characterId, direction: 'a retired sea captain', kind: 'group' },
      { characterId, kind: 'scenario' },
    ]);
  });

  test('rejects with the terminal error message, and with the stream-ended message on EOF', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseResponse([
      'event: status\ndata: {"phase":"reading"}\n\n',
      'event: error\ndata: {"message":"Pick a reply model in Ephemera\'s settings first.","code":"no-model"}\n\n',
    ].join('')))) as unknown as typeof fetch;
    const terminal = await rejectedValue(createCharacterCard(tileId, characterId, '', 'subject', () => undefined));
    expect(terminal).toBeInstanceOf(Error);
    expect((terminal as Error).message).toBe("Pick a reply model in Ephemera's settings first.");

    globalThis.fetch = mock(() => Promise.resolve(sseResponse(
      'event: status\ndata: {"phase":"writing"}\n\n',
    ))) as unknown as typeof fetch;
    const ended = await rejectedValue(createCharacterCard(tileId, characterId, '', 'subject', () => undefined));
    expect(ended).toBeInstanceOf(Error);
    expect((ended as Error).message).toBe('character card stream ended');
  });
});
