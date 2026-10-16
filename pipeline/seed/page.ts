/**
 * Loading a served page for seed and giving its in-page readers one shared
 * unique-selector builder.
 *
 * {@link withSeedPage} loads a page through `withLoadedPage` at
 * {@link SEED_VIEWPORT}, so seed reads the same rendered DOM, under the
 * same capture settings and load waits, that the baseline captured,
 * markers an export adds from script included.
 *
 * Functions passed to `page.evaluate` are sent as source and cannot import
 * helpers, so {@link installUniqueSelector} evaluates the builder once per
 * loaded page to define it as the page-global function named
 * {@link UNIQUE_SELECTOR_GLOBAL}. A reader takes that name as an argument
 * and calls the global, and so stays self-contained.
 *
 * A built selector is a CSS path in the style of the baseline animation
 * inventory's selector path: `>`-separated steps from the top down, each
 * the tag name, then `:nth-of-type(n)` when a sibling shares the tag. An
 * element whose id no other element of the document carries is written as
 * `tag#id` and starts the path, so nothing above it is named; a duplicated
 * id is never used. The path follows parent elements only, so an element
 * inside a shadow root is named from the shadow root's top element down.
 *
 * @packageDocumentation
 */

import type { CaptureViewport } from '../baseline/settings.ts';
import type { Browser, Page } from 'playwright';

import { withLoadedPage } from '../baseline/capture.ts';

/** The viewport every seed read loads a page at. */
export const SEED_VIEWPORT: CaptureViewport = { name: 'seed', width: 1280, height: 800 };

/** The name of the page-global function {@link installUniqueSelector} defines. */
export const UNIQUE_SELECTOR_GLOBAL = '__d2cUniqueSelector';

/** The page-global builder: the unique CSS path of `element` in its document. */
export type UniqueSelector = (element: Element) => string;

/**
 * Opens `pagePath` of the server at `address` in a fresh Chromium context
 * of `browser` at {@link SEED_VIEWPORT}, through `withLoadedPage`, hands
 * the loaded page to `use`, and closes the context whatever `use` does.
 *
 * @param browser - A launched Chromium browser.
 * @param address - The running server's base URL, such as `http://127.0.0.1:4600/`.
 * @param pagePath - The page path as `discovery.json` lists it.
 * @param use - Reads the loaded page; its result is passed through.
 * @returns What `use` resolved to.
 * @throws Error when the page does not load or settle, as `withLoadedPage`.
 */
export function withSeedPage<T>(
  browser: Browser,
  address: string,
  pagePath: string,
  use: (page: Page) => Promise<T>,
): Promise<T> {
  return withLoadedPage(browser, { address, path: pagePath, viewport: SEED_VIEWPORT }, use);
}

/**
 * Runs in the page: defines the unique-selector builder as the global
 * `name`. Self-contained, since Playwright sends its source to the page.
 */
function defineUniqueSelectorInPage(name: string): void {
  const hasUniqueId = (element: Element): boolean => element.id !== ''
    && element.ownerDocument.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1;
  const step = (element: Element): string => {
    const tag = element.localName;
    const siblings = element.parentElement === null
      ? []
      : [...element.parentElement.children].filter((sibling) => sibling.localName === tag);

    return siblings.length > 1
      ? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
      : tag;
  };
  const build = (element: Element): string => {
    const steps: string[] = [];

    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      if (hasUniqueId(current)) {
        steps.unshift(`${current.localName}#${CSS.escape(current.id)}`);

        break;
      }

      steps.unshift(step(current));
    }

    return steps.join(' > ');
  };

  Object.defineProperty(window, name, { value: build, configurable: true, writable: true });
}

/**
 * Defines the unique-selector builder on the loaded `page` as the global
 * function {@link UNIQUE_SELECTOR_GLOBAL}. Call it once after the page has
 * loaded, before any reader that calls the global; a navigation drops it.
 *
 * @param page - A page loaded by {@link withSeedPage}.
 */
export async function installUniqueSelector(page: Page): Promise<void> {
  await page.evaluate(defineUniqueSelectorInPage, UNIQUE_SELECTOR_GLOBAL);
}
