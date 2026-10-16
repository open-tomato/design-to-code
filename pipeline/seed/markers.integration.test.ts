/**
 * Tests for `markers.ts`: temp copies of the `marked` and `ds-manifest`
 * fixtures, each with its `discovery.json` written, served by
 * `startServer` and loaded in headless Chromium by `withSeedPage`; plus a
 * few inline pages set straight into a blank page for the convention's
 * edge cases.
 *
 * Over `marked`, the `Button` candidate is read whole (selector, examples,
 * the `disabled` example state, `variantAxes`, `parts`, `docText`) and
 * each of its selectors is re-counted by Playwright's own locator, with the
 * control that the bare `button` tag matches several elements; the
 * `Badge` that `widgets.js` adds is found, with the control that the
 * static `widgets.html` carries no marker at all. Over `ds-manifest`, the
 * roots without `data-level` come back as `missing-level` rejections.
 *
 * @packageDocumentation
 */

import type { MarkedComponents } from './markers.ts';
import type { ComponentEntry } from './schema.ts';
import type { RunningServer } from '../serve/server.ts';
import type { Browser, Page } from 'playwright';

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';
import { startServer } from '../serve/server.ts';

import { COMPONENT_ATTRIBUTE, hasComponentMarkers, readMarkedComponents } from './markers.ts';
import { withSeedPage } from './page.ts';

/** A browser launch plus a page load with its waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** A served temp copy of one fixture export. */
interface Served {
  readonly sourceDir: string;
  readonly server: RunningServer;
}

const workDirs: string[] = [];

let marked: Served;
let dsManifest: Served;
let browser: Browser;

/** Copies fixture `name` into a fresh temp dir, writes its discovery report and serves it. */
async function serveCopy(name: string): Promise<Served> {
  const rootDir = mkdtempSync(join(tmpdir(), 'd2c-seed-markers-'));
  const sourceDir = join(rootDir, name);

  workDirs.push(rootDir);
  cpSync(join(FIXTURES, name), sourceDir, { recursive: true });
  writeDiscovery(sourceDir, discover(sourceDir));

  return { sourceDir, server: await startServer({ sourceDir, env: {}, port: 0 }) };
}

/** Loads `pagePath` of `served` and reads its markers. */
function readServed(served: Served, pagePath: string): Promise<MarkedComponents> {
  return withSeedPage(browser, served.server.address, pagePath, (page) => readMarkedComponents(page, pagePath));
}

/** Sets `body` into a blank page and hands the page to `use`, closing it after. */
async function withInlinePage<T>(body: string, use: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();

  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>Inline</title></head><body>${body}</body></html>`);

    return await use(page);
  } finally {
    await page.close();
  }
}

/** The candidate named `name`, failing the test when there is none. */
function candidateNamed(read: MarkedComponents, name: string): ComponentEntry {
  const found = read.candidates.find((candidate) => candidate.name === name);

  if (found === undefined) {
    throw new Error(`no candidate named ${name}`);
  }

  return found;
}

beforeAll(async () => {
  marked = await serveCopy('marked');
  dsManifest = await serveCopy('ds-manifest');
  browser = await chromium.launch();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  await marked?.server.stop();
  await dsManifest?.server.stop();
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('readMarkedComponents over marked/index.html', () => {
  test('reads one candidate per name, in first-appearance order, rejecting none', async () => {
    const read = await readServed(marked, 'index.html');

    expect(read.candidates.map(({ name, level, origin }) => ({ name, level, origin }))).toStrictEqual([
      { name: 'Header', level: 'organism', origin: 'markers' },
      { name: 'SearchField', level: 'molecule', origin: 'markers' },
      { name: 'Icon', level: 'particle', origin: 'markers' },
      { name: 'Button', level: 'atom', origin: 'markers' },
    ]);
    expect(read.rejected).toStrictEqual([]);
  }, TEST_TIMEOUT_MS);

  test('reads the Button entry: selector, examples, disabled state, variant axes, parts and doc text', async () => {
    const read = await readServed(marked, 'index.html');

    expect(candidateNamed(read, 'Button')).toStrictEqual({
      name: 'Button',
      level: 'atom',
      page: 'index.html',
      selector: 'form#search > button',
      examples: ['html > body > main > button:nth-of-type(1)'],
      states: [{ name: 'disabled', mode: 'example', selector: 'html > body > main > button:nth-of-type(2)' }],
      variantAxes: { intent: ['primary', 'secondary'] },
      parts: ['label'],
      docText: ['Buttons trigger an action.', 'Use one primary button per view.'],
      origin: 'markers',
    });
  }, TEST_TIMEOUT_MS);

  test('each Button selector matches exactly one element; control: the bare tag matches three', async () => {
    const counts = await withSeedPage(browser, marked.server.address, 'index.html', async (page) => {
      const button = candidateNamed(await readMarkedComponents(page, 'index.html'), 'Button');
      const selectors = [button.selector, ...button.examples, ...button.states.map((state) => (state.mode === 'example'
        ? state.selector
        : state.target))];

      return {
        built: await Promise.all(selectors.map((selector) => page.locator(selector).count())),
        bare: await page.locator('button').count(),
      };
    });

    expect(counts).toStrictEqual({ built: [1, 1, 1], bare: 3 });
  }, TEST_TIMEOUT_MS);

  test('gives each part to the nearest enclosing root, not to an outer one', async () => {
    const read = await readServed(marked, 'index.html');

    expect(read.candidates.map(({ name, parts }) => ({ name, parts }))).toStrictEqual([
      { name: 'Header', parts: [] },
      { name: 'SearchField', parts: ['input'] },
      { name: 'Icon', parts: [] },
      { name: 'Button', parts: ['label'] },
    ]);
  }, TEST_TIMEOUT_MS);
});

describe('readMarkedComponents over marked/widgets.html', () => {
  test('control: the static widgets.html carries no component marker', () => {
    expect(readFileSync(join(marked.sourceDir, 'widgets.html'), 'utf8')).not.toContain(COMPONENT_ATTRIBUTE);
  });

  test('finds the Badge that widgets.js adds to the rendered DOM', async () => {
    const read = await readServed(marked, 'widgets.html');

    expect(read).toStrictEqual({
      candidates: [{
        name: 'Badge',
        level: 'atom',
        page: 'widgets.html',
        selector: 'main#widgets > span',
        examples: [],
        states: [],
        variantAxes: {},
        parts: [],
        docText: [],
        origin: 'markers',
      }],
      rejected: [],
    });
  }, TEST_TIMEOUT_MS);
});

describe('readMarkedComponents missing-level rejections', () => {
  test('returns each ds-manifest root without data-level as a missing-level rejection', async () => {
    const read = await readServed(dsManifest, 'index.html');

    expect(read.candidates).toStrictEqual([]);
    expect(read.rejected).toStrictEqual(['Button', 'Tag'].map((name) => {
      const selector = `html > body > main > ${name === 'Button'
        ? 'button'
        : 'span'}`;

      return {
        candidate: {
          name,
          page: 'index.html',
          selector,
          examples: [],
          states: [],
          variantAxes: {},
          parts: [],
          docText: [],
          origin: 'markers',
        },
        reasons: [{
          code: 'missing-level',
          detail: `the "${name}" root ${selector} on index.html has no data-level`,
        }],
      };
    }));
  }, TEST_TIMEOUT_MS);

  test('rejects a data-level outside LEVELS as missing-level, keeping the value it read', async () => {
    const read = await withInlinePage('<div data-component="Card" data-level="huge">A</div>', (page) => readMarkedComponents(page, 'inline.html'));

    expect(read.candidates).toStrictEqual([]);
    expect(read.rejected).toMatchObject([{
      candidate: { name: 'Card', level: 'huge', page: 'inline.html' },
      reasons: [{ code: 'missing-level', detail: expect.stringContaining('data-level="huge", not one of particle') }],
    }]);
  }, TEST_TIMEOUT_MS);
});

describe('readMarkedComponents edge cases', () => {
  test('takes the first root as the selector when every root of a name carries data-state', async () => {
    const body = [
      '<button data-component="Toggle" data-level="atom" data-state="on">On</button>',
      '<button data-component="Toggle" data-level="atom" data-state="off">Off</button>',
    ].join('');
    const read = await withInlinePage(body, (page) => readMarkedComponents(page, 'inline.html'));

    expect(candidateNamed(read, 'Toggle')).toMatchObject({
      selector: 'html > body > button:nth-of-type(1)',
      examples: [],
      states: [
        { name: 'on', mode: 'example', selector: 'html > body > button:nth-of-type(1)' },
        { name: 'off', mode: 'example', selector: 'html > body > button:nth-of-type(2)' },
      ],
    });
  }, TEST_TIMEOUT_MS);

  test('rejects a read that fails the entry schema as invalid-shape', async () => {
    const read = await withInlinePage('<i data-component="Dot" data-level="particle" data-state="">.</i>', (page) => readMarkedComponents(page, 'inline.html'));

    expect(read.candidates).toStrictEqual([]);
    expect(read.rejected).toMatchObject([{ candidate: { name: 'Dot', level: 'particle' }, reasons: [{ code: 'invalid-shape' }] }]);
  }, TEST_TIMEOUT_MS);
  test('gives a data-part on a nested root to the root enclosing it', async () => {
    const body = [
      '<form data-component="Search" data-level="molecule">',
      '<button data-component="Button" data-level="atom" data-part="submit"><span data-part="label">Go</span></button>',
      '</form>',
    ].join('');
    const read = await withInlinePage(body, (page) => readMarkedComponents(page, 'inline.html'));

    expect(read.candidates.map(({ name, parts }) => ({ name, parts }))).toStrictEqual([
      { name: 'Search', parts: ['submit'] },
      { name: 'Button', parts: ['label'] },
    ]);
  }, TEST_TIMEOUT_MS);
});

describe('hasComponentMarkers', () => {
  test('is true for the script-marked widgets.html', async () => {
    const marks = await withSeedPage(browser, marked.server.address, 'widgets.html', hasComponentMarkers);

    expect(marks).toBe(true);
  }, TEST_TIMEOUT_MS);

  test('is true for ds-manifest roots without a level', async () => {
    const marks = await withSeedPage(browser, dsManifest.server.address, 'index.html', hasComponentMarkers);

    expect(marks).toBe(true);
  }, TEST_TIMEOUT_MS);

  test('control: is false for a page with no data-component element', async () => {
    const marks = await withInlinePage('<p data-part="label" data-doc="Button">No roots</p>', hasComponentMarkers);

    expect(marks).toBe(false);
  }, TEST_TIMEOUT_MS);
});
