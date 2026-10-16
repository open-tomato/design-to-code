import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DROP_REASONS,
  hashDirectory,
  IMPORT_KINDS,
  importRecordSchema,
  RECORD_DIR,
  RECORD_FILE,
  recordPath,
  writeImportRecord,
} from './record.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');

let sourceDir: string;

function sha256(text: string): string {
  return createHash('sha256')
    .update(text)
    .digest('hex');
}

/** Writes `content` at a POSIX path under the temporary source dir. */
function place(relativePath: string, content: string): void {
  const filePath = join(sourceDir, ...relativePath.split('/'));

  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-import-record-test-'));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
});

describe('importRecordSchema', () => {
  const valid = {
    kind: 'zip',
    originalPath: 'exports/site.zip',
    importedAt: NOW.toISOString(),
    files: [{ path: 'index.html', sha256: sha256('x') }],
    dropped: [{ path: '__MACOSX/._index.html', reason: 'macos-metadata' }],
  };

  test('accepts a valid record', () => {
    expect(importRecordSchema.parse(valid)).toStrictEqual(valid);
  });

  test('reads a record written without dropped as having dropped nothing', () => {
    const { kind, originalPath, importedAt, files } = valid;
    const withoutDropped = { kind, originalPath, importedAt, files };

    expect(Object.keys(withoutDropped)).not.toContain('dropped');
    expect(importRecordSchema.parse(withoutDropped)).toStrictEqual({ ...withoutDropped, dropped: [] });
  });

  test('names the two drop reasons and refuses any other at its path', () => {
    expect(DROP_REASONS).toStrictEqual(['macos-metadata', 'ds-store']);

    const result = importRecordSchema.safeParse({ ...valid, dropped: [{ path: 'Thumbs.db', reason: 'windows' }] });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toStrictEqual(['dropped.0.reason']);
  });

  test('names every source kind, including the two not produced yet', () => {
    expect(IMPORT_KINDS).toStrictEqual(['folder', 'zip', 'share-link', 'send-to-claude']);

    for (const kind of IMPORT_KINDS) {
      expect(importRecordSchema.safeParse({ ...valid, kind }).success).toBe(true);
    }
  });

  test('refuses an unknown kind at its path', () => {
    const result = importRecordSchema.safeParse({ ...valid, kind: 'ftp' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toStrictEqual(['kind']);
  });

  test('refuses a time that is not ISO 8601', () => {
    expect(importRecordSchema.safeParse({ ...valid, importedAt: 'yesterday' }).success).toBe(false);
  });

  test('refuses a digest that is not 64 lowercase hex digits', () => {
    const result = importRecordSchema.safeParse({
      ...valid,
      files: [{ path: 'index.html', sha256: sha256('x').toUpperCase() }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toStrictEqual(['files.0.sha256']);
  });
});

describe('hashDirectory', () => {
  test('hashes every file with POSIX paths, sorted, at any depth', () => {
    place('b.html', 'bee');
    place('system/tokens.ts', 'tokens');
    place('a.css', 'ay');
    place('system/deep/x.js', 'ex');

    expect(hashDirectory(sourceDir)).toStrictEqual([
      { path: 'a.css', sha256: sha256('ay') },
      { path: 'b.html', sha256: sha256('bee') },
      { path: 'system/deep/x.js', sha256: sha256('ex') },
      { path: 'system/tokens.ts', sha256: sha256('tokens') },
    ]);
  });

  test('skips the top-level .import directory', () => {
    place('index.html', 'page');
    place(`${RECORD_DIR}/${RECORD_FILE}`, '{}');

    expect(hashDirectory(sourceDir).map((file) => file.path)).toStrictEqual(['index.html']);
  });

  test('keeps a nested .import directory, which is export content', () => {
    place(`pages/${RECORD_DIR}/note.txt`, 'kept');

    expect(hashDirectory(sourceDir).map((file) => file.path)).toStrictEqual([`pages/${RECORD_DIR}/note.txt`]);
  });

  test('returns an empty list for an empty directory', () => {
    expect(hashDirectory(sourceDir)).toStrictEqual([]);
  });

  test('throws on a symlink instead of leaving it out', () => {
    place('index.html', 'page');
    symlinkSync(join(sourceDir, 'index.html'), join(sourceDir, 'link.html'));

    expect(() => hashDirectory(sourceDir)).toThrow('link.html: not a regular file or directory');
  });
});

describe('recordPath', () => {
  test('is .import/record.json inside the source dir', () => {
    expect(recordPath(sourceDir)).toBe(join(sourceDir, RECORD_DIR, RECORD_FILE));
  });
});

describe('writeImportRecord', () => {
  test('writes and returns a record with one hash per file', () => {
    place('index.html', 'page');
    place('system/tokens.ts', 'tokens');

    const record = writeImportRecord({ sourceDir, kind: 'folder', originalPath: '/tmp/export', now: NOW });

    expect(record).toStrictEqual({
      kind: 'folder',
      originalPath: '/tmp/export',
      importedAt: '2026-09-30T12:00:00.000Z',
      files: [
        { path: 'index.html', sha256: sha256('page') },
        { path: 'system/tokens.ts', sha256: sha256('tokens') },
      ],
      dropped: [],
    });

    const written: unknown = JSON.parse(readFileSync(recordPath(sourceDir), 'utf8'));

    expect(importRecordSchema.parse(written)).toStrictEqual(record);
  });

  test('records the dropped entries it is given', () => {
    place('index.html', 'page');
    const dropped = [{ path: 'export/.DS_Store', reason: 'ds-store' }] as const;

    const record = writeImportRecord({ sourceDir, kind: 'zip', originalPath: 'site.zip', now: NOW, dropped });

    expect(record.dropped).toStrictEqual(dropped);
    expect(JSON.parse(readFileSync(recordPath(sourceDir), 'utf8'))).toHaveProperty('dropped', dropped);
  });

  test('replaces an earlier record without hashing it', () => {
    place('index.html', 'page');
    writeImportRecord({ sourceDir, kind: 'zip', originalPath: 'first.zip', now: NOW });

    const second = writeImportRecord({ sourceDir, kind: 'folder', originalPath: 'second', now: NOW });

    expect(second.files.map((file) => file.path)).toStrictEqual(['index.html']);
    expect(JSON.parse(readFileSync(recordPath(sourceDir), 'utf8'))).toStrictEqual(second);
  });

  test('stamps the current time when no time is given', () => {
    const before = Date.now();
    const record = writeImportRecord({ sourceDir, kind: 'folder', originalPath: 'export' });

    expect(Date.parse(record.importedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(record.importedAt)).toBeLessThanOrEqual(Date.now());
  });

  test('refuses an empty original path and writes nothing', () => {
    expect(() => writeImportRecord({ sourceDir, kind: 'folder', originalPath: '', now: NOW })).toThrow();
    expect(() => readFileSync(recordPath(sourceDir))).toThrow();
  });
});
