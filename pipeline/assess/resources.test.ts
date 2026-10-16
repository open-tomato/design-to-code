import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { discoverPages } from './pages.ts';
import {
  assetGroupOf,
  countCustomProperties,
  discoverKnownFiles,
  discoverTokens,
  discoverVariantMaps,
  groupAssets,
} from './resources.ts';
import { KNOWN_FILE_NAMES, scriptReportSchema } from './schema.ts';
import { comparePaths, walkSourceDir } from './walk.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

const FIXTURES = ['with-ds', 'without-ds', 'nested'] as const;

function fixtureDir(name: (typeof FIXTURES)[number]): string {
  return join(FIXTURES_DIR, name);
}

function knownFilesOf(name: (typeof FIXTURES)[number]) {
  return discoverKnownFiles(walkSourceDir(fixtureDir(name)));
}

function statusOf(name: (typeof FIXTURES)[number], knownFile: string) {
  return knownFilesOf(name).find((file) => file.name === knownFile);
}

describe('discoverKnownFiles', () => {
  test('marks both _ds/ files found in with-ds, at their paths', () => {
    expect(statusOf('with-ds', '_ds_manifest.json')).toEqual({
      name: '_ds_manifest.json',
      status: 'found',
      paths: ['_ds/ds_fixture_a/_ds_manifest.json'],
    });
    expect(statusOf('with-ds', '_adherence.oxlintrc.json')).toEqual({
      name: '_adherence.oxlintrc.json',
      status: 'found',
      paths: ['_ds/ds_fixture_a/_adherence.oxlintrc.json'],
    });
  });

  test('marks both _ds/ files absent in without-ds, with no paths', () => {
    expect(statusOf('without-ds', '_ds_manifest.json')).toEqual({
      name: '_ds_manifest.json',
      status: 'absent',
      paths: [],
    });
    expect(statusOf('without-ds', '_adherence.oxlintrc.json')).toEqual({
      name: '_adherence.oxlintrc.json',
      status: 'absent',
      paths: [],
    });
  });

  test('marks every known file found in with-ds and every one absent in without-ds', () => {
    expect(knownFilesOf('with-ds').map((file) => file.status)).toEqual(KNOWN_FILE_NAMES.map(() => 'found'));
    expect(knownFilesOf('without-ds').map((file) => file.status)).toEqual(KNOWN_FILE_NAMES.map(() => 'absent'));
  });

  test('lists every known name once, in KNOWN_FILE_NAMES order, even for no files', () => {
    expect(discoverKnownFiles([]).map((file) => file.name)).toEqual([...KNOWN_FILE_NAMES]);
  });

  test('collects every depth a name occurs at, sorted by path', () => {
    const files = discoverKnownFiles(['z/support.js', 'support.js', 'a/b/support.js']);

    expect(files.find((file) => file.name === 'support.js')?.paths).toEqual([
      'a/b/support.js',
      'support.js',
      'z/support.js',
    ]);
  });

  test('matches the exact file name only, not a prefix, suffix or other case', () => {
    const files = discoverKnownFiles(['old_support.js', 'support.js.map', 'Support.js', 'tokens.tsx']);

    expect(files.every((file) => file.status === 'absent')).toBe(true);
  });
});

describe('discoverTokens', () => {
  test('finds tokens.ts by name and the CSS declaring custom properties in with-ds', () => {
    expect(discoverTokens(fixtureDir('with-ds'), walkSourceDir(fixtureDir('with-ds')))).toEqual([
      { path: 'system/theme.css', customPropertyCount: 5 },
      { path: 'system/tokens.ts', customPropertyCount: 0 },
    ]);
  });

  test('leaves out a CSS file that only reads custom properties through var()', () => {
    expect(discoverTokens(fixtureDir('without-ds'), walkSourceDir(fixtureDir('without-ds')))).toEqual([
      { path: 'palette.css', customPropertyCount: 2 },
    ]);
  });

  test('finds a declaring CSS file two levels down in nested', () => {
    expect(discoverTokens(fixtureDir('nested'), walkSourceDir(fixtureDir('nested')))).toEqual([
      { path: 'shared/base.css', customPropertyCount: 1 },
    ]);
  });

  describe('over a temporary source dir', () => {
    let sourceDir: string;

    function place(relativePath: string, content: string): void {
      const filePath = join(sourceDir, ...relativePath.split('/'));

      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content);
    }

    beforeEach(() => {
      sourceDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-assess-resources-test-'));
    });

    afterEach(() => {
      rmSync(sourceDir, { recursive: true, force: true });
    });

    test('lists a tokens.css once, with its count, and any tokens.* by name', () => {
      place('tokens.css', ':root { --a: 1; }');
      place('design/Tokens.json', '{}');
      place('empty.css', 'body { margin: 0; }');

      expect(discoverTokens(sourceDir, walkSourceDir(sourceDir))).toEqual([
        { path: 'design/Tokens.json', customPropertyCount: 0 },
        { path: 'tokens.css', customPropertyCount: 1 },
      ]);
    });

    test('reads an upper-case .CSS extension as CSS', () => {
      place('THEME.CSS', ':root { --a: 1; --b: 2; }');

      expect(discoverTokens(sourceDir, ['THEME.CSS'])).toEqual([{ path: 'THEME.CSS', customPropertyCount: 2 }]);
    });
  });
});

describe('countCustomProperties', () => {
  test('counts each declared name once, however often it is redeclared', () => {
    expect(countCustomProperties(':root { --a: 1; --b: 2; } [data-theme=dark] { --a: 3; }')).toBe(2);
  });

  test('counts declarations with no space, space before the colon, or at the start', () => {
    expect(countCustomProperties('--top:0;a{--x:1}b{ --y : 2 ;}')).toBe(3);
  });

  test('does not count var() references, BEM selectors or custom media', () => {
    const css = [
      '.card--large:hover { color: var(--ink); }',
      '@media (--narrow: 600px) { a { margin: var(--gap, 4px); } }',
    ].join('\n');

    expect(countCustomProperties(css)).toBe(0);
  });

  test('does not count a declaration inside a comment or a string', () => {
    const css = '/* :root { --commented: 1; } */ a::before { content: "; --quoted: 1"; } b { --real: 1; }';

    expect(countCustomProperties(css)).toBe(1);
  });

  test('counts non-ASCII and underscored names', () => {
    expect(countCustomProperties(':root { --couleur-é: red; --space_2: 8px; }')).toBe(2);
  });
});

describe('discoverVariantMaps', () => {
  test('finds variants.ts in with-ds and none in the other fixtures', () => {
    expect(discoverVariantMaps(walkSourceDir(fixtureDir('with-ds')))).toEqual([{ path: 'system/variants.ts' }]);
    expect(discoverVariantMaps(walkSourceDir(fixtureDir('without-ds')))).toEqual([]);
    expect(discoverVariantMaps(walkSourceDir(fixtureDir('nested')))).toEqual([]);
  });

  test('matches variants.* by name at any depth and in any case, sorted', () => {
    const paths = ['z/variants.json', 'Variants.ts', 'button-variants.ts', 'variantsx.ts'];

    expect(discoverVariantMaps(paths)).toEqual([{ path: 'Variants.ts' }, { path: 'z/variants.json' }]);
  });
});

describe('groupAssets', () => {
  test('groups every with-ds file by kind, pages and JSON under other', () => {
    expect(groupAssets(walkSourceDir(fixtureDir('with-ds')))).toEqual({
      images: [],
      fonts: [],
      styles: ['system/theme.css'],
      scripts: ['support.js', 'system/tokens.ts', 'system/variants.ts'],
      other: [
        '_ds/ds_fixture_a/_adherence.oxlintrc.json',
        '_ds/ds_fixture_a/_ds_manifest.json',
        'landing-v2.dc.html',
        'landing.dc.html',
      ],
    });
  });

  test('puts the nested fixture\'s image in images', () => {
    expect(groupAssets(walkSourceDir(fixtureDir('nested'))).images).toEqual(['shared/img/hero.svg']);
  });

  test('places every path in exactly one group', () => {
    const paths = walkSourceDir(fixtureDir('without-ds'));
    const assets = groupAssets(paths);
    const grouped = Object.values(assets).flat();

    expect([...grouped].sort(comparePaths)).toEqual(paths);
  });

  test('reads extensions without regard to case and sorts each group', () => {
    expect(groupAssets(['b/Logo.PNG', 'a.woff2', 'a/logo.png', 'README', '.env', 'x.scss'])).toEqual({
      images: ['a/logo.png', 'b/Logo.PNG'],
      fonts: ['a.woff2'],
      styles: ['x.scss'],
      scripts: [],
      other: ['.env', 'README'],
    });
  });

  test('uses the last extension only', () => {
    expect(assetGroupOf('bundle.min.js')).toBe('scripts');
    expect(assetGroupOf('photo.png.txt')).toBe('other');
  });
});

describe('resource discovery against the schema', () => {
  test.each(FIXTURES)('gives %s a script report the schema accepts', (name) => {
    const dir = fixtureDir(name);
    const paths = walkSourceDir(dir);
    const report = {
      generatedAt: '2026-01-01T00:00:00Z',
      pages: discoverPages(dir, paths),
      tokens: discoverTokens(dir, paths),
      variantMaps: discoverVariantMaps(paths),
      assets: groupAssets(paths),
      knownFiles: discoverKnownFiles(paths),
    };

    expect(scriptReportSchema.safeParse(report).success).toBe(true);
  });

  test('returns sorted output from unsorted input, as the schema demands', () => {
    const paths = ['z/tokens.ts', 'a/tokens.ts'];
    const report = {
      generatedAt: '2026-01-01T00:00:00Z',
      pages: [],
      tokens: discoverTokens('/unused', paths),
      variantMaps: discoverVariantMaps(['z/variants.ts', 'a/variants.ts']),
      assets: groupAssets(paths),
      knownFiles: discoverKnownFiles(['z/tokens.ts', 'a/tokens.ts']),
    };

    expect(scriptReportSchema.safeParse(report).success).toBe(true);
  });
});
