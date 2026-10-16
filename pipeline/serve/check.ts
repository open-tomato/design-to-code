/**
 * The serve verb's health check: loads every kept page of a running server
 * headless and records what went wrong in `<source.dir>/serve-check.json`.
 *
 * {@link checkPages} reads `discovery.json`, keeps every page that
 * `pages.discard` does not list, and loads each one in headless Chromium at
 * the server's address with `?d2c-nav=0`, so the nav bar is never part of
 * what is checked. Every page gets a fresh browser context, so no page
 * passes only because a sibling filled the cache, storage or cookies first.
 * For each page it records console `error` messages and uncaught page
 * errors, requests that failed or answered 400 or above, and whether the
 * page rendered blank.
 *
 * The report is validated by {@link serveCheckReportSchema} (strict objects,
 * like `pipeline/assess/schema.ts`) before it is written, at the top level
 * of `source.dir` beside `discovery.json`; the assess walk skips it. The
 * check reports problems; it never changes a file of the export.
 *
 * @packageDocumentation
 */

import type { PagesConfig } from './nav.ts';
import type { Browser, Page } from 'playwright';

import { readFileSync, writeFileSync } from 'node:fs';

import { chromium } from 'playwright';
import { z } from 'zod';

import { discoveryPath } from '../assess/discover.ts';
import { discoveryReportSchema, relativePath, sortedByPath } from '../assess/schema.ts';
import { SERVE_CHECK_FILE } from '../assess/walk.ts';

import { NAV_OFF_VALUE, NAV_QUERY_PARAM } from './nav.ts';
import { sourceDirFile } from './serve-record.ts';

/** The lowest response status recorded as a failed request. */
export const FAILED_STATUS = 400;

/** How long one page may take to load, then to go network-idle, in milliseconds. */
export const PAGE_TIMEOUT_MS = 15_000;

/** The command that writes the `discovery.json` the kept pages are read from. */
const DISCOVERY_COMMAND = 'bun run d2c assess --scripts-only';

/** A request that never got a response, with the browser's reason. */
const abortedRequestSchema = z.strictObject({
  url: z.string().min(1),
  reason: z.string().min(1),
});

/** A request whose response had a status of {@link FAILED_STATUS} or above. */
const errorResponseSchema = z.strictObject({
  url: z.string().min(1),
  status: z.int().min(FAILED_STATUS)
    .max(599),
});

/**
 * One kept page's reading.
 *
 * - `path` — the page path as `discovery.json` lists it.
 * - `consoleErrors` — console `error` messages and uncaught page errors, in
 *   the order they arrived.
 * - `failedRequests` — `{ url, reason }` for a request that failed and
 *   `{ url, status }` for a response of 400 or above, in arrival order.
 * - `blank` — true when the body renders no visible text, image, SVG or
 *   canvas with a non-zero box after load and network idle.
 */
const pageCheckSchema = z.strictObject({
  path: relativePath,
  consoleErrors: z.array(z.string()),
  failedRequests: z.array(z.union([abortedRequestSchema, errorResponseSchema])),
  blank: z.boolean(),
});

/**
 * Validates a whole `serve-check.json`: when it was generated, the server
 * address checked, and one entry per kept page, sorted by path with no
 * duplicates.
 */
export const serveCheckReportSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  address: z.url({ protocol: /^https?$/ }),
  pages: sortedByPath(pageCheckSchema),
});

/** A parsed `serve-check.json`. */
export type ServeCheckReport = z.infer<typeof serveCheckReportSchema>;

/** One kept page's reading in a {@link ServeCheckReport}. */
export type PageCheck = ServeCheckReport['pages'][number];

/** One failed request in a {@link PageCheck}. */
export type FailedRequest = PageCheck['failedRequests'][number];

/** Options for {@link checkPages}. */
export interface CheckPagesOptions {
  /** The served directory: the project's `source.dir`. */
  readonly sourceDir: string;
  /** The running server's base URL, such as `http://127.0.0.1:4600/`. */
  readonly address: string;
  /** The config's `pages`; only `pages.discard` leaves a page out. */
  readonly pages: PagesConfig;
  /** The clock `generatedAt` is read from; the current time by default. */
  readonly now?: () => Date;
}

/** The absolute path of `<sourceDir>/serve-check.json`. */
export function serveCheckPath(sourceDir: string): string {
  return sourceDirFile(sourceDir, SERVE_CHECK_FILE);
}

/** Whether no page of `report` has a console error, a failed request or a blank render. */
export function isCleanReport(report: ServeCheckReport): boolean {
  return report.pages.every((page) => page.consoleErrors.length === 0
    && page.failedRequests.length === 0
    && !page.blank);
}

/**
 * The page paths `discovery.json` lists that `pages.discard` does not,
 * sorted by path.
 *
 * @throws Error naming the assess step when there is no `discovery.json`,
 * or the parse error when it is not valid JSON or fails its schema.
 */
export function keptPages(sourceDir: string, pages: PagesConfig): readonly string[] {
  let text: string;

  try {
    text = readFileSync(discoveryPath(sourceDir), 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read discovery.json in ${sourceDir}; run \`${DISCOVERY_COMMAND}\` first: ${(error as Error).message}`,
      { cause: error },
    );
  }

  const discarded = new Set(pages?.discard ?? []);

  return discoveryReportSchema.parse(JSON.parse(text)).pages
    .map((page) => page.path)
    .filter((path) => !discarded.has(path))
    .sort();
}

/** The URL of page `path` under `address`, each segment percent-encoded, with the nav bar off. */
export function checkUrl(address: string, path: string): string {
  const encoded = path
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  return new URL(`${encoded}?${NAV_QUERY_PARAM}=${NAV_OFF_VALUE}`, address).href;
}

/**
 * Runs in the page: whether the body renders no visible text, image, SVG
 * or canvas with a non-zero box. A page with no body is blank.
 */
function isBlankInPage(): boolean {
  const { body } = document;

  if (!body) {
    return true;
  }

  const visibility = { opacityProperty: true, visibilityProperty: true };
  const hasBox = (box: DOMRect): boolean => box.width > 0 && box.height > 0;
  const shows = (element: Element | null): boolean => element !== null && element.checkVisibility(visibility);
  const media = [...body.querySelectorAll('img, svg, canvas')];

  if (media.some((element) => shows(element) && hasBox(element.getBoundingClientRect()))) {
    return false;
  }

  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent?.trim()) {
      range.selectNodeContents(node);

      if (shows(node.parentElement) && hasBox(range.getBoundingClientRect())) {
        return false;
      }
    }
  }

  return true;
}

/** Records console errors, uncaught errors and failed requests from `page` as they arrive. */
function recordProblems(page: Page, consoleErrors: string[], failedRequests: FailedRequest[]): void {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(String(error));
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({ url: request.url(), reason: request.failure()?.errorText ?? 'unknown failure' });
  });
  page.on('response', (response) => {
    if (response.status() >= FAILED_STATUS) {
      failedRequests.push({ url: response.url(), status: response.status() });
    }
  });
}

/**
 * Loads one page in a fresh context of `browser` and reads it.
 *
 * A navigation that throws (the server is gone, the load does not finish
 * within {@link PAGE_TIMEOUT_MS}) is recorded as a failed request for the
 * page's own URL unless the browser already reported one, and the page is
 * read as blank without looking at it: the export never rendered, and
 * Chromium's own error page would otherwise count as visible text. A page
 * that loads but never goes network-idle within {@link PAGE_TIMEOUT_MS} is
 * read as it stands once the wait runs out.
 */
async function checkPage(browser: Browser, address: string, path: string): Promise<PageCheck> {
  const context = await browser.newContext();
  const consoleErrors: string[] = [];
  const failedRequests: FailedRequest[] = [];

  try {
    const page = await context.newPage();
    const url = checkUrl(address, path);

    recordProblems(page, consoleErrors, failedRequests);

    try {
      await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    } catch (error) {
      if (!failedRequests.some((request) => request.url === url)) {
        failedRequests.push({ url, reason: (error as Error).message });
      }

      return { path, consoleErrors: [...consoleErrors], failedRequests: [...failedRequests], blank: true };
    }

    await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS })
      .catch(() => undefined);

    const blank = await page.evaluate(isBlankInPage);

    return { path, consoleErrors: [...consoleErrors], failedRequests: [...failedRequests], blank };
  } finally {
    await context.close();
  }
}

/**
 * Writes `report` to `<sourceDir>/serve-check.json` as indented JSON with a
 * trailing newline, after validating it.
 *
 * @throws ZodError when the report fails {@link serveCheckReportSchema};
 * nothing is written then.
 */
export function writeServeCheck(sourceDir: string, report: ServeCheckReport): ServeCheckReport {
  const valid = serveCheckReportSchema.parse(report);

  writeFileSync(serveCheckPath(sourceDir), `${JSON.stringify(valid, null, 2)}\n`);

  return valid;
}

/**
 * Checks every kept page ({@link keptPages}) of the server at `address`,
 * each in a fresh Chromium context with `?d2c-nav=0`, one after another,
 * and writes the report to `<sourceDir>/serve-check.json` whether or not a
 * page has a problem. The browser is launched here and closed before this
 * resolves.
 *
 * @returns The report as written.
 * @throws Error when `discovery.json` is missing or invalid, when Chromium
 * cannot be launched (install it with `bun run setup`), or when the report
 * fails its schema; nothing is written then.
 */
export async function checkPages(options: CheckPagesOptions): Promise<ServeCheckReport> {
  const { sourceDir, address, pages, now = () => new Date() } = options;
  const paths = keptPages(sourceDir, pages);
  const browser = await chromium.launch();
  const checks: PageCheck[] = [];

  try {
    for (const path of paths) {
      checks.push(await checkPage(browser, address, path));
    }
  } finally {
    await browser.close();
  }

  return writeServeCheck(sourceDir, { generatedAt: now().toISOString(), address, pages: checks });
}
