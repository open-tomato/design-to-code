import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  CONTENT_TYPES,
  contentTypeFor,
  DEFAULT_CONTENT_TYPE,
  resolveRequestPath,
} from './paths.ts';

let workDir: string;
let sourceDir: string;

/** Writes an empty file at a POSIX path under the temporary source dir. */
function place(relativePath: string): void {
  const filePath = join(sourceDir, ...relativePath.split('/'));

  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, '');
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-paths-test-'));
  sourceDir = join(workDir, 'source');
  mkdirSync(sourceDir);
  place('Rafa Portal v2.dc.html');
  place('app parts/shared.js');
  place('screens/app/index.html');
  writeFileSync(join(workDir, 'secret.txt'), 'outside');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('resolveRequestPath', () => {
  test('decodes a name with spaces to the file under the source dir', () => {
    expect(resolveRequestPath(sourceDir, '/Rafa%20Portal%20v2.dc.html')).toEqual({
      kind: 'file',
      filePath: join(sourceDir, 'Rafa Portal v2.dc.html'),
      relativePath: 'Rafa Portal v2.dc.html',
    });
  });

  test('decodes a folder with a space', () => {
    expect(resolveRequestPath(sourceDir, '/app%20parts/shared.js')).toMatchObject({
      kind: 'file',
      relativePath: 'app parts/shared.js',
    });
  });

  test('drops the query string before resolving', () => {
    expect(resolveRequestPath(sourceDir, '/app%20parts/shared.js?d2c-nav=0&v=%zz')).toMatchObject({
      kind: 'file',
      relativePath: 'app parts/shared.js',
    });
  });

  test('drops a fragment before resolving', () => {
    expect(resolveRequestPath(sourceDir, '/app%20parts/shared.js#top')).toMatchObject({
      kind: 'file',
      relativePath: 'app parts/shared.js',
    });
  });

  test('keeps a file that does not exist as a file, for the server to answer 404', () => {
    expect(resolveRequestPath(sourceDir, '/missing.html')).toEqual({
      kind: 'file',
      filePath: join(sourceDir, 'missing.html'),
      relativePath: 'missing.html',
    });
  });

  test('maps the root to its index.html', () => {
    expect(resolveRequestPath(sourceDir, '/')).toMatchObject({
      kind: 'file',
      relativePath: 'index.html',
    });
  });

  test('maps a trailing-slash directory request to its index.html', () => {
    expect(resolveRequestPath(sourceDir, '/screens/app/')).toMatchObject({
      kind: 'file',
      filePath: join(sourceDir, 'screens', 'app', 'index.html'),
      relativePath: 'screens/app/index.html',
    });
  });

  test('maps an existing directory named without a trailing slash to its index.html', () => {
    expect(resolveRequestPath(sourceDir, '/screens/app?x=1')).toMatchObject({
      kind: 'file',
      relativePath: 'screens/app/index.html',
    });
  });

  test('keeps a dot segment that stays inside the source dir', () => {
    expect(resolveRequestPath(sourceDir, '/screens/../app%20parts/shared.js')).toMatchObject({
      kind: 'file',
      relativePath: 'app parts/shared.js',
    });
  });

  test('serves a name that merely starts with two dots', () => {
    expect(resolveRequestPath(sourceDir, '/..notes.txt')).toMatchObject({
      kind: 'file',
      relativePath: '..notes.txt',
    });
  });

  test.each([
    ['a raw ..', '/../secret.txt'],
    ['a bare ..', '/..'],
    ['a deeper ..', '/screens/../../secret.txt'],
    ['..%2f', '/..%2fsecret.txt'],
    ['..%2F', '/..%2Fsecret.txt'],
    ['%2e%2e', '/%2e%2e/secret.txt'],
    ['%2e%2e%2f', '/%2e%2e%2fsecret.txt'],
    ['.. behind a query string', '/../secret.txt?file=index.html'],
  ])('answers 403 for %s', (_label, target) => {
    expect(resolveRequestPath(sourceDir, target)).toMatchObject({
      kind: 'refused',
      status: 403,
    });
  });

  test('answers 403 for a symlink whose real path lies outside the source dir', () => {
    symlinkSync(join(workDir, 'secret.txt'), join(sourceDir, 'link.txt'));

    expect(resolveRequestPath(sourceDir, '/link.txt')).toMatchObject({
      kind: 'refused',
      status: 403,
    });
  });

  test('serves a symlink whose real path stays inside the source dir', () => {
    symlinkSync(join(sourceDir, 'app parts', 'shared.js'), join(sourceDir, 'alias.js'));

    expect(resolveRequestPath(sourceDir, '/alias.js')).toMatchObject({
      kind: 'file',
      relativePath: 'alias.js',
    });
  });

  test.each([
    ['a truncated escape', '/Rafa%2'],
    ['a non-hex escape', '/Rafa%zzPortal.html'],
    ['an invalid UTF-8 sequence', '/%c3%28.html'],
  ])('answers 400 for %s', (_label, target) => {
    expect(resolveRequestPath(sourceDir, target)).toMatchObject({
      kind: 'refused',
      status: 400,
    });
  });

  test('answers 400 for an encoded NUL byte', () => {
    expect(resolveRequestPath(sourceDir, '/index.html%00.js')).toMatchObject({
      kind: 'refused',
      status: 400,
      reason: 'NUL byte in /index.html%00.js',
    });
  });

  test('answers 400 for a target that is not origin-form', () => {
    expect(resolveRequestPath(sourceDir, 'http://127.0.0.1/../secret.txt')).toMatchObject({
      kind: 'refused',
      status: 400,
    });
  });
});

describe('contentTypeFor', () => {
  test.each([
    ['Rafa Portal v2.dc.html', 'text/html; charset=utf-8'],
    ['screens/app/index.html', 'text/html; charset=utf-8'],
    ['app parts/shared.js', 'text/javascript; charset=utf-8'],
    ['module.mjs', 'text/javascript; charset=utf-8'],
    ['Card.jsx', 'text/javascript; charset=utf-8'],
    ['tokens.ts', 'text/javascript; charset=utf-8'],
    ['Button.tsx', 'text/javascript; charset=utf-8'],
    ['shared/base.css', 'text/css; charset=utf-8'],
    ['hero.svg', 'image/svg+xml'],
    ['photo.PNG', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['font.woff2', 'font/woff2'],
    ['discovery.json', 'application/json'],
  ])('maps %s to %s', (filePath, expected) => {
    expect(contentTypeFor(filePath)).toBe(expected);
  });

  test.each(['archive.zip', 'README', 'notes.txt.bak', '.hidden'])('falls back to octet-stream for %s', (filePath) => {
    expect(contentTypeFor(filePath)).toBe(DEFAULT_CONTENT_TYPE);
  });

  test('lists every extension in lowercase with a leading dot', () => {
    for (const extension of Object.keys(CONTENT_TYPES)) {
      expect(extension).toMatch(/^\.[a-z0-9]+$/);
    }
  });
});
