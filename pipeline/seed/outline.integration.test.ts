/**
 * Tests for `outline.ts`: small inline pages set straight into a blank
 * headless Chromium page and read by `readDomOutline`.
 *
 * Each skip is paired with a control that the skipped element is in the
 * DOM, so an outline that lacks it proves the walk left it out rather than
 * that it was never there. The budget test builds a page whose full
 * outline is far past `OUTLINE_BYTE_BUDGET`, and its control is a page
 * under the budget that comes back whole with `truncated: false`.
 *
 * @packageDocumentation
 */

import type { DomOutline, OutlineNode } from './outline.ts';
import type { Browser, Page } from 'playwright';

import { Buffer } from 'node:buffer';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  domOutlineSchema,
  OUTLINE_BYTE_BUDGET,
  readDomOutline,
  TEXT_SAMPLE_LENGTH,
} from './outline.ts';

/** A browser launch plus an inline page load, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

/** Enough `<p>` elements that their outline is several times the budget. */
const OVER_BUDGET_ELEMENTS = 2_000;

let browser: Browser;

/** Sets `body` into a blank page and hands the page to `use`, closing it after. */
async function withInlinePage<T>(body: string, use: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();

  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>Inline</title><style>.x{color:red}</style></head><body>${body}</body></html>`);

    return await use(page);
  } finally {
    await page.close();
  }
}

/** Reads the outline of `body` as `inline.html`. */
function outlineOf(body: string): Promise<DomOutline> {
  return withInlinePage(body, (page) => readDomOutline(page, 'inline.html'));
}

/** The tags of `outline`'s nodes, in order. */
function tagsOf(outline: DomOutline): string[] {
  return outline.nodes.map((node) => node.tag);
}

/** The UTF-8 size of `nodes` serialized, as the budget measures it. */
function serializedBytes(nodes: readonly OutlineNode[]): number {
  return Buffer.byteLength(JSON.stringify(nodes), 'utf8');
}

beforeAll(async () => {
  browser = await chromium.launch();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
});

describe('readDomOutline skips', () => {
  test('skips script, style, noscript and template elements with their content; control: they are in the DOM', async () => {
    const body = [
      '<script>window.x = 1;</script>',
      '<style>p { color: blue; }</style>',
      '<noscript><p class="fallback">No JS</p></noscript>',
      '<template><p class="later">Later</p></template>',
      '<p class="kept">Kept</p>',
    ].join('');
    const { outline, inDom } = await withInlinePage(body, async (page) => ({
      outline: await readDomOutline(page, 'inline.html'),
      inDom: await page.locator('body > script, body > style, body > noscript, body > template').count(),
    }));

    expect(inDom).toBe(4);
    expect(outline.nodes).toStrictEqual([
      { depth: 0, tag: 'body', id: null, classes: [], data: {}, text: '' },
      { depth: 1, tag: 'p', id: null, classes: ['kept'], data: {}, text: 'Kept' },
    ]);
    expect(outline.truncated).toBe(false);
  }, TEST_TIMEOUT_MS);

  test('skips a hidden element but keeps a visible child of a visibility-hidden parent; control: all are in the DOM', async () => {
    const body = [
      '<div class="shown">A</div>',
      '<div class="gone" style="display: none"><span class="inside-gone">B</span></div>',
      '<div class="ghost" style="visibility: hidden"><em class="back" style="visibility: visible">C</em></div>',
    ].join('');
    const { outline, inDom } = await withInlinePage(body, async (page) => ({
      outline: await readDomOutline(page, 'inline.html'),
      inDom: await page.locator('.gone, .inside-gone, .ghost').count(),
    }));

    expect(inDom).toBe(3);
    expect(outline.nodes.map(({ depth, classes }) => ({ depth, classes }))).toStrictEqual([
      { depth: 0, classes: [] },
      { depth: 1, classes: ['shown'] },
      { depth: 2, classes: ['back'] },
    ]);
  }, TEST_TIMEOUT_MS);
});

describe('readDomOutline node fields', () => {
  test('cuts a long own text to TEXT_SAMPLE_LENGTH characters after collapsing whitespace', async () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`);
    const outline = await outlineOf(`<p>\n  ${words.join('   \n ')}  <b>bold</b> tail</p>`);
    const expected = `${words.join(' ')} tail`.slice(0, TEXT_SAMPLE_LENGTH);

    expect(`${words.join(' ')} tail`.length).toBeGreaterThan(TEXT_SAMPLE_LENGTH);
    expect(outline.nodes[1]).toMatchObject({ tag: 'p', text: expected });
    expect(outline.nodes[1]?.text).toHaveLength(TEXT_SAMPLE_LENGTH);
    expect(outline.nodes[2]).toMatchObject({ tag: 'b', text: 'bold' });
  }, TEST_TIMEOUT_MS);

  test('keeps data-* attributes by full name, and the id and classes, but no other attribute', async () => {
    const outline = await outlineOf('<nav id="main" class="bar wide" data-role="nav" data-sticky="" aria-label="Main" title="t">Menu</nav>');

    expect(outline.nodes[1]).toStrictEqual({
      depth: 1,
      tag: 'nav',
      id: 'main',
      classes: ['bar', 'wide'],
      data: { 'data-role': 'nav', 'data-sticky': '' },
      text: 'Menu',
    });
  }, TEST_TIMEOUT_MS);

  test('counts depth from body at 0, in document order, and reads nothing from head', async () => {
    const outline = await outlineOf('<main><section><p>Deep</p></section><aside>Side</aside></main><footer>End</footer>');

    expect(outline.nodes.map(({ depth, tag }) => ({ depth, tag }))).toStrictEqual([
      { depth: 0, tag: 'body' },
      { depth: 1, tag: 'main' },
      { depth: 2, tag: 'section' },
      { depth: 3, tag: 'p' },
      { depth: 2, tag: 'aside' },
      { depth: 1, tag: 'footer' },
    ]);
    expect(tagsOf(outline)).not.toContain('title');
  }, TEST_TIMEOUT_MS);

  test('writes pagePath into the outline, which passes its own schema', async () => {
    const outline = await withInlinePage('<p>Hi</p>', (page) => readDomOutline(page, 'pages/about.html'));

    expect(outline.page).toBe('pages/about.html');
    expect(domOutlineSchema.parse(outline)).toStrictEqual(outline);
  }, TEST_TIMEOUT_MS);
});

describe('readDomOutline budget', () => {
  test('cuts a page past OUTLINE_BYTE_BUDGET to a document-order prefix under it, marked truncated', async () => {
    const body = Array.from({ length: OVER_BUDGET_ELEMENTS }, (_, index) => `<p class="item" data-index="${index}">Item number ${index} of the long list</p>`).join('');
    const outline = await outlineOf(body);
    const bytes = serializedBytes(outline.nodes);
    const lastNode = outline.nodes.at(-1);

    expect(outline.truncated).toBe(true);
    expect(bytes).toBeLessThanOrEqual(OUTLINE_BYTE_BUDGET);
    // The cut falls at the first node that does not fit, so the list is
    // within one node (and its comma) of the budget.
    expect(bytes + serializedBytes(lastNode === undefined
      ? []
      : [lastNode])).toBeGreaterThan(OUTLINE_BYTE_BUDGET);
    expect(outline.nodes.length).toBeLessThan(OVER_BUDGET_ELEMENTS);
    expect(outline.nodes.slice(1).map((node) => node.data['data-index'])).toStrictEqual(Array.from({ length: outline.nodes.length - 1 }, (_, index) => String(index)));
  }, TEST_TIMEOUT_MS);

  test('control: a page under the budget comes back whole with truncated: false', async () => {
    const outline = await outlineOf('<p class="item" data-index="0">One</p><p class="item" data-index="1">Two</p>');

    expect(outline.truncated).toBe(false);
    expect(outline.nodes).toHaveLength(3);
  }, TEST_TIMEOUT_MS);
});

describe('domOutlineSchema', () => {
  test('rejects a node with an unknown key', () => {
    const outline = {
      page: 'inline.html',
      nodes: [{ depth: 0, tag: 'body', id: null, classes: [], data: {}, text: '', role: 'main' }],
      truncated: false,
    };

    expect(domOutlineSchema.safeParse(outline).success).toBe(false);
  });

  test('rejects a text past TEXT_SAMPLE_LENGTH characters, but counts an emoji as one', () => {
    const withText = (text: string): unknown => ({
      page: 'inline.html',
      nodes: [{ depth: 0, tag: 'body', id: null, classes: [], data: {}, text }],
      truncated: false,
    });

    expect(domOutlineSchema.safeParse(withText('a'.repeat(TEXT_SAMPLE_LENGTH + 1))).success).toBe(false);
    expect(domOutlineSchema.safeParse(withText('😀'.repeat(TEXT_SAMPLE_LENGTH))).success).toBe(true);
  });
});
