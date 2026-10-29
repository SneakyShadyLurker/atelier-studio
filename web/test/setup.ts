import { transformAsync } from '@babel/core';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';
import compilerPkg from 'babel-plugin-react-compiler/package.json' with { type: 'json' };

GlobalRegistrator.register();

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
