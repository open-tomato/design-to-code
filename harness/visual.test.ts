import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ProjectConfigError, REPO_ROOT } from '../config/load';
import { SLUG_PATTERN } from '../config/schema';

import {
  DIFFS_SUBDIR,
  HARNESS_BASELINE_DIR,
  resolveVisualDirs,
  SNAPSHOTS_SUBDIR,
} from './visual';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

let rootDir: string;

/** Writes `projects/<slug>.json` and creates its `source.dir`. */
function writeProject(content: Record<string, unknown> = {}): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  mkdirSync(join(rootDir, 'design', SLUG), { recursive: true });
  writeFileSync(
    join(rootDir, 'projects', `${SLUG}.json`),
    JSON.stringify({ slug: SLUG, source: { dir: `design/${SLUG}` }, ...content }),
  );
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-harness-visual-test-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('resolveVisualDirs without a project', () => {
  test('uses the harness baseline directory', () => {
    const dirs = resolveVisualDirs({ env: {}, rootDir });

    expect(dirs).toStrictEqual({
      snapshotsDir: join(rootDir, HARNESS_BASELINE_DIR, SNAPSHOTS_SUBDIR),
      diffDir: join(rootDir, HARNESS_BASELINE_DIR, DIFFS_SUBDIR),
    });
  });

  test('resolves against the repo root by default', () => {
    const dirs = resolveVisualDirs({ env: {} });

    expect(dirs.snapshotsDir).toBe(join(REPO_ROOT, HARNESS_BASELINE_DIR, SNAPSHOTS_SUBDIR));
  });

  test('names a harness directory no slug can collide with', () => {
    const [, name] = HARNESS_BASELINE_DIR.split('/');

    expect(name).toBeDefined();
    expect(SLUG_PATTERN.test(name ?? '')).toBe(false);
  });
});

describe('resolveVisualDirs with a project', () => {
  test('uses the default baselines/<slug>', () => {
    writeProject();

    const dirs = resolveVisualDirs({ env: ENV, rootDir });

    expect(dirs).toStrictEqual({
      snapshotsDir: join(rootDir, 'baselines', SLUG, SNAPSHOTS_SUBDIR),
      diffDir: join(rootDir, 'baselines', SLUG, DIFFS_SUBDIR),
    });
  });

  test('follows a baselineDir set in the config', () => {
    writeProject({ baselineDir: 'shots/web' });

    const dirs = resolveVisualDirs({ env: ENV, rootDir });

    expect(dirs.snapshotsDir).toBe(join(rootDir, 'shots', 'web', SNAPSHOTS_SUBDIR));
    expect(dirs.diffDir).toBe(join(rootDir, 'shots', 'web', DIFFS_SUBDIR));
  });

  test('fails on a config the loader refuses, naming the field', () => {
    writeProject({ baselineDir: '' });

    expect(() => resolveVisualDirs({ env: ENV, rootDir })).toThrow(ProjectConfigError);
    expect(() => resolveVisualDirs({ env: ENV, rootDir })).toThrow('baselineDir');
  });
});
