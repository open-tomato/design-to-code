import type { ServeCheckReport } from './check.ts';

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';

import {
  checkUrl,
  isCleanReport,
  keptPages,
  serveCheckPath,
  serveCheckReportSchema,
  writeServeCheck,
} from './check.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

const NOW = new Date('2026-09-30T12:00:00.000Z');

const V1 = 'Rafa Portal.dc.html';

const V2 = 'Rafa Portal v2.dc.html';

const CLEAN: ServeCheckReport = {
  generatedAt: NOW.toISOString(),
  address: 'http://127.0.0.1:5123/',
  pages: [
    { path: V2, consoleErrors: [], failedRequests: [], blank: false },
    { path: V1, consoleErrors: [], failedRequests: [], blank: false },
  ],
};

let workDir: string;
let sourceDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-check-test-'));
  sourceDir = join(workDir, 'spaced');
  cpSync(join(FIXTURES_DIR, 'spaced'), sourceDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('serveCheckReportSchema', () => {
  test('accepts a report with every kind of failed request', () => {
    const report = {
      ...CLEAN,
      pages: [
        {
          path: 'screens/app/dashboard.html',
          consoleErrors: ['boom'],
          failedRequests: [
            { url: 'http://127.0.0.1:5123/missing.png', status: 404 },
            { url: 'https://unpkg.com/react', reason: 'net::ERR_NAME_NOT_RESOLVED' },
          ],
          blank: true,
        },
      ],
    };

    expect(serveCheckReportSchema.parse(report)).toStrictEqual(report);
  });

  test.each([
    ['an unknown top-level key', { ...CLEAN, extra: 1 }],
    ['an unknown page key', { ...CLEAN, pages: [{ ...CLEAN.pages[0], extra: 1 }] }],
    ['pages out of path order', { ...CLEAN, pages: [...CLEAN.pages].reverse() }],
    ['a duplicate page', { ...CLEAN, pages: [CLEAN.pages[0], CLEAN.pages[0]] }],
    ['a page path escaping the source dir', { ...CLEAN, pages: [{ ...CLEAN.pages[0], path: '../x.html' }] }],
    ['an address that is not an http URL', { ...CLEAN, address: 'file:///tmp/' }],
    ['a generatedAt that is not a date-time', { ...CLEAN, generatedAt: 'yesterday' }],
    [
      'a response status under 400',
      { ...CLEAN, pages: [{ ...CLEAN.pages[0], failedRequests: [{ url: 'http://127.0.0.1:5123/a', status: 304 }] }] },
    ],
    [
      'a failed request with both a reason and a status',
      {
        ...CLEAN,
        pages: [{ ...CLEAN.pages[0], failedRequests: [{ url: 'http://127.0.0.1:5123/a', status: 404, reason: 'x' }] }],
      },
    ],
  ])('refuses %s', (_, report) => {
    expect(serveCheckReportSchema.safeParse(report).success).toBe(false);
  });
});

describe('isCleanReport', () => {
  test('is true when no page has a problem', () => {
    expect(isCleanReport(CLEAN)).toBe(true);
  });

  test.each([
    ['a console error', { consoleErrors: ['boom'] }],
    ['a failed request', { failedRequests: [{ url: 'http://127.0.0.1:5123/a', status: 404 }] }],
    ['a blank render', { blank: true }],
  ])('is false when a page has %s', (_, problem) => {
    const [first, second] = CLEAN.pages;
    const report = { ...CLEAN, pages: [first!, { ...second!, ...problem }] };

    expect(isCleanReport(report)).toBe(false);
  });
});

describe('keptPages', () => {
  beforeEach(() => {
    writeDiscovery(sourceDir, discover(sourceDir, { now: NOW }));
  });

  test('lists every discovered page, sorted by path, when no page is discarded', () => {
    expect(keptPages(sourceDir, undefined)).toStrictEqual([V2, V1]);
  });

  test('leaves out a discarded page and keeps one in keep or in neither list', () => {
    expect(keptPages(sourceDir, { keep: [V2], discard: [V1] })).toStrictEqual([V2]);
    expect(keptPages(sourceDir, { keep: [V1] })).toStrictEqual([V2, V1]);
  });

  test('names the assess step when there is no discovery.json', () => {
    rmSync(join(sourceDir, 'discovery.json'));

    expect(() => keptPages(sourceDir, undefined)).toThrow('bun run d2c assess --scripts-only');
  });

  test('refuses a discovery.json that fails its schema', () => {
    writeFileSync(join(sourceDir, 'discovery.json'), '{"pages": []}');

    expect(() => keptPages(sourceDir, undefined)).toThrow();
  });
});

describe('checkUrl', () => {
  test('percent-encodes each segment and turns the nav bar off', () => {
    expect(checkUrl('http://127.0.0.1:5123/', 'app parts/Rafa Portal.dc.html'))
      .toBe('http://127.0.0.1:5123/app%20parts/Rafa%20Portal.dc.html?d2c-nav=0');
  });

  test('encodes characters a path segment cannot hold as they are', () => {
    expect(checkUrl('http://127.0.0.1:5123/', 'a#b?c%d.html')).toBe('http://127.0.0.1:5123/a%23b%3Fc%25d.html?d2c-nav=0');
  });
});

describe('writeServeCheck', () => {
  test('writes serve-check.json at the top of the source dir as indented JSON with a trailing newline', () => {
    expect(serveCheckPath(sourceDir)).toBe(join(sourceDir, 'serve-check.json'));

    writeServeCheck(sourceDir, CLEAN);

    expect(readFileSync(serveCheckPath(sourceDir), 'utf8')).toBe(`${JSON.stringify(CLEAN, null, 2)}\n`);
  });

  test('writes nothing when the report fails its schema', () => {
    const invalid = { ...CLEAN, pages: [...CLEAN.pages].reverse() };

    expect(() => writeServeCheck(sourceDir, invalid)).toThrow();
    expect(existsSync(serveCheckPath(sourceDir))).toBe(false);
  });
});
