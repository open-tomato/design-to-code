/**
 * Tests for `share-link.ts`: the URL resolution alone, the frame finder
 * over pages set in headless Chromium, and the public check and the score
 * against local stand-ins from `share-link-stand-in.ts`.
 *
 * Two temporary copies of the `spaced` fixture are served by `startServer`:
 * the served copy, which confirm compares, and the design copy, which the
 * stand-in's view holds in its frame. The served copy of
 * `Rafa Portal v2.dc.html` gains a coloured background, so that page is
 * changed against its design; `Rafa Portal.dc.html` is left the same in
 * both. The fixture is tracked and never modified: every run copies it.
 *
 * @packageDocumentation
 */

import type { CaptureViewport } from './settings.ts';
import type { RunningStandIn } from './share-link-stand-in.ts';
import type { RunningServer } from '../serve/server.ts';
import type { Browser, Page } from 'playwright';

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startServer } from '../serve/server.ts';

import { withLoadedPage } from './capture.ts';
import { diffPngs } from './diff.ts';
import { contextOptions } from './settings.ts';
import { HEADER_HEIGHT, SIDE_PANEL_WIDTH, startStandIn } from './share-link-stand-in.ts';
import {
  CONFIRM_THRESHOLD,
  checkShareLink,
  designViewUrl,
  locateDesignFrame,
  scoreSharedPage,
} from './share-link.ts';

const SPACED_FIXTURE = join(import.meta.dirname, '..', 'serve', 'fixtures', 'spaced');

/** A browser launch plus two page loads, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const VIEWPORT: CaptureViewport = { name: 'desktop', width: 1280, height: 800 };

/** The page left the same in the served and design copies. */
const MATCHING_PAGE = 'Rafa Portal.dc.html';

/** The page whose served copy gains a coloured background. */
const CHANGED_PAGE = 'Rafa Portal v2.dc.html';

/** The style the served copy of {@link CHANGED_PAGE} gains before `</head>`. */
const CHANGE_STYLE = '<style>body { background: rgb(29, 78, 216); }</style>';

/** The status the unauthorized stand-in answers. */
const UNAUTHORIZED = 401;

let workDir: string;
let served: RunningServer;
let design: RunningServer;
let framed: RunningStandIn;
let frameless: RunningStandIn;
let loginWall: RunningStandIn;
let redirecting: RunningStandIn;
let unauthorized: RunningStandIn;
let stopped: RunningStandIn;
let browser: Browser;

/** Copies the `spaced` fixture to `name` under the work dir. */
function copyFixture(name: string): string {
  const dir = join(workDir, name);

  cpSync(SPACED_FIXTURE, dir, { recursive: true });

  return dir;
}

/** Runs `use` on a fresh page of `browser` at {@link VIEWPORT}. */
async function withPage<T>(use: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext(contextOptions(VIEWPORT));

  try {
    return await use(await context.newPage());
  } finally {
    await context.close();
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-share-link-test-'));

  const servedDir = copyFixture('served');
  const designDir = copyFixture('design');
  const changedFile = join(servedDir, CHANGED_PAGE);

  writeFileSync(changedFile, readFileSync(changedFile, 'utf8').replace('</head>', `${CHANGE_STYLE}\n</head>`));

  served = await startServer({ sourceDir: servedDir, env: {}, port: 0 });
  design = await startServer({ sourceDir: designDir, env: {}, port: 0 });
  framed = await startStandIn({ mode: 'design', designAddress: design.address, frame: true });
  frameless = await startStandIn({ mode: 'design', designAddress: design.address, frame: false });
  loginWall = await startStandIn({ mode: 'login', status: 200 });
  redirecting = await startStandIn({ mode: 'redirect', location: loginWall.address });
  unauthorized = await startStandIn({ mode: 'login', status: UNAUTHORIZED });
  stopped = await startStandIn({ mode: 'login', status: 200 });
  await stopped.stop();
  browser = await chromium.launch();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  await Promise.all([framed, frameless, loginWall, redirecting, unauthorized].map((standIn) => standIn.stop()));
  await served.stop();
  await design.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe('designViewUrl', () => {
  test('resolves a page path with spaces below a share link ending in a slash', () => {
    expect(designViewUrl('https://claude.ai/design/p/abc/', 'app parts/Rafa Portal.dc.html'))
      .toBe('https://claude.ai/design/p/abc/app%20parts/Rafa%20Portal.dc.html');
  });

  test('replaces the last segment of a share link with no trailing slash', () => {
    expect(designViewUrl('https://claude.ai/design/p/abc', 'index.html')).toBe('https://claude.ai/design/p/index.html');
  });

  test('keeps a path starting with // on the share link\'s host', () => {
    expect(designViewUrl('https://claude.ai/design/p/abc/', '//evil.example/index.html'))
      .toBe('https://claude.ai/design/p/abc///evil.example/index.html');
  });
});

describe('locateDesignFrame', () => {
  test('picks the largest visible iframe and reports its content box', async () => {
    const found = await withPage(async (page) => {
      await page.setContent([
        '<body style="margin: 0">',
        '<iframe srcdoc="thumb" style="position: absolute; left: 0; top: 0; width: 100px; height: 100px; border: 0"></iframe>',
        '<iframe srcdoc="design" style="position: absolute; left: 200px; top: 50px; width: 600px; height: 400px; border: 3px solid; padding: 5px"></iframe>',
        '<iframe srcdoc="hidden" style="position: absolute; inset: 0; width: 1280px; height: 800px; visibility: hidden"></iframe>',
        '<iframe srcdoc="transparent" style="position: absolute; inset: 0; width: 1280px; height: 800px; opacity: 0"></iframe>',
        '<iframe srcdoc="offscreen" style="position: absolute; left: -5000px; top: 0; width: 1280px; height: 800px"></iframe>',
        '</body>',
      ].join(''));

      return locateDesignFrame(page);
    });

    expect(found).toStrictEqual({ index: 1, box: { x: 208, y: 58, width: 600, height: 400 } });
  }, TEST_TIMEOUT_MS);

  test('finds no frame in a page with no iframe', async () => {
    const found = await withPage(async (page) => {
      await page.setContent('<body><div style="width: 600px; height: 400px">design</div></body>');

      return locateDesignFrame(page);
    });

    expect(found).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('checkShareLink', () => {
  test('reports a stand-in project that answers 200 on its own origin as public', async () => {
    expect(await checkShareLink(browser, framed.shareLink)).toStrictEqual({ status: 'public' });
  }, TEST_TIMEOUT_MS);

  test('reports a redirect to a login wall on another origin as not public', async () => {
    expect(await checkShareLink(browser, redirecting.shareLink)).toStrictEqual({
      status: 'not-public',
      reason: 'cross-origin',
      detail: new URL(loginWall.address).origin,
    });
  }, TEST_TIMEOUT_MS);

  test('control: the login wall itself answers 200, so the verdict above is the origin\'s', async () => {
    expect(await checkShareLink(browser, loginWall.shareLink)).toStrictEqual({ status: 'public' });
  }, TEST_TIMEOUT_MS);

  test('reports a link answering 401 as not public, naming the status', async () => {
    expect(await checkShareLink(browser, unauthorized.shareLink))
      .toStrictEqual({ status: 'not-public', reason: 'status', detail: String(UNAUTHORIZED) });
  }, TEST_TIMEOUT_MS);

  test('reports a link nothing answers as unreachable, with the browser\'s error', async () => {
    const access = await checkShareLink(browser, stopped.shareLink);

    expect(access).toMatchObject({ status: 'not-public', reason: 'unreachable' });
    expect(access.status === 'not-public' && access.detail).toContain('ERR_CONNECTION_REFUSED');
  }, TEST_TIMEOUT_MS);
});

describe('scoreSharedPage', () => {
  test('scores a matching page under the threshold, cropped to the frame inside the chrome', async () => {
    const score = await scoreSharedPage(browser, {
      shareLink: framed.shareLink,
      address: served.address,
      path: MATCHING_PAGE,
      viewport: VIEWPORT,
    });

    expect(score).toMatchObject({
      status: 'scored',
      view: designViewUrl(framed.shareLink, MATCHING_PAGE),
      passed: true,
      region: {
        x: SIDE_PANEL_WIDTH,
        y: HEADER_HEIGHT,
        width: VIEWPORT.width - SIDE_PANEL_WIDTH,
        height: VIEWPORT.height - HEADER_HEIGHT,
      },
    });
    expect(score.status === 'scored' && score.score).toBeLessThan(CONFIRM_THRESHOLD);
  }, TEST_TIMEOUT_MS);

  test('control: the same page compared uncropped, chrome and all, scores over the threshold', async () => {
    const view = await withPage(async (page) => {
      await page.goto(designViewUrl(framed.shareLink, MATCHING_PAGE));
      await page.waitForLoadState('networkidle');

      return page.screenshot();
    });
    const page = await withLoadedPage(browser, { address: served.address, path: MATCHING_PAGE, viewport: VIEWPORT }, (loaded) => loaded.screenshot());
    const { differingPixels } = diffPngs(view, page);

    expect(differingPixels / (VIEWPORT.width * VIEWPORT.height)).toBeGreaterThan(CONFIRM_THRESHOLD);
  }, TEST_TIMEOUT_MS);

  test('scores a changed page over the threshold', async () => {
    const score = await scoreSharedPage(browser, {
      shareLink: framed.shareLink,
      address: served.address,
      path: CHANGED_PAGE,
      viewport: VIEWPORT,
    });

    expect(score).toMatchObject({ status: 'scored', passed: false });
    expect(score.status === 'scored' && score.score).toBeGreaterThan(CONFIRM_THRESHOLD);
  }, TEST_TIMEOUT_MS);

  test('control: the changed page\'s design copy, served, scores under the threshold', async () => {
    const score = await scoreSharedPage(browser, {
      shareLink: framed.shareLink,
      address: design.address,
      path: CHANGED_PAGE,
      viewport: VIEWPORT,
    });

    expect(score).toMatchObject({ status: 'scored', passed: true });
  }, TEST_TIMEOUT_MS);

  test('reports a view with no iframe as frame-not-found', async () => {
    const score = await scoreSharedPage(browser, {
      shareLink: frameless.shareLink,
      address: served.address,
      path: MATCHING_PAGE,
      viewport: VIEWPORT,
    });

    expect(score).toStrictEqual({ status: 'frame-not-found', view: designViewUrl(frameless.shareLink, MATCHING_PAGE) });
  }, TEST_TIMEOUT_MS);

  test('reports a view that redirects to a login wall as view-unreachable', async () => {
    const score = await scoreSharedPage(browser, {
      shareLink: redirecting.shareLink,
      address: served.address,
      path: MATCHING_PAGE,
      viewport: VIEWPORT,
    });

    expect(score).toStrictEqual({
      status: 'view-unreachable',
      view: designViewUrl(redirecting.shareLink, MATCHING_PAGE),
      reason: 'cross-origin',
      detail: new URL(loginWall.address).origin,
    });
  }, TEST_TIMEOUT_MS);
});
