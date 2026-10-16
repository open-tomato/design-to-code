import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { recordPath, writeImportRecord } from '../import/record.ts';

import {
  BaselinePathError,
  IMPORT_COMMAND,
  keyDirectory,
  MissingImportRecordError,
  pagePngPath,
  readImportHash,
  readPlaywrightVersion,
} from './key.ts';

const HASH = 'a'.repeat(64);

const KEY_DIR = '/work/baselines/demo/1.63.0/' + HASH;

let sourceDir: string;

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-key-test-'));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
});

describe('readPlaywrightVersion', () => {
  test('reads the installed playwright-core version', () => {
    const manifestPath = join(import.meta.dirname, '../../node_modules/playwright-core/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };

    expect(readPlaywrightVersion()).toBe(manifest.version);
    expect(readPlaywrightVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('readImportHash', () => {
  test('hashes the record bytes as written', () => {
    writeImportRecord({ sourceDir, kind: 'folder', originalPath: 'export' });
    const expected = createHash('sha256')
      .update(readFileSync(recordPath(sourceDir)))
      .digest('hex');

    expect(readImportHash(sourceDir)).toBe(expected);
  });

  test('gives a different hash once importedAt changes', () => {
    writeImportRecord({ sourceDir, kind: 'folder', originalPath: 'export', now: new Date('2026-09-30T12:00:00.000Z') });
    const first = readImportHash(sourceDir);

    writeImportRecord({ sourceDir, kind: 'folder', originalPath: 'export', now: new Date('2026-09-30T12:00:01.000Z') });
    const second = readImportHash(sourceDir);

    expect(second).not.toBe(first);
  });

  test('gives the same hash for the same record', () => {
    writeImportRecord({ sourceDir, kind: 'folder', originalPath: 'export', now: new Date('2026-09-30T12:00:00.000Z') });

    expect(readImportHash(sourceDir)).toBe(readImportHash(sourceDir));
  });

  test('refuses a source dir with no import record, naming the import command', () => {
    expect(() => readImportHash(sourceDir)).toThrow(MissingImportRecordError);
    expect(() => readImportHash(sourceDir)).toThrow(IMPORT_COMMAND);
    expect(() => readImportHash(sourceDir)).toThrow(recordPath(sourceDir));
  });
});

describe('keyDirectory', () => {
  test('resolves a relative baselineDir against rootDir', () => {
    const key = keyDirectory({
      baselineDir: 'baselines/demo',
      rootDir: '/work',
      playwrightVersion: '1.63.0',
      importHash: HASH,
    });

    expect(key).toBe(KEY_DIR);
  });

  test('passes an absolute baselineDir through', () => {
    const key = keyDirectory({
      baselineDir: '/elsewhere/demo',
      rootDir: '/work',
      playwrightVersion: '1.63.0',
      importHash: HASH,
    });

    expect(key).toBe(`/elsewhere/demo/1.63.0/${HASH}`);
  });

  test.each(['..', '../x', 'a/b', '/abs', ''])('refuses the version "%s"', (playwrightVersion) => {
    expect(() => keyDirectory({ baselineDir: 'b', rootDir: '/work', playwrightVersion, importHash: HASH }))
      .toThrow(BaselinePathError);
  });

  test.each(['..', '../x', 'a/b', '/abs', ''])('refuses the import hash "%s"', (importHash) => {
    expect(() => keyDirectory({ baselineDir: 'b', rootDir: '/work', playwrightVersion: '1.63.0', importHash }))
      .toThrow(BaselinePathError);
  });
});

describe('pagePngPath', () => {
  test('keeps a page path with spaces and a folder under pages/', () => {
    expect(pagePngPath(KEY_DIR, 'app parts/Rafa Portal.dc.html', 'desktop'))
      .toBe(`${KEY_DIR}/pages/app parts/Rafa Portal.dc.html/desktop.png`);
  });

  test.each(['..', '../x.html', 'a/../../x.html', '/etc/passwd', '', '.', 'a/..', 'x\0.html'])(
    'refuses the page path "%s"',
    (pagePath) => {
      expect(() => pagePngPath(KEY_DIR, pagePath, 'desktop')).toThrow(BaselinePathError);
    },
  );

  test.each(['../desktop', 'a/b', '/abs'])('refuses the viewport name "%s"', (viewportName) => {
    expect(() => pagePngPath(KEY_DIR, 'index.html', viewportName)).toThrow(BaselinePathError);
  });
});
