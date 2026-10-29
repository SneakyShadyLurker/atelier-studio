import { beforeEach, expect, test } from 'bun:test';
import type { TerminalFrame } from '../lifecycle/sse';
import * as bus from './bus';

beforeEach(() => {
  bus.resetForTests();
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

function terminal(value: string): TerminalFrame {
  return { bytes: text(value), key: null };
}

function makeSink() {
  const terminals: string[] = [];
  const optionals: string[] = [];
  let closed = false;
  return {
    sink: {
      enqueueTerminal(frame: TerminalFrame): void {
        if (!closed) terminals.push(decoder.decode(frame.bytes));
      },
      enqueueOptional(makeFrame: () => Uint8Array): void {
        if (!closed) optionals.push(decoder.decode(makeFrame()));
      },
    },
    close: () => {
      closed = true;
    },
    terminals,
    optionals,
    isClosed: () => closed,
  };
}

test('broadcastTerminal reaches every subscriber', () => {
  const s1 = makeSink();
  const s2 = makeSink();
  bus.subscribe('b1', s1.sink);
  bus.subscribe('b1', s2.sink);
  bus.broadcastTerminal('b1', terminal('hello'));
  expect(s1.terminals).toEqual(['hello']);
  expect(s2.terminals).toEqual(['hello']);
});

test('broadcastTerminal snapshots subscribers before delivery', () => {
  const terminals: string[] = [];
  let offSecond: () => void = () => undefined;
  bus.subscribe('b1', {
    enqueueTerminal(): void {
      offSecond();
    },
    enqueueOptional(): void {
      throw new Error('unexpected optional frame');
    },
  });
  offSecond = bus.subscribe('b1', {
    enqueueTerminal(frame: TerminalFrame): void {
      terminals.push(decoder.decode(frame.bytes));
    },
    enqueueOptional(): void {
      throw new Error('unexpected optional frame');
    },
  });

  bus.broadcastTerminal('b1', terminal('hello'));

  expect(terminals).toEqual(['hello']);
});

test('broadcastOptional reaches every subscriber', () => {
  const s = makeSink();
  bus.subscribe('b1', s.sink);
  bus.broadcastOptional('b1', () => text('partial'));
  expect(s.optionals).toEqual(['partial']);
});

test('broadcastOptional snapshots subscribers before delivery', () => {
  const optionals: string[] = [];
  let offSecond: () => void = () => undefined;
  bus.subscribe('b1', {
    enqueueTerminal(): void {
      throw new Error('unexpected terminal frame');
    },
    enqueueOptional(): void {
      offSecond();
    },
  });
  offSecond = bus.subscribe('b1', {
    enqueueTerminal(): void {
      throw new Error('unexpected terminal frame');
    },
    enqueueOptional(makeFrame: () => Uint8Array): void {
      optionals.push(decoder.decode(makeFrame()));
    },
  });

  bus.broadcastOptional('b1', () => text('partial'));

  expect(optionals).toEqual(['partial']);
});

test('unsubscribe stops delivery', () => {
  const s = makeSink();
  const off = bus.subscribe('b1', s.sink);
  off();
  bus.broadcastTerminal('b1', terminal('x'));
  expect(s.terminals).toEqual([]);
});

test('zero subscribers drops frame silently', () => {
  bus.broadcastTerminal('nobody', terminal('void'));
  bus.broadcastOptional('nobody', () => text('void'));
});

test('late subscribers receive buffered terminal frames', () => {
  bus.broadcastTerminal('b1', terminal('batch-frame'));
  bus.broadcastTerminal('b1', terminal('done-frame'));
  const s = makeSink();

  bus.subscribe('b1', s.sink);

  expect(s.terminals).toEqual(['batch-frame', 'done-frame']);
});

test('subscribe replay enqueue errors do not retain the sink', () => {
  bus.broadcastTerminal('b1', terminal('batch-frame'));

  expect(() => {
    bus.subscribe('b1', {
      enqueueTerminal(): void {
        throw new Error('closed replay');
      },
      enqueueOptional(): void {
        throw new Error('unexpected optional frame');
      },
    });
  }).toThrow('closed replay');

  const s = makeSink();
  bus.subscribe('b1', s.sink, { replayBuffered: false });
  bus.broadcastTerminal('b1', terminal('after-throw'));
  expect(s.terminals).toEqual(['after-throw']);
});

test('closeBatch detaches every subscriber', () => {
  const s = makeSink();
  bus.subscribe('b1', s.sink);
  bus.closeBatch('b1');
  bus.broadcastTerminal('b1', terminal('after-close'));
  expect(s.terminals).toEqual([]);
});

test('closeBatch closes later subscribers and detaches buffers even when one close throws', () => {
  let laterClosed = false;
  bus.broadcastTerminal('b1', terminal('before-close'));
  bus.subscribe('b1', {
    enqueueTerminal(): void {
      return undefined;
    },
    enqueueOptional(): void {
      return undefined;
    },
    close(): void {
      throw new Error('close failed');
    },
  });
  bus.subscribe('b1', {
    enqueueTerminal(): void {
      return undefined;
    },
    enqueueOptional(): void {
      return undefined;
    },
    close(): void {
      laterClosed = true;
    },
  });

  bus.closeBatch('b1');
  const late = makeSink();
  bus.subscribe('b1', late.sink);

  expect(laterClosed).toBe(true);
  expect(late.terminals).toEqual([]);
});
