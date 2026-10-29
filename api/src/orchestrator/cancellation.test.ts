import { describe, expect, test } from 'bun:test';
import { UserCanceledError, isUserCanceled } from './cancellation';

describe('UserCanceledError', () => {
  test('is an Error sentinel with the user-cancel message and name', () => {
    const error = new UserCanceledError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UserCanceledError');
    expect(error.message).toBe('canceled by user');
  });

  test('narrows only real UserCanceledError instances', () => {
    expect(isUserCanceled(new UserCanceledError())).toBe(true);
    expect(isUserCanceled(new Error('canceled by user'))).toBe(false);
    expect(isUserCanceled(null)).toBe(false);
    expect(isUserCanceled(undefined)).toBe(false);
    expect(isUserCanceled({ name: 'UserCanceledError' })).toBe(false);
  });
});
