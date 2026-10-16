import { fixupConfigRules } from '@eslint/compat';
import eslint from '@eslint/js';
import markdown from '@eslint/markdown';
import stylistic from '@stylistic/eslint-plugin';
import * as tsParser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import importPlugin from 'eslint-plugin-import';
import jsonc from 'eslint-plugin-jsonc';
import globals from 'globals';
import * as jsoncParser from 'jsonc-eslint-parser';
import { configs as tsLintConfig } from 'typescript-eslint';

import sharedRules from './sharedRules.mjs';

/**
 * The JavaScript and TypeScript files the import plugin may lint.
 *
 * ESLint 10 removed the context and source-code methods the plugin still
 * calls, so its rules run through `@eslint/compat`. That wrapper binds
 * JavaScript-only source-code methods, which a Markdown file's source code
 * lacks, so the plugin's configs must not reach `.md` files.
 */
const IMPORT_PLUGIN_FILES = ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'];

/**
 * The import plugin's recommended and TypeScript configs, made to run on
 * ESLint 10 and scoped to {@link IMPORT_PLUGIN_FILES}.
 *
 * @type {import("eslint").Linter.Config[]} */
export const importPluginConfigs = fixupConfigRules([
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
]).map((config) => ({ ...config, files: IMPORT_PLUGIN_FILES }));

/**
 * A custom ESLint configuration for typescript
 *
 * @type {import("eslint").Linter.Config} */
export default defineConfig([
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      '**/package-lock.json',
      '**/.docs/*',
    ],
  },
  importPluginConfigs,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tsLintConfig.recommended,
    ],
    plugins: {
      '@stylistic': stylistic,
    },
    languageOptions: {
      globals: {
        ...globals.node,    // process, __dirname
        ...globals.browser, // fetch, console, window
        Bun: 'readonly',
        // note: Projects configs should add globals in this section of their config definition if needed, for example:
        React: 'readonly',
      },

      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        // note: Projects configs should add parserOptions in this section of their config definition if needed, for example:
        // project: './tsconfig.json',
      },
    },
    rules: {
      ...sharedRules,
    },
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.d.ts'],
      },
      'import/resolver': {
        typescript: {
          project: ['./tsconfig.json'],
        },
      },
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

