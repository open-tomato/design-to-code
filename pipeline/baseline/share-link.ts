/**
 * The share-link comparison confirm runs before it asks a person: whether
 * `source.shareLink` is public, where the design frame sits in a page's
 * Claude Design view, and how far that frame differs from the served page.
 *
 * {@link checkShareLink} loads the link in a fresh Chromium context with no
 * cookies or storage. The link is public when that load answers 2xx and
 * ends on the link's own origin; a load that ends on another origin is a
 * login redirect, whatever status the login page answers. A redirect made
 * by script after the `load` event is not seen.
 *
 * A page's Claude Design view is {@link designViewUrl}: the page path,
 * each segment percent-encoded, resolved against the share link as a
 * relative URL, so a link ending in `/` gains the path and one that does
 * not has its last segment replaced. {@link locateDesignFrame} takes the
 * design frame to be the largest visible `iframe` of the view's own
 * document, measured by the area of its content box inside the viewport.
 *
 * {@link scoreSharedPage} loads the view at one viewport under the shared
 * capture settings (`contextOptions`, the seeded `Math.random`, the page
 * clock at `FIXED_EPOCH`), waits for the view and the frame to go
 * network-idle and for the frame's fonts, and screenshots the frame's
 * visible content box. It then loads the served page with
 * `withLoadedPage` at a viewport the size of the frame's content box, so
 * the page lays out as it does inside the frame, and screenshots the same
 * part of it. The score is the share of differing pixels between the two,
 * as `diffPngs` counts them (zero tolerance), and a score under
 * {@link CONFIRM_THRESHOLD} passes. A matching page does not score zero:
 * text drawn inside a cross-origin frame differs slightly from the same
 * text drawn top-level, so every glyph edge can count. On the `spaced`
 * fixture's short heading and greeting at a 1040 by 752 frame that came to
 * about 0.3%, and changing its heading from `v2` to `v3` also scored
 * about 0.3%, under the threshold. A view that does not load publicly, or
 * whose document or frame does not go network-idle or read its fonts, is
 * `view-unreachable`; a view with no visible
 * `iframe` is `frame-not-found`. Either way confirm falls back to a person.
 *
 * @packageDocumentation
 */

import type { CaptureViewport } from './settings.ts';
import type { Browser, BrowserContext, Page } from 'playwright';

import { PAGE_TIMEOUT_MS } from '../serve/check.ts';

import { withLoadedPage } from './capture.ts';
import { diffPngs } from './diff.ts';
import {
  contextOptions,
  FIXED_EPOCH,
  SCREENSHOT_ANIMATIONS,
  SEEDED_RANDOM_SCRIPT,
} from './settings.ts';

/** The share of differing pixels a page must score under to be confirmed by the share link. */
export const CONFIRM_THRESHOLD = 0.01;

/** Why a URL did not load publicly. */
export type NotPublicReason = 'cross-origin' | 'status' | 'unreachable';

/** A share link an unauthenticated load reaches. */
export interface PublicAccess {
  readonly status: 'public';
}

/** A share link an unauthenticated load does not reach. */
export interface NotPublicAccess {
  readonly status: 'not-public';
  /** Ended on another origin, answered outside 2xx, or never answered. */
  readonly reason: NotPublicReason;
  /** The other origin, the status, or the browser's error. */
  readonly detail: string;
}

/** What {@link checkShareLink} found. */
export type ShareLinkAccess = NotPublicAccess | PublicAccess;

/** A rectangle in CSS pixels, its origin at the viewport's top-left corner. */
export interface FrameBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The design frame {@link locateDesignFrame} found. */
export interface DesignFrame {
  /** Its index among the view document's `iframe` elements, in document order. */
  readonly index: number;
  /** Its content box: the border box less borders and padding. */
  readonly box: FrameBox;
}

/** One kept page to score against its Claude Design view. */
export interface ShareScoreTarget {
  /** The project's `source.shareLink`. */
  readonly shareLink: string;
  /** The running server's base URL, such as `http://127.0.0.1:4600/`. */
  readonly address: string;
  /** The page path as `discovery.json` lists it. */
  readonly path: string;
  /** The viewport the view is loaded at. */
  readonly viewport: CaptureViewport;
}

/** A page whose design frame was found and compared. */
export interface ScoredPage {
  readonly status: 'scored';
  /** The Claude Design view's URL. */
  readonly view: string;
  /** The share of differing pixels, from 0 to 1. */
  readonly score: number;
  /** Whether {@link score} is under {@link CONFIRM_THRESHOLD}. */
  readonly passed: boolean;
  /** The part of the frame that was compared, in whole view pixels. */
  readonly region: FrameBox;
}

/** A page whose view loaded but holds no visible `iframe`. */
export interface FrameNotFound {
  readonly status: 'frame-not-found';
  /** The Claude Design view's URL. */
  readonly view: string;
}

/** A page whose view did not load publicly or did not settle. */
export interface ViewUnreachable {
  readonly status: 'view-unreachable';
  /** The Claude Design view's URL. */
  readonly view: string;
  /** Why the view did not load; `unreachable` also covers a view or frame that never settled. */
  readonly reason: NotPublicReason;
  /** The other origin, the status, or the browser's error. */
  readonly detail: string;
}

/** What {@link scoreSharedPage} found. */
export type PageScore = FrameNotFound | ScoredPage | ViewUnreachable;

/** The error's message, or its string form when it is not an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

/**
 * Navigates `page` to `url` and reports whether it loaded publicly: 2xx
 * and still on `url`'s origin once `load` has fired.
 */
async function openPublicly(page: Page, url: string): Promise<ShareLinkAccess> {
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    const landed = new URL(page.url()).origin;

    if (landed !== new URL(url).origin) {
      return { status: 'not-public', reason: 'cross-origin', detail: landed };
    }

    if (response === null || !response.ok()) {
      return { status: 'not-public', reason: 'status', detail: String(response?.status() ?? 'no response') };
    }

    return { status: 'public' };
  } catch (error) {
    return { status: 'not-public', reason: 'unreachable', detail: messageOf(error) };
  }
}

/** Runs `use` in a fresh context of `browser` built with `options`, closing it whatever `use` does. */
async function inFreshContext<T>(
  browser: Browser,
  options: Parameters<Browser['newContext']>[0],
  use: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext(options);

  try {
    return await use(context);
  } finally {
    await context.close();
  }
}

/**
 * Decides whether `shareLink` is public: loads it in a fresh Chromium
 * context with no cookies or storage.
 *
 * @param browser - A launched Chromium browser.
 * @param shareLink - The project's `source.shareLink`.
 * @returns `public`, or `not-public` with `cross-origin` and the origin the
 * load ended on, `status` and the status answered, or `unreachable` and
 * the browser's error.
 */
export async function checkShareLink(browser: Browser, shareLink: string): Promise<ShareLinkAccess> {
  return inFreshContext(browser, {}, async (context) => openPublicly(await context.newPage(), shareLink));
}

/**
 * The Claude Design view of page `path`: the path, each segment
 * percent-encoded, resolved against `shareLink` behind a leading `./`, so
 * a path starting with `/` or `//` extends the link's path instead of
 * replacing its root or its host.
 *
 * @param shareLink - The project's `source.shareLink`.
 * @param path - The page path as `discovery.json` lists it.
 * @returns The view's absolute URL.
 */
export function designViewUrl(shareLink: string, path: string): string {
  const encoded = path
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  return new URL(`./${encoded}`, shareLink).href;
}

/**
 * Runs in the page: the largest visible `iframe` of the document by the
 * area of its content box inside the viewport, or `null` when none shows.
 * Visible means `checkVisibility` with opacity and visibility checked.
 */
function largestVisibleFrameInPage(): { index: number; box: FrameBox } | null {
  const frames = document.querySelectorAll('iframe');
  let best: { index: number; box: FrameBox; area: number } | null = null;

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames.item(index);

    if (!frame.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      continue;
    }

    const style = getComputedStyle(frame);
    const rect = frame.getBoundingClientRect();
    const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const right = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
    const bottom = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
    const box = { x: rect.left + left, y: rect.top + top, width: rect.width - left - right, height: rect.height - top - bottom };
    const shownWidth = Math.min(box.x + box.width, window.innerWidth) - Math.max(box.x, 0);
    const shownHeight = Math.min(box.y + box.height, window.innerHeight) - Math.max(box.y, 0);
    const area = Math.max(shownWidth, 0) * Math.max(shownHeight, 0);

    if (area > 0 && (best === null || area > best.area)) {
      best = { index, box, area };
    }
  }

  return best === null
    ? null
    : { index: best.index, box: best.box };
}

/**
 * Finds the design frame in a loaded Claude Design view: the largest
 * visible `iframe` of the view's own document.
 *
 * @param page - The loaded view.
 * @returns The frame's index and content box, or `null` when no `iframe`
 * shows inside the viewport.
 */
export async function locateDesignFrame(page: Page): Promise<DesignFrame | null> {
  return page.evaluate(largestVisibleFrameInPage);
}

/** `box` rounded to whole pixels and cut to a `width` by `height` viewport, or `null` when nothing is left. */
function visibleRegion(box: FrameBox, width: number, height: number): FrameBox | null {
  const left = Math.max(Math.round(box.x), 0);
  const top = Math.max(Math.round(box.y), 0);
  const right = Math.min(Math.round(box.x + box.width), width);
  const bottom = Math.min(Math.round(box.y + box.height), height);

  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/** The design side of a comparison: the frame's screenshot and where it came from. */
type DesignShot =
  | { readonly status: 'shot'; readonly png: Buffer; readonly frame: FrameBox; readonly region: FrameBox }
  | { readonly status: 'frame-not-found' }
  | { readonly status: 'view-unreachable'; readonly reason: NotPublicReason; readonly detail: string };

/** Waits for the design frame at `index` to go network-idle and for its fonts. */
async function settleFrame(page: Page, index: number): Promise<void> {
  const handle = await page.evaluateHandle((at) => document.querySelectorAll('iframe')[at], index);
  const frame = await handle.asElement()?.contentFrame();

  await handle.dispose();

  if (!frame) {
    return;
  }

  await frame.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS });
  await frame.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** Loads `view` at `viewport` under the capture settings and screenshots its design frame. */
async function shootDesignFrame(browser: Browser, view: string, viewport: CaptureViewport): Promise<DesignShot> {
  return inFreshContext(browser, contextOptions(viewport), async (context) => {
    await context.addInitScript(SEEDED_RANDOM_SCRIPT);

    const page = await context.newPage();

    await page.clock.install({ time: FIXED_EPOCH });

    const access = await openPublicly(page, view);

    if (access.status === 'not-public') {
      return { status: 'view-unreachable', reason: access.reason, detail: access.detail };
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS });
    } catch (error) {
      return { status: 'view-unreachable', reason: 'unreachable', detail: messageOf(error) };
    }

    const found = await locateDesignFrame(page);
    const region = found === null
      ? null
      : visibleRegion(found.box, viewport.width, viewport.height);

    if (found === null || region === null) {
      return { status: 'frame-not-found' };
    }

    try {
      await settleFrame(page, found.index);
    } catch (error) {
      return { status: 'view-unreachable', reason: 'unreachable', detail: messageOf(error) };
    }

    const png = await page.screenshot({ clip: region, animations: SCREENSHOT_ANIMATIONS, timeout: PAGE_TIMEOUT_MS });

    return { status: 'shot', png, frame: found.box, region };
  });
}

/**
 * Scores page `target.path` against its Claude Design view at
 * `target.viewport`: screenshots the design frame's visible content box,
 * screenshots the same part of the served page laid out at the frame's
 * size, and counts the differing pixels.
 *
 * @param browser - A launched Chromium browser.
 * @param target - The share link, the running server, the page path and
 *   the viewport.
 * @returns `scored` with the share of differing pixels and whether it is
 * under {@link CONFIRM_THRESHOLD}, `frame-not-found`, or
 * `view-unreachable` with the reason.
 * @throws Error when the served page does not load or settle, as
 * `withLoadedPage`.
 */
export async function scoreSharedPage(browser: Browser, target: ShareScoreTarget): Promise<PageScore> {
  const view = designViewUrl(target.shareLink, target.path);
  const design = await shootDesignFrame(browser, view, target.viewport);

  if (design.status === 'frame-not-found') {
    return { status: 'frame-not-found', view };
  }

  if (design.status === 'view-unreachable') {
    return { status: 'view-unreachable', view, reason: design.reason, detail: design.detail };
  }

  const frameViewport: CaptureViewport = {
    name: target.viewport.name,
    width: Math.round(design.frame.width),
    height: Math.round(design.frame.height),
  };
  const clip = {
    x: design.region.x - Math.round(design.frame.x),
    y: design.region.y - Math.round(design.frame.y),
    width: design.region.width,
    height: design.region.height,
  };
  const served = await withLoadedPage(
    browser,
    { address: target.address, path: target.path, viewport: frameViewport },
    (page) => page.screenshot({ clip, animations: SCREENSHOT_ANIMATIONS, timeout: PAGE_TIMEOUT_MS }),
  );
  const { differingPixels } = diffPngs(design.png, served);
  const score = differingPixels / (design.region.width * design.region.height);

  return { status: 'scored', view, score, passed: score < CONFIRM_THRESHOLD, region: design.region };
}
