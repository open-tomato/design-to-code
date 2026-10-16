/**
 * Browser integration test for the serve health check: {@link checkPages}
 * runs headless Chromium against a server over a temporary copy of the
 * `spaced` fixture, with extra pages written into the copy: one that logs
 * a console error and throws, one that requests a missing file, one that
 * renders nothing visible, and one that renders only when another page
 * ran first in the same browser context.
 *
 * The fixture is tracked and must not be mutated, so every test copies it
 * into a fresh temporary directory first and runs discovery there, the
 * same way `server.integration.test.ts` does.
 *
 * @packageDocumentation
 */

import type { ServeCheckReport } from './check.ts';
import type { RunningServer } from './server.ts';

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';

import { checkPages, checkUrl, serveCheckPath, serveCheckReportSchema } from './check.ts';
import { startServer } from './server.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

const NOW = new Date('2026-09-30T12:00:00.000Z');

/** Generous enough for a browser launch plus a load of every page. */
const TEST_TIMEOUT_MS = 90_000;

/** The `spaced` fixture pages, which load cleanly. */
const CLEAN_PAGES = ['Rafa Portal v2.dc.html', 'Rafa Portal.dc.html'];

const CONSOLE_ERROR_PAGE = 'console-error.html';

const MISSING_FILE_PAGE = 'missing-file.html';

const BLANK_PAGE = 'blank.html';

/** Sorts before {@link NEEDS_FLAG_PAGE}, so a shared context would load it first. */
const SETS_FLAG_PAGE = 'a-sets-flag.html';

const NEEDS_FLAG_PAGE = 'b-needs-flag.html';

/** A page with `body` inside its `<body>`. */
function html(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** The pages written into the fixture copy, beside the `spaced` ones. */
const EXTRA_PAGES: Readonly<Record<string, string>> = {
  [CONSOLE_ERROR_PAGE]: html('Console error', [
    '<p>Logs an error and throws.</p>',
    '<script>console.error("boom from the page");</script>',
    '<script>throw new Error("uncaught boom");</script>',
  ].join('\n')),
  [MISSING_FILE_PAGE]: html('Missing file', '<p>Requests a file that is not there.</p>\n<img src="missing.png" alt="">'),
  [BLANK_PAGE]: html('Blank', '<div></div>\n<p style="visibility: hidden">hidden text</p>'),
  [SETS_FLAG_PAGE]: html('Sets flag', [
    '<p>Sets the flag.</p>',
    '<script>localStorage.setItem("d2c-check-flag", "1");</script>',
  ].join('\n')),
  [NEEDS_FLAG_PAGE]: html('Needs flag', [
    '<script>',
    'if (localStorage.getItem("d2c-check-flag") === "1") {',
    '  const note = document.createElement("p");',
    '  note.textContent = "Rendered after the flag was set.";',
    '  document.body.appendChild(note);',
    '}',
    '</script>',
  ].join('\n')),
};

let workDir: string;
let sourceDir: string;
let server: RunningServer;

/** Copies the fixture, adds the extra pages, runs discovery and starts a server over the copy. */
async function setUp(): Promise<void> {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-check-integration-test-'));
  sourceDir = join(workDir, 'spaced');

  cpSync(join(FIXTURES_DIR, 'spaced'), sourceDir, { recursive: true });
  Object.entries(EXTRA_PAGES).forEach(([name, text]) => {
    writeFileSync(join(sourceDir, name), text);
  });
  writeDiscovery(sourceDir, discover(sourceDir, { now: NOW }));

  server = await startServer({ sourceDir, env: {}, port: 0 });
}

async function tearDown(): Promise<void> {
  await server.stop();
  rmSync(workDir, { recursive: true, force: true });
}

/** The reading for `path` in `report`, failing the test when there is none. */
function entry(report: ServeCheckReport, path: string) {
  const found = report.pages.find((page) => page.path === path);

  if (!found) {
    throw new Error(`no reading for ${path}`);
  }

  return found;
}

describe('checkPages over a temp copy of the spaced fixture, in headless Chromium', () => {
  let report: ServeCheckReport;

  beforeAll(async () => {
    await setUp();
    report = await checkPages({ sourceDir, address: server.address, pages: undefined, now: () => NOW });
  }, TEST_TIMEOUT_MS);

  afterAll(tearDown);

  test('writes a schema-valid serve-check.json naming the address, every page sorted by path', () => {
    const written: unknown = JSON.parse(readFileSync(serveCheckPath(sourceDir), 'utf8'));

    expect(serveCheckReportSchema.parse(written)).toStrictEqual(report);
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.address).toBe(server.address);
    expect(report.pages.map((page) => page.path)).toStrictEqual([
      ...CLEAN_PAGES,
      SETS_FLAG_PAGE,
      NEEDS_FLAG_PAGE,
      BLANK_PAGE,
      CONSOLE_ERROR_PAGE,
      MISSING_FILE_PAGE,
    ].sort());
  });

  test.each(CLEAN_PAGES)('reads "%s" as clean', (path) => {
    expect(entry(report, path)).toStrictEqual({ path, consoleErrors: [], failedRequests: [], blank: false });
  });

  test('records a console error and an uncaught error', () => {
    expect(entry(report, CONSOLE_ERROR_PAGE)).toStrictEqual({
      path: CONSOLE_ERROR_PAGE,
      consoleErrors: ['boom from the page', 'Error: uncaught boom'],
      failedRequests: [],
      blank: false,
    });
  });

  test('records a request for a missing file with its URL and status', () => {
    const reading = entry(report, MISSING_FILE_PAGE);

    expect(reading.failedRequests).toStrictEqual([{ url: `${server.address}missing.png`, status: 404 }]);
    expect(reading.consoleErrors).toStrictEqual([
      'Failed to load resource: the server responded with a status of 404 (Not Found)',
    ]);
    expect(reading.blank).toBe(false);
  });

  test('reads a page with no visible text, image, SVG or canvas as blank', () => {
    expect(entry(report, BLANK_PAGE)).toStrictEqual({ path: BLANK_PAGE, consoleErrors: [], failedRequests: [], blank: true });
  });

  test('reads a page that renders only after another page ran in its context as blank', () => {
    expect(entry(report, SETS_FLAG_PAGE).blank).toBe(false);
    expect(entry(report, NEEDS_FLAG_PAGE)).toStrictEqual({
      path: NEEDS_FLAG_PAGE,
      consoleErrors: [],
      failedRequests: [],
      blank: true,
    });
  });
});

describe('checkPages, controls and edges', () => {
  beforeEach(setUp);

  afterEach(tearDown);

  test('the order-dependent page does render when its setter ran first in one shared context', async () => {
    const browser = await chromium.launch();

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(checkUrl(server.address, SETS_FLAG_PAGE));
      await page.goto(checkUrl(server.address, NEEDS_FLAG_PAGE));

      await expect(page.locator('p').textContent()).resolves.toBe('Rendered after the flag was set.');
    } finally {
      await browser.close();
    }
  }, TEST_TIMEOUT_MS);

  test('leaves discarded pages out and never loads them', async () => {
    const discard = [BLANK_PAGE, CONSOLE_ERROR_PAGE, MISSING_FILE_PAGE, SETS_FLAG_PAGE, NEEDS_FLAG_PAGE];
    const report = await checkPages({ sourceDir, address: server.address, pages: { discard, keep: [] }, now: () => NOW });

    expect(report.pages.map((page) => page.path)).toStrictEqual(CLEAN_PAGES);
  }, TEST_TIMEOUT_MS);

  test('records a page the server no longer answers as a failed request and still writes the report', async () => {
    await server.stop();

    const report = await checkPages({
      sourceDir,
      address: server.address,
      pages: { discard: [BLANK_PAGE, CONSOLE_ERROR_PAGE, MISSING_FILE_PAGE, SETS_FLAG_PAGE, NEEDS_FLAG_PAGE, CLEAN_PAGES[0] ?? ''] },
      now: () => NOW,
    });
    const [reading] = report.pages;

    expect(existsSync(serveCheckPath(sourceDir))).toBe(true);
    expect(reading?.path).toBe(CLEAN_PAGES[1]);
    expect(reading?.failedRequests).toHaveLength(1);
    expect(reading?.failedRequests[0]).toMatchObject({ url: checkUrl(server.address, CLEAN_PAGES[1] ?? '') });
    expect(reading?.blank).toBe(true);
  }, TEST_TIMEOUT_MS);
});
