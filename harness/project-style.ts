/**
 * A Vite plugin that serves the active project's style entry to the
 * harness preview as a virtual module.
 *
 * The preview runs in the browser and cannot read the project config, so
 * it imports {@link PROJECT_STYLE_MODULE} instead of a path, and this
 * plugin, added by `harness/.storybook/main.ts`, answers that import with
 * the style entry resolved there — or with nothing when there is none.
 *
 * @packageDocumentation
 */

import type { Plugin } from 'vite';

/** The specifier `harness/.storybook/preview.ts` imports the style from. */
export const PROJECT_STYLE_MODULE = 'virtual:d2c-project-style';

// The `\0` prefix is Vite's convention for a resolved virtual module: it
// keeps other plugins from treating the id as a file path.
const RESOLVED_PROJECT_STYLE_MODULE = `\0${PROJECT_STYLE_MODULE}`;

/**
 * Builds the source of the virtual style module.
 *
 * @param styleEntry - The absolute path of the style entry, if any.
 * @returns A side-effect import of the style entry, or an empty module.
 */
export function projectStyleSource(styleEntry: string | undefined): string {
  return styleEntry === undefined
    ? ''
    : `import ${JSON.stringify(styleEntry)};\n`;
}

/**
 * Creates the plugin serving {@link PROJECT_STYLE_MODULE}.
 *
 * @param styleEntry - The absolute path of the project's style entry, or
 *   `undefined` to serve an empty module.
 * @returns The Vite plugin.
 */
export function projectStylePlugin(styleEntry: string | undefined): Plugin {
  return {
    name: 'd2c-project-style',
    resolveId(id) {
      return id === PROJECT_STYLE_MODULE
        ? RESOLVED_PROJECT_STYLE_MODULE
        : undefined;
    },
    load(id) {
      return id === RESOLVED_PROJECT_STYLE_MODULE
        ? projectStyleSource(styleEntry)
        : undefined;
    },
  };
}
