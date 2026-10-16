/**
 * The shared Storybook harness's main config, generic over the project
 * config: the stories and the style entry come from the active project
 * (`D2C_PROJECT`) through {@link resolveHarnessProject}.
 *
 * With no project the harness loads only `harness/fixtures/`; a project
 * whose `target.dir` does not exist yet adds nothing to it.
 *
 * Its Vite config is the root `vite.config.ts`, named explicitly: the Vite
 * builder otherwise looks for one in this directory's parent, `harness/`.
 *
 * @packageDocumentation
 */

import type { StorybookConfig } from '@storybook/react-vite';

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from '../../config/load.ts';
import { projectStylePlugin } from '../project-style.ts';
import { resolveHarnessProject } from '../project.ts';

const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));

/** The harness's Vite config, shared with the `storybook` Vitest project. */
const VITE_CONFIG_PATH = join(REPO_ROOT, 'vite.config.ts');

const project = resolveHarnessProject();

const config: StorybookConfig = {
  // Relative to this directory: the addon-vitest plugin joins a story
  // directory to the config directory, which breaks an absolute one.
  stories: project.stories.map((specifier) => ({
    ...specifier,
    directory: relative(CONFIG_DIR, specifier.directory),
  })),
  addons: ['@storybook/addon-vitest'],
  framework: {
    name: '@storybook/react-vite',
    options: {
      builder: { viteConfigPath: VITE_CONFIG_PATH },
    },
  },
  typescript: {
    reactDocgen: 'react-docgen-typescript',
  },
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    plugins: [...(viteConfig.plugins ?? []), projectStylePlugin(project.styleEntry)],
  }),
};

export default config;
