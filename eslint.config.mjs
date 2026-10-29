// @ts-check
import eslint from '@eslint/js';
import pluginQuery from '@tanstack/eslint-plugin-query';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const noHtmlTitleAttrRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow native title attributes on JSX host elements',
    },
    messages: {
      noHtmlTitleAttr: 'Use data-tip/data-tip-place instead of the native title attribute.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.name !== 'title') return;
        const opening = node.parent;
        const tag = opening.name;
        if (tag.type !== 'JSXIdentifier') return;
        if (!/^[a-z]/.test(tag.name)) return;
        context.report({ node, messageId: 'noHtmlTitleAttr' });
      },
    };
  },
};

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.worktrees/**',
      '**/.bun-cache/**',
      'docs/handoff/design/**',
      'docs/spikes/**',
      'docs/superpowers/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    // Zustand v5 does not shallow-compare selector results by default. Wrap
    // multi-field literal selectors in useShallow from 'zustand/react/shallow'.
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='useAtelierStore'] > ArrowFunctionExpression > ObjectExpression",
          message: "useAtelierStore selectors that return an object literal must be wrapped in useShallow from 'zustand/react/shallow' (zustand v5 does not shallow-compare by default).",
        },
        {
          selector: "CallExpression[callee.name='useAtelierStore'] > ArrowFunctionExpression > ArrayExpression",
          message: "useAtelierStore selectors that return an array literal must be wrapped in useShallow from 'zustand/react/shallow'.",
        },
      ],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    ignores: [
      'web/src/**/*.test.{ts,tsx}',
      'web/src/components/PromptManager/InlineTitle.tsx',
    ],
    plugins: {
      'atelier-tooltip': {
        rules: {
          'no-html-title-attr': noHtmlTitleAttrRule,
        },
      },
    },
    rules: {
      'atelier-tooltip/no-html-title-attr': 'error',
    },
  },
  ...pluginQuery.configs['flat/recommended'].map((cfg) => ({
    ...cfg,
    files: ['web/**/*.{ts,tsx}'],
  })),
  {
    files: ['eslint.config.mjs', '**/*.config.{js,mjs,ts}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
