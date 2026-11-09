import { transformAsync } from '@babel/core';
import { describe, expect, test } from 'bun:test';

/*
 * Production code runs through React Compiler (vite.config.ts). The compiler
 * skips a whole component or hook when it meets a construct it cannot lower
 * (a `finally` clause, `??=`), silently: the app still works, only without
 * memoization. The feed root re-renders on every history write and every
 * composer keystroke, so a bail-out there costs the most. This test runs the
 * compiler with its logger over the feed's hot files and fails on any bail-out,
 * so the next `finally` added to App or Composer is caught at once.
 */
const HOT_FILES = [
  'src/App.tsx',
  'src/components/Composer/index.tsx',
  'src/components/Batch/index.tsx',
  'src/components/Batch/BatchPrompt.tsx',
  'src/components/Batch/RelativeTime.tsx',
  'src/components/tile/ImageTile/index.tsx',
  'src/components/tile/LoadingTile/body.tsx',
  'src/components/tile/TilePlaceholder/index.tsx',
  'src/components/tile/FailedTile/index.tsx',
  'src/components/tile/ClipFrame/index.tsx',
  'src/components/InfiniteStatus/index.tsx',
  'src/components/Lightbox/index.tsx',
  'src/components/Lightbox/Content.tsx',
  'src/components/Toast/index.tsx',
  'src/hooks/useExtendFromTile.ts',
  'src/hooks/useHistory.ts',
  'src/hooks/useHistoryRefresh.ts',
];

interface CompilerEvent { kind: string; fnName?: string | null; detail?: unknown; reason?: unknown }

async function compileEvents(relativePath: string): Promise<CompilerEvent[]> {
  const path = `${import.meta.dir}/../${relativePath}`;
  const events: CompilerEvent[] = [];
  const tsx = path.endsWith('x');
  await transformAsync(await Bun.file(path).text(), {
    filename: path,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: tsx ? ['typescript', 'jsx'] : ['typescript'] },
    plugins: [['babel-plugin-react-compiler', { logger: { logEvent: (_file: string, event: CompilerEvent) => { events.push(event); } } }]],
  });
  return events;
}

describe('React Compiler coverage of the feed', () => {
  for (const file of HOT_FILES) {
    test(`${file} compiles without a bail-out`, async () => {
      const events = await compileEvents(file);
      const failures = events
        .filter((event) => event.kind === 'CompileError' || event.kind === 'PipelineError')
        .map((event) => `${event.fnName ?? '<anonymous>'}: ${JSON.stringify(event.detail ?? event.reason ?? event)}`);
      expect(failures).toEqual([]);
      expect(events.some((event) => event.kind === 'CompileSuccess')).toBe(true);
    });
  }
});
