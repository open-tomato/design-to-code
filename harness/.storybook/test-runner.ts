/**
 * The shared Storybook harness's visual regression layer, run by
 * `scripts/test-visual.sh`: one PNG per story and theme, compared with the
 * baselines of this environment. Baselines are untracked and never cross
 * machines.
 *
 * Snapshots and diffs live under the active project's `baselineDir`, as
 * {@link resolveVisualDirs} resolves them; with no `D2C_PROJECT`, under the
 * harness's own baseline directory.
 *
 * Themes are applied the way `preview.ts` applies them: `data-theme` on the
 * document element.
 *
 * @packageDocumentation
 */

import type { TestRunnerConfig } from '@storybook/test-runner';

import { waitForPageReady } from '@storybook/test-runner';
import { toMatchImageSnapshot } from 'jest-image-snapshot';

import { resolveVisualDirs } from '../visual';

/** The themes every story is captured in, as the toolbar offers them. */
const THEMES = ['light', 'dark'] as const;

/** How long a pending async glyph may take before the capture fails. */
const PENDING_GLYPH_TIMEOUT_MS = 15_000;

/**
 * The largest share of differing pixels, in percent, a capture may show:
 * an anti-aliasing safety valve, not a tolerance.
 */
const FAILURE_THRESHOLD_PERCENT = 0.0001;

const { snapshotsDir, diffDir } = resolveVisualDirs();

// jest-image-snapshot augments the Jest matchers; expect is a Jest global
// inside the test-runner process. The shim avoids pulling Jest's global
// types into the project tsconfig.
declare const expect: {
  extend: (matchers: Record<string, unknown>) => void;
  (received: unknown): {
    toMatchImageSnapshot: (options: Record<string, unknown>) => void;
  };
};

const config: TestRunnerConfig = {
  setup() {
    expect.extend({ toMatchImageSnapshot });
  },
  async postVisit(page, context) {
    // An async-loaded glyph marks its stand-in with data-glyph-pending.
    // Wait until every pending glyph has committed before capturing either
    // theme, or the screenshot races the lazy commit. The evaluate guard
    // keeps glyph-less stories on their capture timing: waitForSelector
    // costs a frame even when nothing matches. A timeout is a real failure
    // (a chunk never loaded), so it throws.
    const hasPendingGlyphs = await page.evaluate(
      () => document.querySelector('[data-glyph-pending]') != null,
    );

    if (hasPendingGlyphs) {
      await page.waitForSelector('[data-glyph-pending]', {
        state: 'detached',
        timeout: PENDING_GLYPH_TIMEOUT_MS,
      });
    }

    for (const theme of THEMES) {
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t);
      }, theme);

      // Deterministic settle: network idle, fonts loaded, animations off.
      await waitForPageReady(page);
      await page.evaluate(() => document.fonts.ready);

      const image = await page.screenshot({ animations: 'disabled' });

      expect(image).toMatchImageSnapshot({
        customSnapshotsDir: snapshotsDir,
        customDiffDir: diffDir,
        customSnapshotIdentifier: `${context.id}--${theme}`,
        failureThreshold: FAILURE_THRESHOLD_PERCENT,
        failureThresholdType: 'percent',
      });
    }
  },
};

export default config;
