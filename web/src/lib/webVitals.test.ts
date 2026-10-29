import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Metric } from 'web-vitals';

const callbacks: ((metric: Metric) => void)[] = [];

void mock.module('web-vitals', () => ({
  onCLS: (callback: (metric: Metric) => void): void => {
    callbacks.push(callback);
  },
  onFCP: (callback: (metric: Metric) => void): void => {
    callbacks.push(callback);
  },
  onINP: (callback: (metric: Metric) => void): void => {
    callbacks.push(callback);
  },
  onLCP: (callback: (metric: Metric) => void): void => {
    callbacks.push(callback);
  },
  onTTFB: (callback: (metric: Metric) => void): void => {
    callbacks.push(callback);
  },
}));

const { startWebVitals } = await import('./webVitals');

beforeEach(() => {
  callbacks.length = 0;
  window.location.href = 'https://atelier.test/';
});

describe('startWebVitals', () => {
  test('registers all first-paint and core web vital observers', () => {
    startWebVitals();

    expect(callbacks).toHaveLength(5);
  });

  test('logs metrics only when the debug query flag is present', () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    startWebVitals();

    callbacks[0]?.({ name: 'LCP', value: 123, id: 'v1', delta: 123 } as Metric);
    expect(log).not.toHaveBeenCalled();

    window.location.href = 'https://atelier.test/?debug=vitals';
    callbacks[0]?.({ name: 'LCP', value: 456, id: 'v2', delta: 333 } as Metric);

    expect(log).toHaveBeenCalledWith('[web-vitals]', 'LCP', 456, expect.objectContaining({ id: 'v2' }));
    log.mockRestore();
  });
});
