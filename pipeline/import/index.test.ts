import type { Zippable } from 'fflate';

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { detectSourceKind, importSource, ImportError } from './index.ts';
import { hashDirectory, importRecordSchema, recordPath } from './record.ts';

/** The committed folder export the folder-import tests copy from. */
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'folder-export');

/** The committed zip macOS Finder's "Compress" would make of a folder `export`. */
const FINDER_ZIP = join(import.meta.dirname, 'fixtures', 'finder-export.zip');

/** The tracked zip holding `a.html` beside `A.html`. */
const CASE_FILE_ZIP = join(import.meta.dirname, 'fixtures', 'case-collision-file.zip');

/** The tracked zip holding `Pages/a.html` beside `pages/b.html`. */
const CASE_FOLDER_ZIP = join(import.meta.dirname, 'fixtures', 'case-collision-folder.zip');

/** The fixture's files, POSIX paths, sorted. */
const FIXTURE_FILES = ['assets/notes.txt', 'index.html', 'pages/about.html'];

/** A fixed import time, so the record's `importedAt` is predictable. */
const NOW = new Date('2026-09-30T12:00:00.000Z');

let workDir: string;
let sourceDir: string;
/** A `d2c-import-*` folder in the system temp dir, as a parallel worker's staging would leave. */
let decoyDir: string | undefined;

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

/** Builds a zip in the work dir from entry names to text contents. */
function buildZip(files: Readonly<Record<string, string>>, name = 'export.zip'): string {
  const zipPath = join(workDir, name);
  const entries: Zippable = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)]));

  writeFileSync(zipPath, zipSync(entries));

  return zipPath;
}

/** Writes a folder export in the work dir from POSIX paths to text contents. */
function writeFolder(files: Readonly<Record<string, string>>): string {
  const exportDir = join(workDir, 'export');

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(exportDir, path, '..'), { recursive: true });
    writeFileSync(join(exportDir, path), content);
  }

  return exportDir;
}

/**
 * Writes `a.html` and `A.html` into a fresh temp folder, where the tests'
 * work dirs live, and returns the folder's entries: two on a case-sensitive
 * file system, one on a case-insensitive one.
 */
function probeBothSpellings(): readonly string[] {
  const probeDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-import-index-test-'));

  try {
    writeFileSync(join(probeDir, 'a.html'), 'lower');
    writeFileSync(join(probeDir, 'A.html'), 'upper');

    return readdirSync(probeDir).sort();
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/** The probe's entries; the folder collision tests need both spellings. */
const PROBE_ENTRIES = probeBothSpellings();

/** Whether the temp dir cannot hold a folder with a case collision. */
const CASE_INSENSITIVE_FS = PROBE_ENTRIES.length !== 2;

if (CASE_INSENSITIVE_FS) {
  process.stderr.write(`skipping the folder case-collision tests: the file system is case-insensitive; writing a.html and A.html left ${JSON.stringify(PROBE_ENTRIES)}\n`);
}

/** Writes `a.html` and `A.html` into a folder export and returns it. */
function writeBothSpellings(): string {
  const exportDir = writeFolder({ 'a.html': 'lower', 'A.html': 'upper' });

  expect(readdirSync(exportDir).sort()).toStrictEqual(['A.html', 'a.html']);

  return exportDir;
}

/** Fills the source dir with one earlier file, so it is non-empty. */
function seedSourceDir(): void {
  mkdirSync(join(sourceDir, 'old'), { recursive: true });
  writeFileSync(join(sourceDir, 'old', 'stale.html'), 'stale');
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-import-index-test-'));
  sourceDir = join(workDir, 'source');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });

  if (decoyDir !== undefined) {
    rmSync(decoyDir, { recursive: true, force: true });
    decoyDir = undefined;
  }
});

describe('detectSourceKind', () => {
  test('names a directory a folder', () => {
    expect(detectSourceKind(FIXTURE_DIR)).toBe('folder');
  });

  test('names a file ending in .zip, in any case, a zip', () => {
    const lower = buildZip({ 'a.txt': 'a' });
    const upper = buildZip({ 'a.txt': 'a' }, 'EXPORT.ZIP');

    expect(detectSourceKind(lower)).toBe('zip');
    expect(detectSourceKind(upper)).toBe('zip');
  });

  test('names a directory a folder even when its name ends in .zip', () => {
    const dir = join(workDir, 'odd.zip');

    mkdirSync(dir);

    expect(detectSourceKind(dir)).toBe('folder');
  });

  test('refuses a file that is not a zip', () => {
    const path = join(workDir, 'export.tar');

    writeFileSync(path, 'x');

    expect(() => detectSourceKind(path)).toThrow(ImportError);
    expect(() => detectSourceKind(path)).toThrow(/not a folder or a \.zip file/);
  });

  test('refuses a path that does not exist', () => {
    expect(() => detectSourceKind(join(workDir, 'missing'))).toThrow(/no such file or directory/);
  });
});

describe('importSource from a folder', () => {
  test('copies every file recursively and returns the record it wrote', () => {
    const record = importSource({ source: FIXTURE_DIR, sourceDir, force: false, now: NOW });

    expect(readTree(sourceDir)).toStrictEqual({ ...readTree(FIXTURE_DIR), '.import/record.json': expect.any(String) });
    expect(record.kind).toBe('folder');
    expect(record.originalPath).toBe(FIXTURE_DIR);
    expect(record.importedAt).toBe(NOW.toISOString());
    expect(record.files.map((file) => file.path)).toStrictEqual(FIXTURE_FILES);
    expect(record.files).toStrictEqual(hashDirectory(sourceDir));
    expect(record.dropped).toStrictEqual([]);
  });

  test('writes the returned record to .import/record.json', () => {
    const record = importSource({ source: FIXTURE_DIR, sourceDir, force: false, now: NOW });
    const written: unknown = JSON.parse(readFileSync(recordPath(sourceDir), 'utf8'));

    expect(importRecordSchema.parse(written)).toStrictEqual(record);
  });

  test('creates a missing source dir, parents included', () => {
    const nested = join(workDir, 'a', 'b', 'source');

    importSource({ source: FIXTURE_DIR, sourceDir: nested, force: false });

    expect(Object.keys(readTree(nested))).toContain('index.html');
  });

  test('imports into an existing empty source dir without force', () => {
    mkdirSync(sourceDir);

    const record = importSource({ source: FIXTURE_DIR, sourceDir, force: false });

    expect(record.files).toHaveLength(FIXTURE_FILES.length);
  });

  test('skips a top-level .import/ in the source folder', () => {
    const exportDir = join(workDir, 'export');

    mkdirSync(join(exportDir, '.import'), { recursive: true });
    writeFileSync(join(exportDir, '.import', 'record.json'), '{}');
    writeFileSync(join(exportDir, 'index.html'), 'home');

    const record = importSource({ source: exportDir, sourceDir, force: false });

    expect(record.files.map((file) => file.path)).toStrictEqual(['index.html']);
    expect(readFileSync(recordPath(sourceDir), 'utf8')).not.toBe('{}');
  });

  test('refuses a symlink inside the source folder and leaves the source dir absent', () => {
    const exportDir = join(workDir, 'export');

    mkdirSync(exportDir);
    writeFileSync(join(exportDir, 'index.html'), 'home');
    symlinkSync(join(workDir, 'outside.txt'), join(exportDir, 'link.txt'));

    expect(() => importSource({ source: exportDir, sourceDir, force: false })).toThrow(/link\.txt: a symlink/);
    expect(existsSync(sourceDir)).toBe(false);
  });

  test('refuses a folder with no files', () => {
    const exportDir = join(workDir, 'export');

    mkdirSync(join(exportDir, 'empty'), { recursive: true });

    expect(() => importSource({ source: exportDir, sourceDir, force: false })).toThrow(/holds no files/);
  });

  test('refuses a source dir inside the source folder, even with force', () => {
    const exportDir = join(workDir, 'export');

    mkdirSync(exportDir);
    writeFileSync(join(exportDir, 'index.html'), 'home');

    expect(() => importSource({ source: exportDir, sourceDir: join(exportDir, 'source'), force: true })).toThrow(/overlap/);
    expect(readTree(exportDir)).toStrictEqual({ 'index.html': 'home' });
  });

  test('refuses a source folder inside the source dir, even with force', () => {
    mkdirSync(join(sourceDir, 'export'), { recursive: true });
    writeFileSync(join(sourceDir, 'export', 'index.html'), 'home');

    expect(() => importSource({ source: join(sourceDir, 'export'), sourceDir, force: true })).toThrow(/overlap/);
    expect(readTree(sourceDir)).toStrictEqual({ 'export/index.html': 'home' });
  });
});

describe('importSource from a zip', () => {
  test('extracts files at the root of the archive and records kind zip', () => {
    const zipPath = buildZip({ 'index.html': 'home', 'pages/about.html': 'about' });

    const record = importSource({ source: zipPath, sourceDir, force: false, now: NOW });

    expect(record.kind).toBe('zip');
    expect(record.originalPath).toBe(zipPath);
    expect(record.files.map((file) => file.path)).toStrictEqual(['index.html', 'pages/about.html']);
    expect(record.files).toStrictEqual(hashDirectory(sourceDir));
  });

  test('unwraps a lone top-level folder to the same relative paths', () => {
    const zipPath = buildZip({ 'my-export/index.html': 'home', 'my-export/pages/about.html': 'about' });

    const record = importSource({ source: zipPath, sourceDir, force: false });

    expect(record.files.map((file) => file.path)).toStrictEqual(['index.html', 'pages/about.html']);
  });

  test('drops Finder metadata, unwraps the export folder to the root and records what it dropped', () => {
    const record = importSource({ source: FINDER_ZIP, sourceDir, force: false, now: NOW });

    expect(Object.keys(readTree(sourceDir))).toStrictEqual(['.import/record.json', 'index.html', 'pages/about.html']);
    expect(record.files.map((file) => file.path)).toStrictEqual(['index.html', 'pages/about.html']);
    expect(record.dropped.map((entry) => entry.path)).toStrictEqual([
      '__MACOSX/',
      '__MACOSX/export/',
      '__MACOSX/export/._.DS_Store',
      '__MACOSX/export/._index.html',
      '__MACOSX/export/pages/',
      '__MACOSX/export/pages/._about.html',
      'export/.DS_Store',
    ]);
    expect(importRecordSchema.parse(JSON.parse(readFileSync(recordPath(sourceDir), 'utf8')))).toStrictEqual(record);
  });

  test('refuses an escaping entry as an ImportError and leaves the source dir absent', () => {
    const zipPath = buildZip({ 'index.html': 'home', '../evil.txt': 'evil' });

    expect(() => importSource({ source: zipPath, sourceDir, force: false })).toThrow(ImportError);
    expect(() => importSource({ source: zipPath, sourceDir, force: false })).toThrow(/"\.\.\/evil\.txt" climbs out/);
    expect(existsSync(sourceDir)).toBe(false);
    expect(existsSync(join(workDir, 'evil.txt'))).toBe(false);
  });

  test('refuses an escaping entry with force and leaves the non-empty source dir as it was', () => {
    seedSourceDir();
    const zipPath = buildZip({ 'index.html': 'home', '/etc/x': 'evil' });

    expect(() => importSource({ source: zipPath, sourceDir, force: true })).toThrow(/is an absolute path/);
    expect(readTree(sourceDir)).toStrictEqual({ 'old/stale.html': 'stale' });
  });

  test('refuses an unreadable archive as an ImportError', () => {
    const zipPath = join(workDir, 'broken.zip');

    writeFileSync(zipPath, 'not a zip');

    expect(() => importSource({ source: zipPath, sourceDir, force: false })).toThrow(ImportError);
    expect(existsSync(sourceDir)).toBe(false);
  });

  test('removes its temporary staging directory on success and on refusal', () => {
    const stagingRoot = join(workDir, 'staging');

    mkdirSync(stagingRoot);
    importSource({ source: buildZip({ 'index.html': 'home' }), sourceDir, force: false, stagingRoot });
    decoyDir = mkdtempSync(join(tmpdir(), 'd2c-import-decoy-'));
    expect(() => importSource({ source: buildZip({ '../evil.txt': 'evil' }, 'evil.zip'), sourceDir, force: true, stagingRoot })).toThrow(ImportError);

    expect(readdirSync(stagingRoot)).toStrictEqual([]);
  });

  test('stages under the given staging root, so a missing one stops the import', () => {
    const stagingRoot = join(workDir, 'no-such-root');

    expect(() => importSource({ source: buildZip({ 'index.html': 'home' }), sourceDir, force: false, stagingRoot })).toThrow(/ENOENT/);
    expect(existsSync(sourceDir)).toBe(false);
  });
});

describe('importSource, case collisions', () => {
  test.each([
    ['a.html beside A.html', CASE_FILE_ZIP, '"A.html" and "a.html"'],
    ['Pages/a.html beside pages/b.html', CASE_FOLDER_ZIP, '"Pages" and "pages"'],
  ])('refuses a zip holding %s as an ImportError naming both spellings, writing nothing', (_shape, zipPath, spellings) => {
    const stagingRoot = join(workDir, 'staging');

    mkdirSync(stagingRoot);

    expect(() => importSource({ source: zipPath, sourceDir, force: false, stagingRoot })).toThrow(ImportError);
    expect(() => importSource({ source: zipPath, sourceDir, force: false, stagingRoot })).toThrow(spellings);
    expect(existsSync(sourceDir)).toBe(false);
    expect(readdirSync(stagingRoot)).toStrictEqual([]);
  });

  test('refuses a zip collision with force and leaves the non-empty source dir as it was', () => {
    seedSourceDir();

    expect(() => importSource({ source: CASE_FILE_ZIP, sourceDir, force: true })).toThrow('"A.html" and "a.html"');
    expect(readTree(sourceDir)).toStrictEqual({ 'old/stale.html': 'stale' });
  });

  test.skipIf(CASE_INSENSITIVE_FS)('refuses a folder holding a.html beside A.html, naming both spellings, writing nothing', () => {
    const exportDir = writeBothSpellings();

    expect(() => importSource({ source: exportDir, sourceDir, force: false })).toThrow(ImportError);
    expect(() => importSource({ source: exportDir, sourceDir, force: false })).toThrow(`${exportDir}: refused, nothing was written`);
    expect(() => importSource({ source: exportDir, sourceDir, force: false })).toThrow('"A.html" and "a.html"');
    expect(existsSync(sourceDir)).toBe(false);
  });

  test.skipIf(CASE_INSENSITIVE_FS)('refuses a folder collision with force and leaves the non-empty source dir as it was', () => {
    const exportDir = writeBothSpellings();

    seedSourceDir();

    expect(() => importSource({ source: exportDir, sourceDir, force: true })).toThrow('"A.html" and "a.html"');
    expect(readTree(sourceDir)).toStrictEqual({ 'old/stale.html': 'stale' });
  });

  test.each([
    ['a zip', (files: Readonly<Record<string, string>>): string => buildZip(files)],
    ['a folder', (files: Readonly<Record<string, string>>): string => writeFolder(files)],
  ])('imports Button.tsx beside button.css from %s', (_kind, makeSource) => {
    const files = { 'Button.tsx': 'export {};', 'button.css': '.button {}' };

    const record = importSource({ source: makeSource(files), sourceDir, force: false });

    expect(record.files.map((file) => file.path)).toStrictEqual(['Button.tsx', 'button.css']);
    expect(readTree(sourceDir)).toStrictEqual({ ...files, '.import/record.json': expect.any(String) });
  });
});

describe('importSource into a non-empty source dir', () => {
  test('refuses without force and leaves the source dir as it was', () => {
    seedSourceDir();

    expect(() => importSource({ source: FIXTURE_DIR, sourceDir, force: false })).toThrow(ImportError);
    expect(() => importSource({ source: FIXTURE_DIR, sourceDir, force: false })).toThrow(/not empty.*--force/);
    expect(readTree(sourceDir)).toStrictEqual({ 'old/stale.html': 'stale' });
  });

  test('counts a lone earlier record as non-empty', () => {
    importSource({ source: FIXTURE_DIR, sourceDir, force: false });
    rmSync(join(sourceDir, 'index.html'));
    rmSync(join(sourceDir, 'pages'), { recursive: true });
    rmSync(join(sourceDir, 'assets'), { recursive: true });

    expect(() => importSource({ source: FIXTURE_DIR, sourceDir, force: false })).toThrow(/not empty/);
  });

  test('empties the source dir first with force, so no earlier file survives', () => {
    seedSourceDir();

    const record = importSource({ source: FIXTURE_DIR, sourceDir, force: true });

    expect(record.files.map((file) => file.path)).toStrictEqual(FIXTURE_FILES);
    expect(existsSync(join(sourceDir, 'old'))).toBe(false);
  });

  test('empties the source dir first with force for a zip too', () => {
    seedSourceDir();

    const record = importSource({ source: buildZip({ 'index.html': 'home' }), sourceDir, force: true });

    expect(record.files.map((file) => file.path)).toStrictEqual(['index.html']);
    expect(readTree(sourceDir)).toStrictEqual({ 'index.html': 'home', '.import/record.json': expect.any(String) });
  });

  test('refuses a source dir that is a file, even with force', () => {
    writeFileSync(sourceDir, 'a file');

    expect(() => importSource({ source: FIXTURE_DIR, sourceDir, force: true })).toThrow(/exists and is not a directory/);
    expect(readFileSync(sourceDir, 'utf8')).toBe('a file');
  });
});
