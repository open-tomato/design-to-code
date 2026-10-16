/**
 * Where the visual regression suite (`harness/.storybook/test-runner.ts`)
 * keeps its images: the baseline snapshots and the diffs of failed
 * comparisons, both under the active project's `baselineDir`.
 *
 * With no `D2C_PROJECT` the suite screenshots only the harness fixtures, so
 * they get a baseline directory of their own, {@link HARNESS_BASELINE_DIR}.
 * Its name holds an underscore, which a slug cannot, so it never collides
 * with the default `baselines/<slug>` of a project.
 *
 * @packageDocumentation
 */

import type { LoadOptions } from '../config/load';

import { resolve } from 'node:path';

import { REPO_ROOT } from '../config/load';

import { resolveHarnessProject } from './project';

/** The baseline directory, relative to the repo root, with no project. */
export const HARNESS_BASELINE_DIR = 'baselines/_harness';

/** The directory, under a baseline directory, holding the baseline images. */
export const SNAPSHOTS_SUBDIR = '__image_snapshots__';

/** The directory, under a baseline directory, holding the failure diffs. */
export const DIFFS_SUBDIR = '__diff_output__';

/** The absolute directories the visual suite reads and writes. */
export interface VisualDirs {
  /** The baseline images each screenshot is compared with. */
  readonly snapshotsDir: string;
  /** The diff images written for each failed comparison. */
  readonly diffDir: string;
}

/**
 * Resolves the visual suite's directories for the active project.
 *
 * The project's config is loaded through {@link resolveHarnessProject}, so
 * a broken config fails the suite rather than writing its baselines to the
 * harness's directory.
 *
 * @param options - The environment and root to read from, as for
 *   {@link resolveHarnessProject}.
 * @returns The snapshot and diff directories, as absolute paths.
 */
export function resolveVisualDirs(options: LoadOptions = {}): VisualDirs {
  const { rootDir = REPO_ROOT } = options;
  const { config } = resolveHarnessProject(options);
  const baselineDir = resolve(rootDir, config?.baselineDir ?? HARNESS_BASELINE_DIR);

  return {
    snapshotsDir: resolve(baselineDir, SNAPSHOTS_SUBDIR),
    diffDir: resolve(baselineDir, DIFFS_SUBDIR),
  };
}
