import { expect, test } from 'bun:test';
import { runAllPostCommit } from './_postCommit';

test('runAllPostCommit runs every step in order and rethrows the first failure', () => {
  const ran: string[] = [];
  const first = new Error('first');
  const run = () => {
    runAllPostCommit([
      () => { ran.push('a'); },
      () => { ran.push('b'); throw first; },
      () => { ran.push('c'); throw new Error('second'); },
      () => { ran.push('d'); },
    ]);
  };
  expect(run).toThrow(first);
  expect(ran).toEqual(['a', 'b', 'c', 'd']);
});

test('runAllPostCommit returns normally when no step throws', () => {
  const ran: string[] = [];
  runAllPostCommit([() => { ran.push('a'); }, () => { ran.push('b'); }]);
  expect(ran).toEqual(['a', 'b']);
});
