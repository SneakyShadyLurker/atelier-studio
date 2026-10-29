import { afterEach, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InfiniteStatus } from './index';

afterEach(cleanup);

test('an exhausted page exposes an explicit retry control without hiding loaded results', () => {
  const retry = mock();
  const { container } = render(
    <InfiniteStatus hasNextPage isFetchingNextPage={false} isFetchNextPageError fetchNextPage={retry} itemCount={30} endLabel="START" />,
  );
  expect(screen.getByRole('status').textContent).toBe('COULD NOT LOAD MORE');
  expect(container.querySelector('[data-error="true"]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading more' }));
  expect(retry).toHaveBeenCalledTimes(1);
});
