import { defineConfig, type Plugin } from 'vite';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';

// web/index.html carries the production meta CSP, which allows only external
// stylesheets (`style-src 'self'`) plus inline style attributes
// (`style-src-attr 'unsafe-inline'`). `vite dev` injects CSS as <style>
// elements, so the dev server alone re-allows them. The build ships the
// source policy verbatim; `bun run verify:csp` asserts that.
const PROD_STYLE_SRC = "style-src 'self';";
function devInlineStyles(): Plugin {
  return {
    name: 'atelier-dev-inline-styles',
    apply: 'serve',
    transformIndexHtml(html) {
      // The e2e harness page carries no CSP at all; leave it alone.
      if (!html.includes('Content-Security-Policy')) return html;
      if (!html.includes(PROD_STYLE_SRC)) {
        throw new Error(`atelier-dev-inline-styles: meta CSP no longer contains "${PROD_STYLE_SRC}"`);
      }
      return html.replace(PROD_STYLE_SRC, "style-src 'self' 'unsafe-inline';");
    },
  };
}

// In dev (`bun run dev`), the SPA loads from Vite's server on :5173 and
// any `/api/*` request is proxied to atelier-api on :8787. In production,
// SWAG terminates TLS and routes both `/` and `/api/*` to the same origin,
// so the SPA only needs a relative `/api` base — no proxy required there.
//
// The dev proxy key is hardcoded `/api`. The SPA's runtime API base defaults
// to `/api` via `import.meta.env`; no env-driven override exists in this file.
export default defineConfig(({ mode }) => ({
  // React Compiler (stable Babel path, default `infer` mode) memoizes
  // components and hooks; `test/setup.ts` applies the same compiler to unit tests.
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), devInlineStyles()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: false,
        secure: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: mode !== 'production',
    target: 'es2022',
    // Every engine the client supports implements <link rel=modulepreload>;
    // one that does not merely skips preloading.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      output: {
        // Rolldown owns vendor grouping through its codeSplitting API.
        codeSplitting: {
          // Order matters: persist FIRST so react-query-persist-client/idb-keyval
          // win over the broader data group. Then react (react/react-dom) and
          // data (@tanstack/zustand) split so a React-only change doesn't bust
          // the data chunk hash and vice versa. Membership is Rolldown-determined
          // — confirmed via a real `vite build`.
          groups: [
            { name: 'persist', test: /[\\/]node_modules[\\/](@tanstack[\\/]react-query-persist-client|idb-keyval)[\\/]/ },
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/ },
            { name: 'data', test: /[\\/]node_modules[\\/](@tanstack|zustand)[\\/]/ },
          ],
        },
      },
    },
  },
}));
