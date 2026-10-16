/**
 * Browser integration tests for the nav bar over this package's `spaced`
 * fixture, driven end to end in headless Chromium.
 *
 * Collapsed, the overlay must be provably invisible to the page it sits
 * over: a clipped screenshot of everything outside the overlay host's own
 * bounding box must render identically whether the nav `<script>` is
 * injected or the request turns it off with `?d2c-nav=0`, `Object.keys`
 * of `window` must list the same names either way (the overlay's IIFE
 * defines no globals), and a page element's computed style must be the
 * same either way (the overlay's styles are scoped to its shadow root and
 * never reach a page element). Expanded, the overlay must list every page
 * `discovery.json` reports, grouped as its `agentNotes.versionGroups`
 * groups them.
 *
 * The fixture is tracked and must not be mutated, so every test copies it
 * into a fresh temporary directory first, the same way
 * `server.integration.test.ts` does.
 *
 * @packageDocumentation
 */

import type { RunningServer } from './server.ts';
import type { Browser, Page } from 'playwright';

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';

import { startServer } from './server.ts';

/** The fixture's first page, an early version of {@link V2}. */
const V1 = 'Rafa Portal.dc.html';

/** The fixture's second page, grouped with {@link V1} as one version group. */
const V2 = 'Rafa Portal v2.dc.html';

/** A page element `page.js` appends after the nav script would run, real page content to probe for style leaks. */
const GREETING_SELECTOR = '#greeting';

/** A fixed viewport, so a clip rectangle computed once holds for every screenshot in a test. */
const VIEWPORT = { width: 900, height: 700 };

const NOW = new Date('2026-09-30T12:00:00.000Z');

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

/** Generous enough for a browser launch plus a page load per test or hook. */
const TEST_TIMEOUT_MS = 30_000;

/** A rectangle in CSS pixels, as `Page.screenshot`'s `clip` option takes it. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Percent-encodes each segment of a POSIX path relative to `source.dir`. */
function encodePath(relativePath: string): string {
  return relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/** A page's computed style, every property name to its value. */
type StyleSnapshot = Record<string, string>;

let workDir: string;
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

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-nav-integration-test-'));
  sourceDir = join(workDir, 'spaced');
  openPages = [];

  cpSync(join(FIXTURES_DIR, 'spaced'), sourceDir, { recursive: true });

  const report = discover(sourceDir, { now: NOW });

  writeDiscovery(sourceDir, {
    ...report,
    agentNotes: { ...report.agentNotes, versionGroups: [[V2, V1]] },
  });

  server = await startServer({ sourceDir, env: {}, port: 0 });
}, TEST_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(openPages.map((page) => page.close()));
  await server.stop();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Opens `url` in a fresh page at {@link VIEWPORT}, closed by the next
 * `afterEach`, and waits for the network (including the overlay's
 * `GET /__d2c/pages`, when it runs) to go idle before returning it.
 */
async function openPage(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });

  openPages.push(page);
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  return page;
}

/** The overlay host's bounding box in CSS pixels, or null when it is not on the page. */
function hostBoundingBox(page: Page): Promise<Rect | null> {
  return page.evaluate(() => {
    const host = document.querySelector('d2c-nav');

    if (!host) {
      return null;
    }

    const box = host.getBoundingClientRect();

    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
}

/**
 * Two clip rectangles that together cover {@link VIEWPORT} apart from
 * `hostBox`: the strip above it, full width, and the strip to its left,
 * from the same top down to the viewport's bottom. Floored, so neither
 * rectangle touches `hostBox` even on a fractional boundary.
 */
function outsideHostClips(hostBox: Rect): readonly Rect[] {
  const top = Math.floor(hostBox.y);
  const left = Math.floor(hostBox.x);

  return [
    { x: 0, y: 0, width: VIEWPORT.width, height: top },
    { x: 0, y: top, width: left, height: VIEWPORT.height - top },
  ];
}

/** Every computed style property and value of the element `selector` matches, in the page. */
function styleSnapshot(page: Page, selector: string): Promise<StyleSnapshot> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);

    if (!element) {
      throw new Error(`no element matches ${sel}`);
    }

    const computed = getComputedStyle(element);
    const snapshot: Record<string, string> = {};

    for (let index = 0; index < computed.length; index += 1) {
      const property = computed.item(index);

      snapshot[property] = computed.getPropertyValue(property);
    }

    return snapshot;
  }, selector);
}

/** One rendered `<section>` of the expanded overlay's page list. */
interface RenderedSection {
  readonly heading: string | null;
  readonly items: ReadonlyArray<{ readonly href: string | null; readonly path: string | null }>;
}

/** Expands the overlay (Playwright's CSS engine pierces its open shadow root) and reads its sections. */
async function expandOverlay(page: Page): Promise<RenderedSection[]> {
  await page.click('button.tab');
  await page.waitForSelector('.panel:not([hidden])');

  return page.locator('section').evaluateAll((sections) => sections.map((section) => ({
    heading: section.querySelector('h2')?.textContent ?? null,
    items: [...section.querySelectorAll('li')].map((item) => ({
      href: item.querySelector('a')?.getAttribute('href') ?? null,
      path: item.querySelector('.path')?.textContent ?? null,
    })),
  })));
}

describe('the nav bar over the spaced fixture, in headless Chromium', () => {
  test('collapsed, clipped screenshots outside the overlay host are byte-identical with and without ?d2c-nav=0', async () => {
    const withNav = await openPage(`${server.address}${encodePath(V1)}`);
    const hostBox = await hostBoundingBox(withNav);

    if (!hostBox) {
      throw new Error('the overlay host is not on the page with the nav script injected');
    }

    const clips = outsideHostClips(hostBox);
    const withoutNav = await openPage(`${server.address}${encodePath(V1)}?d2c-nav=0`);

    expect(await hostBoundingBox(withoutNav)).toBeNull();

    for (const clip of clips) {
      const withNavShot = await withNav.screenshot({ clip });
      const withoutNavShot = await withoutNav.screenshot({ clip });

      expect(withNavShot.equals(withoutNavShot)).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  test('Object.keys(window) is identical with and without ?d2c-nav=0', async () => {
    const withNav = await openPage(`${server.address}${encodePath(V1)}`);
    const withoutNav = await openPage(`${server.address}${encodePath(V1)}?d2c-nav=0`);

    const withNavKeys = await withNav.evaluate(() => Object.keys(window));
    const withoutNavKeys = await withoutNav.evaluate(() => Object.keys(window));

    expect(withNavKeys).toEqual(withoutNavKeys);
  }, TEST_TIMEOUT_MS);

  test('the overlay\'s styles do not reach a page element', async () => {
    const withNav = await openPage(`${server.address}${encodePath(V1)}`);
    const withoutNav = await openPage(`${server.address}${encodePath(V1)}?d2c-nav=0`);

    const withNavStyle = await styleSnapshot(withNav, GREETING_SELECTOR);
    const withoutNavStyle = await styleSnapshot(withoutNav, GREETING_SELECTOR);

    expect(withNavStyle).toEqual(withoutNavStyle);
  }, TEST_TIMEOUT_MS);

  test('expanded, the overlay lists every discovered page with its version group', async () => {
    const page = await openPage(`${server.address}${encodePath(V1)}`);

    const sections = await expandOverlay(page);

    expect(sections).toEqual([
      {
        heading: 'Version group 1',
        items: [
          { href: `/${encodeURIComponent(V2)}`, path: V2 },
          { href: `/${encodeURIComponent(V1)}`, path: V1 },
        ],
      },
    ]);
  }, TEST_TIMEOUT_MS);
});
