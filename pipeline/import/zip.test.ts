import type { Zippable } from 'fflate';

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { extractZip, ZipError } from './zip.ts';

/** The tracked zip macOS Finder's "Compress" would make of a folder `export`. */
const FINDER_ZIP = join(import.meta.dirname, 'fixtures', 'finder-export.zip');

/** The tracked zip holding `a.html` beside `A.html`. */
const CASE_FILE_ZIP = join(import.meta.dirname, 'fixtures', 'case-collision-file.zip');

/** The tracked zip holding `Pages/a.html` beside `pages/b.html`. */
const CASE_FOLDER_ZIP = join(import.meta.dirname, 'fixtures', 'case-collision-folder.zip');

/** The Finder fixture's metadata entries, as the archive names them, sorted. */
const FINDER_DROPPED = [
  { path: '__MACOSX/', reason: 'macos-metadata' },
  { path: '__MACOSX/export/', reason: 'macos-metadata' },
  { path: '__MACOSX/export/._.DS_Store', reason: 'macos-metadata' },
  { path: '__MACOSX/export/._index.html', reason: 'macos-metadata' },
  { path: '__MACOSX/export/pages/', reason: 'macos-metadata' },
  { path: '__MACOSX/export/pages/._about.html', reason: 'macos-metadata' },
  { path: 'export/.DS_Store', reason: 'ds-store' },
];

/** The export's files, POSIX paths to contents, as both zip shapes hold them. */
const EXPORT_FILES: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html>',
  'support.js': 'console.info(1);',
  'system/tokens.ts': 'export const tokens = {};',
  'system/deep/x.css': ':root {}',
};

let workDir: string;
let targetDir: string;

/** Builds a zip from entry names to contents and returns its path. */
function buildZip(entries: Zippable): string {
  const zipPath = join(workDir, 'export.zip');

  writeFileSync(zipPath, zipSync(entries));

  return zipPath;
}

function textEntries(files: Readonly<Record<string, string>>, prefix = ''): Zippable {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [`${prefix}${path}`, strToU8(content)]));
}

/** Every file under `dir`, POSIX-relative, sorted, mapped to its contents. */
function readTree(dir: string): Record<string, string> {
  const paths = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1)
      .split('\\')
      .join('/'))
    .sort();

  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(dir, path), 'utf8')]));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-import-zip-test-'));
  targetDir = join(workDir, 'source');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('extractZip, the two zip shapes', () => {
  test('places files at the root of the archive at the same paths', () => {
    const placed = extractZip(buildZip(textEntries(EXPORT_FILES)), targetDir);

    expect(placed).toStrictEqual({ files: Object.keys(EXPORT_FILES).sort(), dropped: [] });
    expect(readTree(targetDir)).toStrictEqual(EXPORT_FILES);
  });

  test('unwraps a lone top-level folder so its files land at the same paths', () => {
    const placed = extractZip(buildZip(textEntries(EXPORT_FILES, 'my-export/')), targetDir);

    expect(placed).toStrictEqual({ files: Object.keys(EXPORT_FILES).sort(), dropped: [] });
    expect(readTree(targetDir)).toStrictEqual(EXPORT_FILES);
  });

  test('unwraps a lone folder that the archive also lists as a directory entry', () => {
    const zipPath = buildZip({ 'my-export/': new Uint8Array(0), ...textEntries(EXPORT_FILES, 'my-export/') });

    extractZip(zipPath, targetDir);

    expect(readTree(targetDir)).toStrictEqual(EXPORT_FILES);
  });

  test('unwraps only one level', () => {
    extractZip(buildZip(textEntries({ 'inner/index.html': 'page' }, 'outer/')), targetDir);

    expect(readTree(targetDir)).toStrictEqual({ 'inner/index.html': 'page' });
  });

  test('keeps a top-level folder that has a file beside it', () => {
    const files = { 'site/index.html': 'page', 'readme.txt': 'hi' };

    extractZip(buildZip(textEntries(files)), targetDir);

    expect(readTree(targetDir)).toStrictEqual(files);
  });

  test('keeps a lone file at the root in place', () => {
    extractZip(buildZip(textEntries({ 'index.html': 'page' })), targetDir);

    expect(readTree(targetDir)).toStrictEqual({ 'index.html': 'page' });
  });

  test('creates empty directories the archive lists', () => {
    extractZip(buildZip({ ...textEntries({ 'index.html': 'page' }), assets: {} }), targetDir);

    expect(readdirSync(join(targetDir, 'assets'))).toStrictEqual([]);
  });

  test('writes into an existing empty target', () => {
    mkdirSync(targetDir);

    extractZip(buildZip(textEntries(EXPORT_FILES)), targetDir);

    expect(readTree(targetDir)).toStrictEqual(EXPORT_FILES);
  });
});

describe('extractZip, Finder metadata', () => {
  test('the Finder fixture holds a top-level __MACOSX/ and a .DS_Store beside one export folder', () => {
    const names = Object.keys(unzipSync(readFileSync(FINDER_ZIP)));

    expect(names.filter((name) => name.startsWith('__MACOSX/'))).toHaveLength(6);
    expect(names).toContain('export/.DS_Store');
    expect(new Set(names.map((name) => name.split('/')[0]))).toStrictEqual(new Set(['export', '__MACOSX']));
  });

  test('drops the Finder metadata and unwraps the export folder to the root', () => {
    const result = extractZip(FINDER_ZIP, targetDir);

    expect(result).toStrictEqual({ files: ['index.html', 'pages/about.html'], dropped: FINDER_DROPPED });
    expect(readTree(targetDir)).toStrictEqual({
      'index.html': '<!doctype html>\n<h1>home</h1>\n',
      'pages/about.html': '<!doctype html>\n<h1>about</h1>\n',
    });
    expect(readdirSync(targetDir).sort()).toStrictEqual(['index.html', 'pages']);
  });

  test('keeps a __MACOSX/ folder below the top level, even once the unwrap lifts it to the root', () => {
    const files = { 'index.html': 'page', '__MACOSX/notes.txt': 'kept' };

    const result = extractZip(buildZip(textEntries(files, 'site/')), targetDir);

    expect(result).toStrictEqual({ files: ['__MACOSX/notes.txt', 'index.html'], dropped: [] });
    expect(readTree(targetDir)).toStrictEqual(files);
  });

  test('drops a .DS_Store at any depth and keeps its siblings', () => {
    const zipPath = buildZip(textEntries({
      'index.html': 'page',
      'pages/.DS_Store': 'Bud1',
      'pages/about.html': 'about',
      'pages/deep/.DS_Store': 'Bud1',
    }));

    const result = extractZip(zipPath, targetDir);

    expect(result).toStrictEqual({
      files: ['index.html', 'pages/about.html'],
      dropped: [
        { path: 'pages/.DS_Store', reason: 'ds-store' },
        { path: 'pages/deep/.DS_Store', reason: 'ds-store' },
      ],
    });
    expect(readTree(targetDir)).toStrictEqual({ 'index.html': 'page', 'pages/about.html': 'about' });
  });

  test('refuses an archive that holds only Finder metadata', () => {
    const zipPath = buildZip(textEntries({ '.DS_Store': 'Bud1', '__MACOSX/._index.html': 'meta' }));

    expect(() => extractZip(zipPath, targetDir)).toThrow('the archive holds no files');
    expect(existsSync(targetDir)).toBe(false);
  });
});

describe('extractZip, case collisions', () => {
  test('the collision fixtures hold both spellings', () => {
    expect(Object.keys(unzipSync(readFileSync(CASE_FILE_ZIP))).sort()).toStrictEqual(['A.html', 'a.html']);
    expect(Object.keys(unzipSync(readFileSync(CASE_FOLDER_ZIP))).sort()).toStrictEqual(['Pages/a.html', 'pages/b.html']);
  });

  test.each([
    ['a.html beside A.html', CASE_FILE_ZIP, '"A.html" and "a.html"'],
    ['Pages/a.html beside pages/b.html', CASE_FOLDER_ZIP, '"Pages" and "pages"'],
  ])('refuses %s, naming both spellings, and writes nothing, not even the target', (_shape, zipPath, spellings) => {
    expect(() => extractZip(zipPath, targetDir)).toThrow(ZipError);
    expect(() => extractZip(zipPath, targetDir)).toThrow(`${zipPath}: refused, nothing was written; these paths differ only in case`);
    expect(() => extractZip(zipPath, targetDir)).toThrow(spellings);
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(workDir)).toStrictEqual([]);
  });

  test('refuses a collision the unwrap brings together, and leaves an existing target as it was', () => {
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, 'kept.txt'), 'before');
    const zipPath = buildZip(textEntries({ 'Img/a.png': 'a', 'img/b.png': 'b' }, 'site/'));

    expect(() => extractZip(zipPath, targetDir)).toThrow('"Img" and "img"');
    expect(readTree(targetDir)).toStrictEqual({ 'kept.txt': 'before' });
  });

  test('refuses a directory entry that differs in case from a file\'s folder', () => {
    const zipPath = buildZip({ 'Assets/': new Uint8Array(0), ...textEntries({ 'assets/logo.svg': '<svg/>' }) });

    expect(() => extractZip(zipPath, targetDir)).toThrow('"Assets" and "assets"');
    expect(existsSync(targetDir)).toBe(false);
  });

  test('extracts Button.tsx beside button.css, as whole paths with extensions differ', () => {
    const files = { 'Button.tsx': 'export {};', 'button.css': '.button {}' };

    const result = extractZip(buildZip(textEntries(files)), targetDir);

    expect(result).toStrictEqual({ files: ['Button.tsx', 'button.css'], dropped: [] });
    expect(readTree(targetDir)).toStrictEqual(files);
  });
});

describe('extractZip, escaping entries', () => {
  const escapes: readonly (readonly [form: string, name: string])[] = [
    ['a ../ segment', '../evil.txt'],
    ['a ../ segment after a folder', 'a/../../evil.txt'],
    ['an absolute path', '/etc/x'],
    ['a drive letter with a slash', 'C:/x'],
    ['a drive letter without a slash', 'C:x'],
    ['a backslash-separated escape', 'a\\..\\..\\x'],
    ['a NUL byte', 'ok\0.txt'],
    ['a directory entry that climbs out', '../outside/'],
    ['an escape that starts under __MACOSX/', '__MACOSX/../../evil.txt'],
  ];

  test.each(escapes)('refuses %s and writes nothing, not even the target', (_form, name) => {
    const zipPath = buildZip({ ...textEntries(EXPORT_FILES), [name]: strToU8('escaped') });

    expect(() => extractZip(zipPath, targetDir)).toThrow(ZipError);
    expect(() => extractZip(zipPath, targetDir)).toThrow(JSON.stringify(name));
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(workDir)).toStrictEqual(['export.zip']);
  });

  test('refuses an escaping entry that comes after safe ones, leaving an existing target as it was', () => {
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, 'kept.txt'), 'before');
    const zipPath = buildZip({ ...textEntries(EXPORT_FILES), '../evil.txt': strToU8('escaped') });

    expect(() => extractZip(zipPath, targetDir)).toThrow('refused, nothing was written');
    expect(readTree(targetDir)).toStrictEqual({ 'kept.txt': 'before' });
  });

  test('names every escaping entry at once', () => {
    const zipPath = buildZip({ '../a.txt': strToU8('a'), '/etc/x': strToU8('x'), 'fine.txt': strToU8('f') });

    expect(() => extractZip(zipPath, targetDir)).toThrow(/"\.\.\/a\.txt" climbs out[\s\S]*"\/etc\/x" is an absolute path/);
  });

  test('accepts a .. segment that stays inside the target', () => {
    extractZip(buildZip(textEntries({ 'a/../index.html': 'page' })), targetDir);

    expect(readTree(targetDir)).toStrictEqual({ 'index.html': 'page' });
  });

  test('refuses a file entry that names the target itself', () => {
    const zipPath = buildZip({ ...textEntries({ 'index.html': 'page' }), 'a/..': strToU8('x') });

    expect(() => extractZip(zipPath, targetDir)).toThrow('"a/.." names the target itself');
    expect(existsSync(targetDir)).toBe(false);
  });
});

describe('extractZip, archives it cannot place', () => {
  test('refuses bytes that are not a zip', () => {
    const zipPath = join(workDir, 'export.zip');

    writeFileSync(zipPath, 'not a zip at all');

    expect(() => extractZip(zipPath, targetDir)).toThrow(`${zipPath}: cannot read the archive`);
    expect(existsSync(targetDir)).toBe(false);
  });

  test('refuses an archive that holds no files', () => {
    const zipPath = buildZip({ 'only-a-folder': {} });

    expect(() => extractZip(zipPath, targetDir)).toThrow('the archive holds no files');
    expect(existsSync(targetDir)).toBe(false);
  });

  test('refuses two entries that resolve to one file', () => {
    const zipPath = buildZip(textEntries({ 'a/index.html': 'one', 'a/./index.html': 'two', 'b.txt': 'b' }));

    expect(() => extractZip(zipPath, targetDir)).toThrow('more than one entry claims "a/index.html"');
    expect(existsSync(targetDir)).toBe(false);
  });

  test('refuses a file where another entry needs a directory', () => {
    const zipPath = buildZip(textEntries({ system: 'file', 'system/tokens.ts': 'tokens' }));

    expect(() => extractZip(zipPath, targetDir)).toThrow('more than one entry claims "system"');
    expect(existsSync(targetDir)).toBe(false);
  });

  test('never overwrites a file already in the target', () => {
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, 'index.html'), 'before');

    expect(() => extractZip(buildZip(textEntries({ 'index.html': 'after' })), targetDir)).toThrow();
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('before');
  });
});
