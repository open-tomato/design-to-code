/**
 * Browser integration test for curation over this package's `spaced`
 * fixture, driven end to end in headless Chromium against a temporary
 * project: clicking Discard for a page in the overlay writes it to
 * `pages.discard` of `projects/<slug>.json`, clicking Keep afterwards moves
 * it to `pages.keep`, and {@link loadProjectConfig} validates the file after
 * each click.
 *
 * The fixture is tracked and must not be mutated, so the test copies it into
 * a fresh temporary directory first, the same way `nav.integration.test.ts`
 * and `server.integration.test.ts` do; the project config is written beside
 * it in the same temporary root, so nothing under `projects/` in the repo is
 * touched.
 *
 * @packageDocumentation
 */

import type { RunningServer } from './server.ts';
import type { Browser, Page, Response } from 'playwright';

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { loadProjectConfig } from '../../config/load.ts';
import { savePageChoice } from '../../config/save.ts';
import { discover, writeDiscovery } from '../assess/discover.ts';

import { startServer } from './server.ts';

/** The fixture page curated over the course of this test. */
const V1 = 'Rafa Portal.dc.html';

const SLUG = 'curation-integration';

const ENV = { D2C_PROJECT: SLUG };

const NOW = new Date('2026-09-30T12:00:00.000Z');

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

/** Generous enough for a browser launch plus a page load per test or hook. */
const TEST_TIMEOUT_MS = 30_000;

/** Percent-encodes each segment of a POSIX path relative to `source.dir`. */
function encodePath(relativePath: string): string {
  return relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

let rootDir: string;
let sourceDir: string;
let server: RunningServer;
let browser: Browser;
let openPages: Page[];

beforeAll(async () => {
  browser = await chromium.launch();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
});

/** Writes `projects/<slug>.json` naming `sourceDir` as `source.dir`, with no `pages` yet. */
function writeProject(): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(
    join(rootDir, 'projects', `${SLUG}.json`),
    JSON.stringify({ slug: SLUG, source: { dir: sourceDir } }),
  );
}

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-curation-integration-test-'));
  sourceDir = join(rootDir, 'spaced');
  openPages = [];

  cpSync(join(FIXTURES_DIR, 'spaced'), sourceDir, { recursive: true });
  writeDiscovery(sourceDir, discover(sourceDir, { now: NOW }));
  writeProject();

  server = await startServer({
    sourceDir,
    env: {},
    port: 0,
    readPages: () => loadProjectConfig({ env: ENV, rootDir }).pages,
    savePage: (page, choice) => savePageChoice(SLUG, page, choice, { rootDir }),
  });
}, TEST_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(openPages.map((page) => page.close()));
  await server.stop();
  rmSync(rootDir, { recursive: true, force: true });
});

/**
 * Opens `url` in a fresh page, closed by the next `afterEach`, and waits for
 * the network (including the overlay's `GET /__d2c/pages`) to go idle
 * before returning it.
 */
async function openPage(url: string): Promise<Page> {
  const page = await browser.newPage();

  openPages.push(page);
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  return page;
}

/** Expands the overlay (Playwright's CSS engine pierces its open shadow root). */
async function expandOverlay(page: Page): Promise<void> {
  await page.click('button.tab');
  await page.waitForSelector('.panel:not([hidden])');
}

/** The overlay's list row for the discovered page `path`. */
function pageRow(page: Page, path: string) {
  return page.locator('li').filter({ has: page.locator('.path', { hasText: path }) });
}

/**
 * Clicks the row's `label` ("Keep" or "Discard") button and waits for the
 * `POST /__d2c/pages` it triggers to settle, resolving to that response.
 */
async function clickChoice(page: Page, path: string, label: 'Keep' | 'Discard'): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url().endsWith('/__d2c/pages') && candidate.request().method() === 'POST'),
    pageRow(page, path).getByRole('button', { name: label })
      .click(),
  ]);

  return response;
}

describe('curation over the spaced fixture, in headless Chromium', () => {
  test('discarding then keeping a page in the overlay writes it to the temporary project config', async () => {
    const page = await openPage(`${server.address}${encodePath(V1)}`);

    await expandOverlay(page);

    const discardResponse = await clickChoice(page, V1, 'Discard');

    expect(discardResponse.status()).toBe(200);

    const discardedConfig = loadProjectConfig({ env: ENV, rootDir });

    expect(discardedConfig.pages).toStrictEqual({ discard: [V1] });

    const keepResponse = await clickChoice(page, V1, 'Keep');

    expect(keepResponse.status()).toBe(200);

    const keptConfig = loadProjectConfig({ env: ENV, rootDir });

    expect(keptConfig.pages).toStrictEqual({ discard: [], keep: [V1] });
  }, TEST_TIMEOUT_MS);
});
