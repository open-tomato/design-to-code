import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { importRecordSchema, recordPath } from '../pipeline/import/record.ts';

import { run, USAGE } from './d2c';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

/** The tracked zip macOS Finder's "Compress" would make of a folder `export`. */
const FINDER_ZIP = join(import.meta.dirname, '..', 'pipeline', 'import', 'fixtures', 'finder-export.zip');

/** The tracked zip holding `a.html` beside `A.html`. */
const CASE_FILE_ZIP = join(import.meta.dirname, '..', 'pipeline', 'import', 'fixtures', 'case-collision-file.zip');

/** The tracked zip holding `Pages/a.html` beside `pages/b.html`. */
const CASE_FOLDER_ZIP = join(import.meta.dirname, '..', 'pipeline', 'import', 'fixtures', 'case-collision-folder.zip');

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

let rootDir: string;

/** Writes `projects/<slug>.json` under the temporary root. */
function writeProject(content: unknown): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(join(rootDir, 'projects', `${SLUG}.json`), JSON.stringify(content));
}

describe('run import', () => {
  let exportDir: string;

  /** The project's `source.dir`, absolute under the temporary root. */
  function sourceDir(): string {
    return join(rootDir, 'design', SLUG);
  }

  /** Runs the `import` verb against the temporary root. */
  function runImport(args: readonly string[], env: Record<string, string | undefined> = ENV) {
    return run(['import', ...args], { env, rootDir });
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-import-test-'));
    exportDir = join(rootDir, 'export');
    mkdirSync(join(exportDir, 'pages'), { recursive: true });
    writeFileSync(join(exportDir, 'index.html'), '<h1>home</h1>');
    writeFileSync(join(exportDir, 'pages', 'about.html'), '<h1>about</h1>');
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('imports a folder into a source.dir that does not exist yet and exits 0', async () => {
    const result = await runImport([`--source=${exportDir}`]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `d2c import: 2 files (folder) imported into design/${SLUG}\n`,
      stderr: '',
    });
    expect(readFileSync(join(sourceDir(), 'pages', 'about.html'), 'utf8')).toBe('<h1>about</h1>');

    const record = importRecordSchema.parse(JSON.parse(readFileSync(recordPath(sourceDir()), 'utf8')));

    expect(record.kind).toBe('folder');
    expect(record.originalPath).toBe(exportDir);
    expect(record.files.map((file) => file.path)).toEqual(['index.html', 'pages/about.html']);
  });

  test('accepts --source as a separate argument', async () => {
    expect((await runImport(['--source', exportDir])).exitCode).toBe(0);
    expect(existsSync(recordPath(sourceDir()))).toBe(true);
  });

  test('imports a zip and records kind zip', async () => {
    const zipPath = join(rootDir, 'export.zip');

    writeFileSync(zipPath, zipSync({ 'index.html': strToU8('<h1>zipped</h1>') }));

    const result = await runImport([`--source=${zipPath}`]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`d2c import: 1 files (zip) imported into design/${SLUG}\n`);
    expect(readFileSync(join(sourceDir(), 'index.html'), 'utf8')).toBe('<h1>zipped</h1>');
  });

  test('imports the Finder zip fixture, unwrapping to the root and recording the dropped metadata', async () => {
    const result = await runImport([`--source=${FINDER_ZIP}`]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`d2c import: 2 files (zip) imported into design/${SLUG}\n`);
    expect(result.stderr).toBe('');
    expect(readdirSync(sourceDir()).sort()).toEqual(['.import', 'index.html', 'pages']);
    expect(readFileSync(join(sourceDir(), 'index.html'), 'utf8')).toBe('<!doctype html>\n<h1>home</h1>\n');
    expect(readFileSync(join(sourceDir(), 'pages', 'about.html'), 'utf8')).toBe('<!doctype html>\n<h1>about</h1>\n');

    const record = importRecordSchema.parse(JSON.parse(readFileSync(recordPath(sourceDir()), 'utf8')));

    expect(record.kind).toBe('zip');
    expect(record.files.map((file) => file.path)).toEqual(['index.html', 'pages/about.html']);
    expect(record.dropped).toEqual(FINDER_DROPPED);
  });

  test.each([
    ['a.html beside A.html', CASE_FILE_ZIP, '"A.html" and "a.html"'],
    ['Pages/a.html beside pages/b.html', CASE_FOLDER_ZIP, '"Pages" and "pages"'],
  ])('refuses %s, naming both spellings, and leaves source.dir absent', async (_shape, zipPath, spellings) => {
    const result = await runImport([`--source=${zipPath}`]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith('d2c import: ')).toBe(true);
    expect(result.stderr).toContain(spellings);
    expect(existsSync(sourceDir())).toBe(false);
  });

  test('refuses a non-empty source.dir without --force, leaving it as it was', async () => {
    mkdirSync(sourceDir(), { recursive: true });
    writeFileSync(join(sourceDir(), 'old.html'), 'old');

    const result = await runImport([`--source=${exportDir}`]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^d2c import: .*: not empty; refusing to import over it \(pass --force to empty it first\)\n$/);
    expect(readdirSync(sourceDir())).toEqual(['old.html']);
  });

  test('empties a non-empty source.dir first with --force', async () => {
    mkdirSync(sourceDir(), { recursive: true });
    writeFileSync(join(sourceDir(), 'old.html'), 'old');

    const result = await runImport([`--source=${exportDir}`, '--force']);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(sourceDir(), 'old.html'))).toBe(false);
    expect(existsSync(join(sourceDir(), 'index.html'))).toBe(true);
  });

  test.each([
    ['no arguments', []],
    ['an empty --source', ['--source=']],
    ['only --force', ['--force']],
  ])('treats %s as a usage error naming --source and exits 1', async (_label, args) => {
    const result = await runImport(args);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`d2c import: --source=<path> is required\n\n${USAGE}\n`);
    expect(existsSync(sourceDir())).toBe(false);
  });

  // The table is built before beforeEach runs, so it names a fixed path;
  // parsing refuses these arguments before the path is ever read.
  test.each([
    ['an unknown option', ['--source=export', '--all']],
    ['a positional argument', ['--source=export', 'extra']],
    ['a value on --force', ['--source=export', '--force=yes']],
  ])('treats %s as a usage error and exits 1', async (_label, args) => {
    const result = await runImport(args);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.startsWith('d2c import: ')).toBe(true);
    expect(result.stderr.endsWith(`\n\n${USAGE}\n`)).toBe(true);
    expect(existsSync(sourceDir())).toBe(false);
  });

  test('prints the import error for a missing source and exits 1', async () => {
    const missing = join(rootDir, 'absent');
    const result = await runImport([`--source=${missing}`]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `d2c import: ${missing}: no such file or directory\n`,
    });
  });

  test('prints the loader error when D2C_PROJECT is unset and exits 1', async () => {
    const result = await runImport([`--source=${exportDir}`], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr.startsWith('d2c import: D2C_PROJECT is not set')).toBe(true);
    expect(existsSync(sourceDir())).toBe(false);
  });

  test('usage lists the import verb and both of its flags', () => {
    expect(USAGE).toContain('  import  ');
    expect(USAGE).toContain('--source=<path>');
    expect(USAGE).toContain('--force');
  });
});
