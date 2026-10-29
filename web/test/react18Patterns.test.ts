import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const root = new URL('../src/', import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

describe('React 18 performance pattern source invariants', () => {
  test('PromptPicker defers template filtering behind the controlled query', () => {
    const text = source('components/PromptPicker/index.tsx');
    expect(text).toContain('useDeferredValue');
    expect(text).toContain('deferredQuery');
    expect(text).toContain('[data?.templates, deferredQuery]');
  });

  test('App wraps view changes in a transition and exposes pending state', () => {
    const text = source('App.tsx');
    expect(text).toContain('useTransition');
    expect(text).toContain('startViewTransition(() =>');
    expect(text).toContain("'data-view-pending'");
  });

  test('App builds one modelById map and threads it into render consumers and generation', () => {
    const text = source('App.tsx');
    expect(text).toContain('const modelById = useMemo');
    expect(text).toContain('useGenerate(modelById)');
    expect(text).toContain('modelById={modelById}');
  });
});
