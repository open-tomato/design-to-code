/**
 * Browser tests for `capture.ts` over a temporary copy of the `clock`
 * fixture, served by `startServer` and captured in headless Chromium.
 *
 * The live-clock page reads the wall clock from a Web Worker, which
 * `page.clock` does not reach, so its double capture is `flaky` with the
 * differing pixels inside the clock text's box; the fixed-clock page reads
 * the installed clock and is `captured`. A page written into the copy puts
 * two `loading="lazy"` images far below the fold, one halfway down and one
 * at the bottom; a control load without the scroll proves Chromium defers
 * them, so the capture showing them is the load waits' doing.
 *
 * The fixture is tracked and never modified: every run copies it first.
 *
 * @packageDocumentation
 */

import type { CaptureTarget } from './capture.ts';
import type { CaptureViewport } from './settings.ts';
import type { RunningServer } from '../serve/server.ts';
import type { Browser } from 'playwright';

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { checkUrl } from '../serve/check.ts';
import { startServer } from '../serve/server.ts';

import { capturePage, doubleCapture, doubleCaptureInspecting, withLoadedPage } from './capture.ts';
import { contextOptions } from './settings.ts';

const CLOCK_FIXTURE = join(import.meta.dirname, 'fixtures', 'clock');

/** A browser launch plus two captures of a page, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const VIEWPORT: CaptureViewport = { name: 'desktop', width: 800, height: 600 };

const LIVE_CLOCK_PAGE = 'live-clock.html';

const FIXED_CLOCK_PAGE = 'fixed-clock.html';

const LAZY_PAGE = 'lazy-image.html';

/** Side of each square lazy image, in pixels. */
const IMAGE_SIZE = 200;

/** The spacer above each lazy image: far past Chromium's lazy-load margin at a 600 px viewport. */
const SPACER_HEIGHT = 4000;

/** An RGBA colour. */
type Rgba = readonly [number, number, number, number];

const RED: Rgba = [255, 0, 0, 255];

const BLUE: Rgba = [0, 0, 255, 255];

/** A lazy image on {@link LAZY_PAGE}: its file, colour and top edge on the page. */
interface LazyImage {
  readonly file: string;
  readonly colour: Rgba;
  readonly top: number;
}

const LAZY_IMAGES: readonly LazyImage[] = [
  { file: 'middle.png', colour: RED, top: SPACER_HEIGHT },
  { file: 'bottom.png', colour: BLUE, top: 2 * SPACER_HEIGHT + IMAGE_SIZE },
];

/** A square PNG of one colour. */
function solidPng(colour: Rgba): Buffer {
  const png = new PNG({ width: IMAGE_SIZE, height: IMAGE_SIZE });

  for (let index = 0; index < IMAGE_SIZE * IMAGE_SIZE; index += 1) {
    png.data.set(colour, index * 4);
  }

  return PNG.sync.write(png);
}

/** The lazy page: each image below its own spacer, with no margins. */
function lazyPageHtml(): string {
  const body = LAZY_IMAGES
    .map((image) => [
      `<div style="height: ${SPACER_HEIGHT}px">spacer</div>`,
      `<img loading="lazy" src="${image.file}" width="${IMAGE_SIZE}" height="${IMAGE_SIZE}" alt="" style="display: block">`,
    ].join('\n'))
    .join('\n');

  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Lazy</title></head>\n<body style="margin: 0">\n${body}\n</body>\n</html>\n`;
}

/** The colour of the pixel at `x`, `y` of a PNG. */
function pixelAt(png: PNG, x: number, y: number): readonly number[] {
  const offset = (y * png.width + x) * 4;

  return [...png.data.subarray(offset, offset + 4)];
}

let workDir: string;
let server: RunningServer;
let browser: Browser;

/** The capture target for `path` at {@link VIEWPORT}. */
function target(path: string): CaptureTarget {
  return { address: server.address, path, viewport: VIEWPORT };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-capture-test-'));

  const sourceDir = join(workDir, 'clock');

  cpSync(CLOCK_FIXTURE, sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, LAZY_PAGE), lazyPageHtml());
  LAZY_IMAGES.forEach((image) => {
    writeFileSync(join(sourceDir, image.file), solidPng(image.colour));
  });

  server = await startServer({ sourceDir, env: {}, port: 0 });
  browser = await chromium.launch();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  await server.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe('doubleCapture over the clock fixture', () => {
  test('marks the live-clock page flaky with a box inside the clock text', async () => {
    const result = await doubleCapture(browser, target(LIVE_CLOCK_PAGE));
    const clockBox = await withLoadedPage(browser, target(LIVE_CLOCK_PAGE), (page) => page.locator('#clock').boundingBox());

    expect(result.status).toBe('flaky');
    expect(clockBox).not.toBeNull();

    if (result.status !== 'flaky' || clockBox === null) {
      return;
    }

    const { differingPixels, region } = result.diff;

    expect(differingPixels).toBeGreaterThan(0);
    expect(region).not.toBeNull();
    expect(region?.x).toBeGreaterThanOrEqual(Math.floor(clockBox.x));
    expect(region?.y).toBeGreaterThanOrEqual(Math.floor(clockBox.y));
    expect((region?.x ?? 0) + (region?.width ?? 0)).toBeLessThanOrEqual(Math.ceil(clockBox.x + clockBox.width));
    expect((region?.y ?? 0) + (region?.height ?? 0)).toBeLessThanOrEqual(Math.ceil(clockBox.y + clockBox.height));
  }, TEST_TIMEOUT_MS);

  test('marks the fixed-clock page captured with a full-page PNG at the viewport width', async () => {
    const result = await doubleCapture(browser, target(FIXED_CLOCK_PAGE));

    expect(result.status).toBe('captured');

    if (result.status !== 'captured') {
      return;
    }

    const png = PNG.sync.read(result.png);

    expect(png.width).toBe(VIEWPORT.width);
    expect(png.height).toBe(VIEWPORT.height);
  }, TEST_TIMEOUT_MS);

  test('loads the fixed-clock page under the installed clock, so it shows the fixed epoch', async () => {
    const text = await withLoadedPage(browser, target(FIXED_CLOCK_PAGE), (page) => page.locator('#clock').textContent());

    expect(text).toBe('2024-01-01 00:00');
  }, TEST_TIMEOUT_MS);
});

describe('doubleCaptureInspecting over the clock fixture', () => {
  test('reads the first capture\'s loaded page and still compares two captures', async () => {
    const urls: string[] = [];
    const { result, inspected } = await doubleCaptureInspecting(browser, target(FIXED_CLOCK_PAGE), async (page) => {
      urls.push(page.url());

      return page.locator('#clock').textContent();
    });

    expect(inspected).toBe('2024-01-01 00:00');
    expect(urls).toStrictEqual([checkUrl(server.address, FIXED_CLOCK_PAGE)]);
    expect(result.status).toBe('captured');
  }, TEST_TIMEOUT_MS);

  test('reports the live-clock page flaky, as doubleCapture does', async () => {
    const { result } = await doubleCaptureInspecting(browser, target(LIVE_CLOCK_PAGE), async () => null);

    expect(result.status).toBe('flaky');
  }, TEST_TIMEOUT_MS);
});

describe('capturePage and lazy-loaded images', () => {
  test('control: a plain load of the lazy page leaves both images unloaded', async () => {
    const context = await browser.newContext(contextOptions(VIEWPORT));

    try {
      const page = await context.newPage();

      await page.goto(checkUrl(server.address, LAZY_PAGE));
      await page.waitForLoadState('networkidle');

      const loaded = await page.locator('img').evaluateAll((images) => images.map((image) => (image as HTMLImageElement).complete));

      expect(loaded).toStrictEqual([false, false]);
    } finally {
      await context.close();
    }
  }, TEST_TIMEOUT_MS);

  test('shows both below-the-fold lazy images in the full-page capture', async () => {
    const png = PNG.sync.read(await capturePage(browser, target(LAZY_PAGE)));

    expect(png.height).toBe(2 * (SPACER_HEIGHT + IMAGE_SIZE));
    LAZY_IMAGES.forEach((image) => {
      expect(pixelAt(png, IMAGE_SIZE / 2, image.top + IMAGE_SIZE / 2)).toStrictEqual(image.colour);
    });
  }, TEST_TIMEOUT_MS);
});
