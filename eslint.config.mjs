import baseConfig from '@open-tomato/eslint-config';
import reactConfig from '@open-tomato/eslint-config/react';
import viteConfig from '@open-tomato/eslint-config/vite';

/**
 * ESLint flat config: the shared open-tomato base with its React and Vite
 * flavors, plus what is this tool's own.
 *
 * `templates/library/eslint.config.mjs` imports this config and lays its
 * library rules over it, so every extracted library is linted with these
 * rules too.
 *
 * @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: [
      // A generated copy of the privacy scanner; it is checked where it is written.
      'scripts/privacy-check.ts',
      'design/**',
      'docs/**',
      'components/**',
      'pipeline/gates/fixtures/**',
      'baselines/**',
      'storybook-static/**',
    ],
  },
  ...baseConfig,
  ...reactConfig,
  ...viteConfig,
  {
    // The node-side tool runs no React. Its Playwright helpers take a
    // callback named `use`, which the hooks rules read as React's `use()`.
    files: ['{bin,config,pipeline,scripts}/**/*.{js,mjs,ts,mts}'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
];
