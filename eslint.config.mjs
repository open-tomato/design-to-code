import { fixupPluginRules } from '@eslint/compat';
import markdown from '@eslint/markdown';
import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import jsonc from 'eslint-plugin-jsonc';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import pluginReact from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { default as reactRefresh } from 'eslint-plugin-react-refresh';
import globals from 'globals';
import * as jsoncParser from 'jsonc-eslint-parser';

import baseConfig, { importPluginConfigs } from './eslint.base.mjs';
import sharedRules from './sharedRules.mjs';

/**
 * A custom ESLint configuration for libraries that use React.
 *
 * @type {import("eslint").Linter.Config} */
export default defineConfig([
  {
    ignores: [
      // A generated copy of the privacy scanner; it is checked where it is written.
      'scripts/privacy-check.ts',
      'dist/**',
      'build/**',
      'design/**',
      'docs/**',
      'components/**',
      'pipeline/gates/fixtures/**',
      'baselines/**',
      'storybook-static/**',
      '.tmp/**',
      '.rafa/**',
      'node_modules/**',
      '**/package-lock.json',
      '**/.docs/*',
    ],
  },
  baseConfig,
  importPluginConfigs,
  {
    files: ['**/*.jsx', '**/*.tsx'],
    extends: [
      baseConfig,
      reactHooks.configs.flat.recommended,
      jsxA11y.flatConfigs.recommended,
      reactRefresh.configs.vite,
      reactRefresh.configs.recommended,
    ],
    languageOptions: {
      parser: tsParser,
      globals: {
        ...globals.serviceworker,
        ...globals.browser,
      },
    },
    plugins: {
      react: fixupPluginRules(pluginReact),
      '@stylistic': stylistic,
    },
    settings: {
      react: {
        version: 'detect',
        // version: '18.3',
      },
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import/resolver': {
        typescript: {
          project: ['./tsconfig.json'],
        },
      },

    },
    rules: {
      ...sharedRules,
      'react/display-name': 'off',
      'react/prop-types': 'off',
      'react/function-component-definition': 0,
      'react/jsx-filename-extension': [
        1,
        {
          'extensions': [
            '.tsx',
            '.ts',
          ],
        },
      ],
      'react/react-in-jsx-scope': 'off',
      'react/require-default-props': 0,
    },

  },
  {
    files: ['**/*.md'],
    plugins: {
      markdown,
    },
    extends: ['markdown/recommended'],
    rules: {
      'markdown/no-missing-label-refs': 'off',
    },
  },
  {
    files: ['**/*.json'],
    ignores: ['package-lock.json'],
    languageOptions: {
      parser: jsoncParser,
    },
    plugins: {
      jsonc,
      '@stylistic': stylistic,
    },
    rules: {
      'jsonc/indent': ['error', 2],
      '@stylistic/no-multiple-empty-lines': ['error', { 'max': 0, 'maxEOF': 0 }],
    },
  },
]);

