/**
 * Deterministic page capture: loads one served page at one viewport under
 * the shared capture settings and takes its full-page PNG, and captures a
 * page and viewport twice to prove the capture is stable.
 *
 * {@link withLoadedPage} owns one fresh Chromium context: it is built from
 * `contextOptions` in `settings.ts`, gets the seeded `Math.random` init
 * script and the page clock installed at `FIXED_EPOCH` before navigation,
 * and loads the page through `checkUrl`, so the nav bar is never in the
 * capture. The load waits, in order, are: network idle, `document.fonts.ready`,
 * a scroll down the page one viewport at a time to the bottom and back to
 * the top so lazy-loaded images and icons are requested, then network
 * quiet again. The second wait is measured here rather than asked of
 * Playwright, because `waitForLoadState('networkidle')` resolves at once
 * once a page has reached that state, before the requests the scroll
 * started have finished.
 *
 * {@link capturePage} takes the full-page screenshot with animations left
 * running. {@link doubleCapture} captures twice, each in its own fresh
 * context, and compares the two with `diffPngs`: identical captures are
 * `captured` with the PNG, any differing pixel makes the page and viewport
 * `flaky` with the diff result instead. {@link doubleCaptureInspecting}
 * does the same and also reads the first capture's loaded page, so the
 * animation inventory comes from a context a capture actually used.
 *
 * @packageDocumentation
 */

import type { DiffResult } from './diff.ts';
import type { CaptureViewport } from './settings.ts';
import type { Browser, Page } from 'playwright';

import { setTimeout as delay } from 'node:timers/promises';

import { checkUrl, PAGE_TIMEOUT_MS } from '../serve/check.ts';

import { diffPngs } from './diff.ts';
import {
  contextOptions,
  FIXED_EPOCH,
  SCREENSHOT_ANIMATIONS,
  SEEDED_RANDOM_SCRIPT,
} from './settings.ts';

/** How long no request may be in flight before the network counts as quiet, as Playwright's `networkidle`. */
export const NETWORK_QUIET_MS = 500;

/** How often the in-flight count is looked at while waiting for quiet, in milliseconds. */
const QUIET_POLL_MS = 50;

/** The most viewport-high scroll steps taken on the way down, so a page that keeps growing still ends. */
export const MAX_SCROLL_STEPS = 200;

/** One page of a running server at one viewport. */
export interface CaptureTarget {
  /** The running server's base URL, such as `http://127.0.0.1:4600/`. */
  readonly address: string;
  /** The page path as `discovery.json` lists it. */
  readonly path: string;
  /** The viewport to capture at. */
  readonly viewport: CaptureViewport;
}

/** Two captures of a page and viewport that agree pixel for pixel. */
export interface CapturedResult {
  /** The captures agreed. */
  readonly status: 'captured';
  /** The full-page PNG, the first of the two identical captures. */
  readonly png: Buffer;
}

/** Two captures of a page and viewport that differ. */
export interface FlakyResult {
  /** The captures differed; no PNG is kept. */
  readonly status: 'flaky';
  /** How many pixels differ and the one box enclosing them. */
  readonly diff: DiffResult;
}

/** What {@link doubleCapture} found. */
export type DoubleCaptureResult = CapturedResult | FlakyResult;

/** Waits for the network to go quiet on the page it was made for. */
type QuietWaiter = () => Promise<void>;

/**
 * Counts the page's requests in flight from now on and returns a waiter
 * that resolves once none has been in flight for {@link NETWORK_QUIET_MS}.
 *
 * @throws Error from the waiter, naming `url`, when the network is still
 * busy after {@link PAGE_TIMEOUT_MS}.
 */
function trackNetwork(page: Page, url: string): QuietWaiter {
  const counter = { inFlight: 0, changedAt: performance.now() };
  const settle = (): void => {
    counter.inFlight -= 1;
    counter.changedAt = performance.now();
  };

  page.on('request', () => {
    counter.inFlight += 1;
    counter.changedAt = performance.now();
  });
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);

  return async () => {
    const deadline = performance.now() + PAGE_TIMEOUT_MS;

    while (counter.inFlight > 0 || performance.now() - counter.changedAt < NETWORK_QUIET_MS) {
      if (performance.now() > deadline) {
        throw new Error(`${url} did not go network-quiet within ${PAGE_TIMEOUT_MS} ms`);
      }

      await delay(QUIET_POLL_MS);
    }
  };
}

/**
 * Runs in the page: scrolls down one viewport height, instantly whatever
 * the page's `scroll-behavior`, waits until the page has rendered there,
 * and says whether the bottom is in view.
 *
 * The wait is an `IntersectionObserver`'s first callback, which the
 * browser delivers from its own rendering update, the same one that fires
 * the lazy-load observers. `requestAnimationFrame` would not do: the
 * installed page clock replaces it with a timer.
 */
async function scrollOneViewportInPage(): Promise<boolean> {
  window.scrollTo({ top: window.scrollY + window.innerHeight, behavior: 'instant' });
  await new Promise<void>((resolve) => {
    const observer = new IntersectionObserver(() => {
      observer.disconnect();
      resolve();
    });

    observer.observe(document.documentElement);
  });

  return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight;
}

/** Runs in the page: scrolls back to the top, instantly. */
function scrollToTopInPage(): void {
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/**
 * Scrolls down to the bottom one viewport at a time, then back to the
 * top. The page renders at every position before the next step, so its
 * lazy-load observers see each one; one script that scrolls down and
 * straight back up renders neither end.
 */
async function scrollThroughPage(page: Page): Promise<void> {
  for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
    if (await page.evaluate(scrollOneViewportInPage)) {
      break;
    }
  }

  await page.evaluate(scrollToTopInPage);
}

/**
 * Opens `target` in a fresh Chromium context of `browser` under the shared
 * capture settings, runs the load waits, hands the loaded page to `use`,
 * and closes the context whatever `use` does.
 *
 * @param browser - A launched Chromium browser.
 * @param target - The server, page path and viewport to load.
 * @param use - Reads the loaded page; its result is passed through.
 * @returns What `use` resolved to.
 * @throws Error when the page does not load, or does not go network-idle
 * or network-quiet, within `PAGE_TIMEOUT_MS`.
 */
export async function withLoadedPage<T>(
  browser: Browser,
  target: CaptureTarget,
  use: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext(contextOptions(target.viewport));

  try {
    await context.addInitScript(SEEDED_RANDOM_SCRIPT);

    const page = await context.newPage();
    const url = checkUrl(target.address, target.path);

    await page.clock.install({ time: FIXED_EPOCH });

    const networkQuiet = trackNetwork(page, url);

    await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await scrollThroughPage(page);
    await networkQuiet();

    return await use(page);
  } finally {
    await context.close();
  }
}

/** Takes a loaded page's full-page screenshot with animations left running. */
function screenshotFullPage(page: Page): Promise<Buffer> {
  return page.screenshot({
    fullPage: true,
    animations: SCREENSHOT_ANIMATIONS,
    timeout: PAGE_TIMEOUT_MS,
  });
}

/**
 * Captures `target` once: loads it with {@link withLoadedPage} and takes a
 * full-page screenshot with animations left running.
 *
 * @param browser - A launched Chromium browser.
 * @param target - The server, page path and viewport to capture.
 * @returns The full-page PNG.
 * @throws Error when the page does not load or settle, as {@link withLoadedPage}.
 */
export async function capturePage(browser: Browser, target: CaptureTarget): Promise<Buffer> {
  return withLoadedPage(browser, target, screenshotFullPage);
}

/** A double capture, plus what was read from the first capture's page. */
export interface InspectedCapture<T> {
  /** What the two captures gave, as {@link doubleCapture}. */
  readonly result: DoubleCaptureResult;
  /** What `inspect` resolved to. */
  readonly inspected: T;
}

/** `captured` with `first` when the two PNGs agree, else `flaky` with their diff. */
function compareCaptures(first: Buffer, second: Buffer): DoubleCaptureResult {
  const diff = diffPngs(first, second);

  return diff.differingPixels === 0
    ? { status: 'captured', png: first }
    : { status: 'flaky', diff };
}

/**
 * Captures `target` twice, as {@link doubleCapture}, and in the first
 * capture's context runs `inspect` on the loaded page straight after the
 * load waits and before the screenshot.
 *
 * @param browser - A launched Chromium browser.
 * @param target - The server, page path and viewport to capture.
 * @param inspect - Reads the first capture's loaded page, such as
 *   `readAnimationInventory`.
 * @returns The double capture's result and what `inspect` resolved to.
 * @throws Error when either capture fails, as {@link capturePage}, or
 * whatever `inspect` throws.
 */
export async function doubleCaptureInspecting<T>(
  browser: Browser,
  target: CaptureTarget,
  inspect: (page: Page) => Promise<T>,
): Promise<InspectedCapture<T>> {
  const first = await withLoadedPage(browser, target, async (page) => ({
    inspected: await inspect(page),
    png: await screenshotFullPage(page),
  }));
  const second = await capturePage(browser, target);

  return { result: compareCaptures(first.png, second), inspected: first.inspected };
}

/**
 * Captures `target` twice, one capture after the other, each in a fresh
 * context, and compares the two pixel for pixel.
 *
 * @param browser - A launched Chromium browser.
 * @param target - The server, page path and viewport to capture.
 * @returns `captured` with the PNG when the captures are identical, else
 * `flaky` with the differing-pixel count and the box enclosing them.
 * @throws Error when either capture fails, as {@link capturePage}.
 */
export async function doubleCapture(browser: Browser, target: CaptureTarget): Promise<DoubleCaptureResult> {
  const first = await capturePage(browser, target);
  const second = await capturePage(browser, target);

  return compareCaptures(first, second);
}
