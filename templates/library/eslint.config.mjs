/**
 * The library's ESLint config. It lints every file of the library with the
 * root config's rules and its sources, `src/**\/*.{ts,tsx}`, with two more
 * kinds of rule, each as an error:
 *
 * - `cva-only-classname`: a component's `className` comes from its `cva`
 *   variants, merged with the passthrough `className` prop through `cn`;
 * - every rule of `eslint-plugin-react-hooks`' recommended set, the ones
 *   the root config only warns on included.
 *
 * Every extraction copies this file to `<target.dir>` (by default
 * `components/<slug>/`, two folders below the tool root, as this template
 * is), so the root config and the rule are imported by paths relative to
 * this file. The build-and-lint gate lints a library through this config,
 * never through the root one, which ignores `components/**`.
 *
 * ESLint takes the config nearest each file, so the root `bun run lint`
 * lints `templates/library/` through this config too. The root config
 * therefore applies to every file here, not just to the sources: scoped to
 * `src/**` alone, it would leave this file, `package.json` and
 * `tsconfig.json` unlinted.
 *
 * Plain ESM JavaScript, so ESLint loads it under plain Node.
 *
 * @packageDocumentation
 */
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';

import rootConfig from '../../eslint.config.mjs';
import { CVA_ONLY_CLASSNAME_RULE, cvaOnlyClassname } from '../../pipeline/gates/build-lint/cva-only-classname.mjs';

/** The namespace the library's own rules are registered under. */
const PLUGIN_NAME = 'd2c';

/** The library sources the config lints, relative to the library folder. */
export const LIBRARY_SOURCE_FILES = ['src/**/*.{ts,tsx}'];

/**
 * The full ids of the rules this config raises to errors: `cva-only-classname`
 * under the {@link PLUGIN_NAME} namespace, then the `react-hooks`
 * recommended set.
 *
 * @type {readonly string[]}
 */
export const LIBRARY_ERROR_RULES = [
  `${PLUGIN_NAME}/${CVA_ONLY_CLASSNAME_RULE}`,
  ...Object.keys(reactHooks.configs.flat.recommended.rules ?? {}),
];

/**
 * The library's config: the root config, then, for
 * {@link LIBRARY_SOURCE_FILES}, the root config again with every rule in
 * {@link LIBRARY_ERROR_RULES} set to `error`.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default defineConfig([
  rootConfig,
  {
    files: LIBRARY_SOURCE_FILES,
    extends: [rootConfig],
    plugins: {
      [PLUGIN_NAME]: { rules: { [CVA_ONLY_CLASSNAME_RULE]: cvaOnlyClassname } },
      'react-hooks': reactHooks,
    },
    rules: Object.fromEntries(LIBRARY_ERROR_RULES.map((rule) => [rule, 'error'])),
  },
]);
