import { join } from 'node:path';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig } from 'vitest/config';

/** The shared Storybook harness's config directory. */
const STORYBOOK_CONFIG_DIR = join(import.meta.dirname, 'harness/.storybook');

/** The tracked folders that hold node-side test files. */
const TEST_DIRS = '{bin,config,harness,pipeline,scripts,templates}';

/**
 * Every test that starts an HTTP server or launches Chromium carries this
 * suffix. The `integration` project runs these files one at a time, and the
 * `unit` project leaves them out, so each file runs in exactly one project.
 */
const INTEGRATION_TEST_GLOB = '**/*.integration.test.ts';

export default defineConfig({
  test: {
    // Under vitest 5.0.2 (the latest release) browser mode prints
    // 'Plugin "vitest:mocks:interceptor" defines Vite-specific hooks
    // (configureServer) in a plugin returned from applyToEnvironment'.
    // Upstream: vitest-dev/vitest#11276, fixed by #11377 after 5.0.2 shipped.
    // Delete this comment once an update past 5.0.2 silences the warning.
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [`${TEST_DIRS}/**/*.test.ts`],
          exclude: [...configDefaults.exclude, INTEGRATION_TEST_GLOB],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: [`${TEST_DIRS}/${INTEGRATION_TEST_GLOB}`],
          // Server and browser test files would compete for ports and CPU if
          // they ran in parallel, so they run one after another.
          fileParallelism: false,
        },
      },
      {
        extends: './vite.config.ts',
        plugins: [storybookTest({ configDir: STORYBOOK_CONFIG_DIR })],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
