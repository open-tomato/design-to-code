import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { AssessRefusedError } from './errors.ts';
import {
  comparePaths,
  DISCOVERY_FILE,
  SEED_MANIFEST_FILE,
  SEED_REJECTED_FILE,
  SERVE_CHECK_FILE,
  SERVE_FILE,
  walkSourceDir,
  WALK_SKIPPED,
} from './walk.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

let sourceDir: string;

/** Writes `content` at a POSIX path under the temporary source dir. */
function place(relativePath: string, content = ''): void {
  const filePath = join(sourceDir, ...relativePath.split('/'));

  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-assess-walk-test-'));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
});

describe('walkSourceDir', () => {
  test('lists every file of the nested fixture, pages two levels down', () => {
    expect(walkSourceDir(join(FIXTURES_DIR, 'nested'))).toEqual([
      'screens/app/dashboard.html',
      'screens/marketing/home.html',
      'shared/base.css',
      'shared/img/hero.svg',
    ]);
  });

  test('lists every file of the with-ds fixture, sorted by path', () => {
    expect(walkSourceDir(join(FIXTURES_DIR, 'with-ds'))).toEqual([
      '_ds/ds_fixture_a/_adherence.oxlintrc.json',
      '_ds/ds_fixture_a/_ds_manifest.json',
      'landing-v2.dc.html',
      'landing.dc.html',
      'support.js',
      'system/theme.css',
      'system/tokens.ts',
      'system/variants.ts',
    ]);
  });

  test('skips the top-level .import/ directory and discovery.json', () => {
    place('index.html');
    place('.import/record.json', '{}');
    place(DISCOVERY_FILE, '{}');

    expect(walkSourceDir(sourceDir)).toEqual(['index.html']);
  });

  test('keeps the same names deeper in the tree, where the export owns them', () => {
    place('index.html');
    place('pages/.import/record.json', '{}');
    place(`pages/${DISCOVERY_FILE}`, '{}');

    expect(walkSourceDir(sourceDir)).toEqual([
      'index.html',
      'pages/.import/record.json',
      `pages/${DISCOVERY_FILE}`,
    ]);
  });

  test.each([SERVE_FILE, SERVE_CHECK_FILE, SEED_MANIFEST_FILE, SEED_REJECTED_FILE])('skips a top-level %s', (name) => {
    place('index.html');
    place(name, '{}');

    expect(walkSourceDir(sourceDir)).toEqual(['index.html']);
  });

  test.each([SERVE_FILE, SERVE_CHECK_FILE, SEED_MANIFEST_FILE, SEED_REJECTED_FILE])('walks a %s deeper in the tree', (name) => {
    place('index.html');
    place(`pages/${name}`, '{}');

    expect(walkSourceDir(sourceDir)).toEqual(['index.html', `pages/${name}`]);
  });

  test('names exactly the six pipeline-owned entries as skipped', () => {
    expect(WALK_SKIPPED).toEqual([
      '.import',
      'discovery.json',
      '.serve.json',
      'serve-check.json',
      'seed-manifest.json',
      'seed-rejected.json',
    ]);
  });

  test('sorts by code unit, so an upper-case name precedes a lower-case one', () => {
    place('B.html');
    place('a/z.css');
    place('a.html');

    expect(walkSourceDir(sourceDir)).toEqual(['B.html', 'a.html', 'a/z.css']);
  });

  test('gives an empty list for an empty source dir', () => {
    expect(walkSourceDir(sourceDir)).toEqual([]);
  });

  test('throws on a symlink instead of silently skipping it', () => {
    place('index.html');
    symlinkSync(join(sourceDir, 'index.html'), join(sourceDir, 'link.html'));

    expect(() => walkSourceDir(sourceDir)).toThrow('link.html: not a regular file or directory; cannot assess it');
  });

  test('refuses a nested symlink with an AssessRefusedError naming its relative path', () => {
    place('pages/index.html');
    symlinkSync(join(sourceDir, 'pages', 'index.html'), join(sourceDir, 'pages', 'link.html'));

    expect(() => walkSourceDir(sourceDir)).toThrow(AssessRefusedError);
    expect(() => walkSourceDir(sourceDir)).toThrow(expect.objectContaining({ path: 'pages/link.html' }));
  });
});

describe('comparePaths', () => {
  test('orders code unit by code unit, independent of locale', () => {
    expect(['b', 'B', 'a', '_x', 'a'].sort(comparePaths)).toEqual(['B', '_x', 'a', 'a', 'b']);
  });
});
