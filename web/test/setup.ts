import { transformAsync } from '@babel/core';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';
import compilerPkg from 'babel-plugin-react-compiler/package.json' with { type: 'json' };

GlobalRegistrator.register();

// TanStack Query delivers observer updates to React from its own deferred
// batches (a `setTimeout(0)` each), outside any act scope a test holds. A fixed
// number of awaited ticks cannot reliably catch them on a loaded runner, so
// deliver every batch inside act, the way React would flush it in a browser.
// Only while the act environment is on: Testing Library turns it on for the
// tests of files that import it, and act outside it only trades one warning
// for another.
const { act } = await import('react');
const { notifyManager } = await import('@tanstack/react-query');
notifyManager.setBatchNotifyFunction((callback) => {
  if ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT === true) act(callback);
  else callback();
});

// Production code runs through React Compiler (vite.config.ts), but `bun test`
// does not run Vite plugins. Compile web/src the same way so unit tests exercise
// the memoization the app actually ships. Test files and dependencies load as-is.
// Output is cached by source hash because `--isolate` reloads every module per file.
const CACHE_DIR = `${import.meta.dir}/../node_modules/.cache/react-compiler-test`;
plugin({
  name: 'react-compiler',
  setup(build) {
    build.onLoad({ filter: /\/web\/src\/(?!.*\.test\.tsx?$).*\.tsx?$/ }, async ({ path }) => {
      const tsx = path.endsWith('x');
      const loader = tsx ? 'tsx' : 'ts';
      const source = await Bun.file(path).text();
      const cached = Bun.file(`${CACHE_DIR}/${Bun.hash(compilerPkg.version + path + source).toString(36)}.${loader}`);
      if (await cached.exists()) return { contents: await cached.text(), loader };
      const result = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: tsx ? ['typescript', 'jsx'] : ['typescript'] },
        plugins: ['babel-plugin-react-compiler'],
      });
      const contents = result?.code ?? '';
      await Bun.write(cached, contents);
      return { contents, loader };
    });
  },
});
