/**
 * Integration test for import: exercises {@link importSource} end to end —
 * folder copy, zip extraction and the record write — against a real
 * temporary filesystem, rather than any one module in isolation.
 *
 * The hash check never calls {@link hashDirectory}; it walks the placed
 * files and hashes them itself with `node:crypto`, so a bug shared between
 * `importSource` and `hashDirectory` could not hide a wrong record.
 *
 * @packageDocumentation
 */

import type { Zippable } from 'fflate';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { importSource, ImportError } from './index.ts';

/** The committed folder export the folder-import case copies from. */
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'folder-export');

let workDir: string;
let sourceDir: string;

/** Every regular file under `dir`, POSIX-relative paths, sorted. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1)
      .split('\\')
      .join('/'))
    .sort();
}

/**
 * Hashes every file placed at `dir`, independently of `pipeline/import`'s
 * own hasher, so the check proves the record against reality rather than
 * against shared code.
 */
function freshHashesOf(dir: string): { path: string; sha256: string }[] {
  return listFiles(dir)
    .filter((path) => !path.startsWith('.import/'))
    .map((path) => ({
      path,
      sha256: createHash('sha256').update(readFileSync(join(dir, path)))
        .digest('hex'),
    }));
}

/** Builds a zip in the work dir from entry names to text contents. */
function buildZip(files: Readonly<Record<string, string>>, name: string): string {
  const zipPath = join(workDir, name);
  const entries: Zippable = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)]));

  writeFileSync(zipPath, zipSync(entries));

  return zipPath;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-import-import-integration-test-'));
  sourceDir = join(workDir, 'source');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('import end to end', () => {
  test('refuses a non-empty source dir and leaves it as it was', () => {
    mkdirSync(join(sourceDir, 'earlier'), { recursive: true });
    writeFileSync(join(sourceDir, 'earlier', 'kept.html'), 'kept');

    expect(() => importSource({ source: FIXTURE_DIR, sourceDir, force: false })).toThrow(ImportError);
    expect(listFiles(sourceDir)).toStrictEqual(['earlier/kept.html']);
    expect(readFileSync(join(sourceDir, 'earlier', 'kept.html'), 'utf8')).toBe('kept');
  });

  test('refuses a zip with a ../ entry and leaves source.dir untouched', () => {
    const zipPath = buildZip({ 'index.html': 'home', '../evil.txt': 'evil' }, 'escape.zip');

    expect(() => importSource({ source: zipPath, sourceDir, force: false })).toThrow(ImportError);
    expect(existsSync(sourceDir)).toBe(false);
    expect(existsSync(join(workDir, 'evil.txt'))).toBe(false);
  });

  test('a folder import yields a record with one hash per file matching a fresh hash of the placed files', () => {
    const record = importSource({ source: FIXTURE_DIR, sourceDir, force: false });

    expect(record.kind).toBe('folder');
    expect(record.files).toStrictEqual(freshHashesOf(sourceDir));
    expect(record.files).toHaveLength(listFiles(FIXTURE_DIR).length);
  });

  test('a zip with files at the root yields a record with one hash per file matching a fresh hash of the placed files', () => {
    const zipPath = buildZip({ 'index.html': 'home', 'pages/about.html': 'about' }, 'root-files.zip');

    const record = importSource({ source: zipPath, sourceDir, force: false });

    expect(record.kind).toBe('zip');
    expect(record.files.map((file) => file.path)).toStrictEqual(['index.html', 'pages/about.html']);
    expect(record.files).toStrictEqual(freshHashesOf(sourceDir));
  });

  test('a zip with one lone top-level folder yields a record with one hash per file matching a fresh hash of the placed files', () => {
    const zipPath = buildZip({ 'my-export/index.html': 'home', 'my-export/pages/about.html': 'about' }, 'wrapped.zip');

    const record = importSource({ source: zipPath, sourceDir, force: false });

    expect(record.kind).toBe('zip');
    expect(record.files.map((file) => file.path)).toStrictEqual(['index.html', 'pages/about.html']);
    expect(record.files).toStrictEqual(freshHashesOf(sourceDir));
  });
});
