/**
 * Tests for `page.ts`: a small inline page, written into a temporary
 * directory, served by `startServer` and loaded in headless Chromium by
 * `withSeedPage`, then read through the global `installUniqueSelector`
 * defines.
 *
 * Each probed element's built selector is asserted to match exactly one
 * element, that element itself, for an element with a unique id, one
 * under it, an element with a duplicated id, one under it, and a repeated
 * sibling. The controls: the global is absent until installed, and a
 * duplicated id used as a selector on its own matches two elements, so
 * the exactly-one check can fail.
 *
 * @packageDocumentation
 */

import type { UniqueSelector } from './page.ts';
import type { RunningServer } from '../serve/server.ts';
import type { Browser, Page } from 'playwright';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startServer } from '../serve/server.ts';

import { installUniqueSelector, SEED_VIEWPORT, UNIQUE_SELECTOR_GLOBAL, withSeedPage } from './page.ts';

/** A browser launch plus a page load with its waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const PAGE_PATH = 'probe.html';

const PROBE_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Probe</title></head>',
  '<body>',
  '<header id="top"><nav><a href="#a">One</a><a href="#b" data-probe="under-unique-id">Two</a></nav></header>',
  '<main>',
  '<section id="dup"><p>A</p></section>',
  '<section id="dup" data-probe="duplicated-id"><p data-probe="under-duplicated-id">B</p></section>',
  '<ul><li>1</li><li data-probe="repeated-sibling">2</li><li>3</li></ul>',
  '</main>',
  '</body>',
  '</html>',
  '',
].join('\n');

let workDir: string;
let server: RunningServer;
let browser: Browser;

/** What the built selector of one probed element matched in the page. */
interface SelectorReading {
  /** The built selector. */
  readonly selector: string;
  /** How many elements it matched. */
  readonly matches: number;
  /** Whether its first match is the probed element. */
  readonly isProbed: boolean;
}

/** Runs in the page: builds the probed element's selector with the global and queries it back. */
function readProbeInPage(args: { readonly name: string; readonly probe: string }): SelectorReading {
  const element = document.querySelector(`[data-probe="${args.probe}"]`) ?? document.getElementById(args.probe);

  if (element === null) {
    throw new Error(`no element for probe ${args.probe}`);
  }

  const build = (window as unknown as Partial<Record<string, UniqueSelector>>)[args.name];

  if (build === undefined) {
    throw new Error(`no ${args.name} global on the page`);
  }

  const selector = build(element);
  const found = document.querySelectorAll(selector);

  return { selector, matches: found.length, isProbed: found[0] === element };
}

/** Loads the probe page, installs the builder, and reads `probe`. */
function readProbe(probe: string): Promise<SelectorReading> {
  return withSeedPage(browser, server.address, PAGE_PATH, async (page) => {
    await installUniqueSelector(page);

    return page.evaluate(readProbeInPage, { name: UNIQUE_SELECTOR_GLOBAL, probe });
  });
}

/** Whether the builder global is defined on `page`. */
function hasBuilder(page: Page): Promise<boolean> {
  return page.evaluate((name) => typeof (window as unknown as Record<string, unknown>)[name] === 'function', UNIQUE_SELECTOR_GLOBAL);
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-seed-page-'));
  writeFileSync(join(workDir, PAGE_PATH), PROBE_HTML);
  server = await startServer({ sourceDir: workDir, env: {}, port: 0 });
  browser = await chromium.launch();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe('SEED_VIEWPORT', () => {
  test('is 1280x800', () => {
    expect(SEED_VIEWPORT).toMatchObject({ width: 1280, height: 800 });
  });
});

describe('withSeedPage', () => {
  test('loads the page at SEED_VIEWPORT', async () => {
    const seen = await withSeedPage(browser, server.address, PAGE_PATH, async (page) => ({
      viewport: page.viewportSize(),
      title: await page.title(),
    }));

    expect(seen).toStrictEqual({ viewport: { width: 1280, height: 800 }, title: 'Probe' });
  }, TEST_TIMEOUT_MS);
});

describe('installUniqueSelector', () => {
  test('defines the builder global, which is absent before the install', async () => {
    const defined = await withSeedPage(browser, server.address, PAGE_PATH, async (page) => {
      const before = await hasBuilder(page);

      await installUniqueSelector(page);

      return { before, after: await hasBuilder(page) };
    });

    expect(defined).toStrictEqual({ before: false, after: true });
  }, TEST_TIMEOUT_MS);

  test.each([
    ['top', 'header#top'],
    ['under-unique-id', 'header#top > nav > a:nth-of-type(2)'],
    ['duplicated-id', 'html > body > main > section:nth-of-type(2)'],
    ['under-duplicated-id', 'html > body > main > section:nth-of-type(2) > p'],
    ['repeated-sibling', 'html > body > main > ul > li:nth-of-type(2)'],
  ])('builds a selector matching exactly the %s element', async (probe, expected) => {
    const reading = await readProbe(probe);

    expect(reading).toStrictEqual({ selector: expected, matches: 1, isProbed: true });
  }, TEST_TIMEOUT_MS);

  test('control: the duplicated id alone matches two elements', async () => {
    const matches = await withSeedPage(browser, server.address, PAGE_PATH, (page) => page.locator('section#dup').count());

    expect(matches).toBe(2);
  }, TEST_TIMEOUT_MS);
});
