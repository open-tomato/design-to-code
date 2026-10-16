/**
 * Tests for `animations.ts`: the inventory read in headless Chromium over
 * a temporary copy of the `animation` fixture served by `startServer` and
 * loaded by `withLoadedPage`, and the `animations.json` writer.
 *
 * The fixture runs one CSS animation (`pulse`, 2 s, `ease-in-out`,
 * infinite) on `#spinner` and one 1.5 s `linear` opacity transition on
 * `#fader`. A still page written into the copy is the control: a page
 * with no motion lists none, so the fixture's entries are its own.
 *
 * The fixture is tracked and never modified: every run copies it first.
 *
 * @packageDocumentation
 */

import type { AnimationEntry, PageAnimations } from './animations.ts';
import type { CaptureTarget } from './capture.ts';
import type { CaptureViewport } from './settings.ts';
import type { RunningServer } from '../serve/server.ts';
import type { Browser } from 'playwright';

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startServer } from '../serve/server.ts';

import {
  ANIMATIONS_FILE,
  AnimationsError,
  animationsFileSchema,
  animationsPath,
  INFINITE,
  readAnimationInventory,
  writeAnimations,
} from './animations.ts';
import { withLoadedPage } from './capture.ts';

const ANIMATION_FIXTURE = join(import.meta.dirname, 'fixtures', 'animation');

/** A browser launch plus a page load with its waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const VIEWPORT: CaptureViewport = { name: 'desktop', width: 800, height: 600 };

const ANIMATION_PAGE = 'index.html';

const STILL_PAGE = 'still.html';

const STILL_HTML = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Still</title></head>\n<body><main><p>No motion.</p></main></body>\n</html>\n';

let workDir: string;
let server: RunningServer;
let browser: Browser;

/** The capture target for `path` at {@link VIEWPORT}. */
function target(path: string): CaptureTarget {
  return { address: server.address, path, viewport: VIEWPORT };
}

/** The inventory of `path` once loaded under the capture settings. */
function inventoryOf(path: string): Promise<readonly AnimationEntry[]> {
  return withLoadedPage(browser, target(path), readAnimationInventory);
}

/** The entry of `kind` in `entries`, failing the test when there is none. */
function entryOfKind<K extends AnimationEntry['kind']>(
  entries: readonly AnimationEntry[],
  kind: K,
): Extract<AnimationEntry, { kind: K }> {
  const found = entries.find((entry): entry is Extract<AnimationEntry, { kind: K }> => entry.kind === kind);

  if (found === undefined) {
    throw new Error(`no ${kind} entry in ${JSON.stringify(entries)}`);
  }

  return found;
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-animations-test-'));

  const sourceDir = join(workDir, 'animation');

  cpSync(ANIMATION_FIXTURE, sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, STILL_PAGE), STILL_HTML);

  server = await startServer({ sourceDir, env: {}, port: 0 });
  browser = await chromium.launch();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  await server.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe('readAnimationInventory over the animation fixture', () => {
  test('lists exactly one CSS animation and one CSS transition', async () => {
    const entries = await inventoryOf(ANIMATION_PAGE);

    expect(entries.map((entry) => entry.kind).sort()).toStrictEqual(['CSSAnimation', 'CSSTransition']);
  }, TEST_TIMEOUT_MS);

  test('lists the CSS animation with its name, 2000 ms, ease-in-out keyframes and infinite iterations', async () => {
    const animation = entryOfKind(await inventoryOf(ANIMATION_PAGE), 'CSSAnimation');

    expect(animation.animationName).toBe('pulse');
    expect(animation.target).toBe('html > body > main > div#spinner');
    expect(animation.timing).toStrictEqual({
      duration: 2000,
      delay: 0,
      // animation-timing-function applies per keyframe, so the timing's own easing stays linear.
      easing: 'linear',
      iterations: INFINITE,
      direction: 'normal',
      fill: 'none',
    });
    expect(animation.keyframes).toStrictEqual([
      { offset: 0, computedOffset: 0, easing: 'ease-in-out', composite: 'auto', properties: { transform: 'scale(1)' } },
      { offset: 1, computedOffset: 1, easing: 'ease-in-out', composite: 'auto', properties: { transform: 'scale(1.2)' } },
    ]);
  }, TEST_TIMEOUT_MS);

  test('lists the transition with opacity, 1500 ms and linear easing', async () => {
    const transition = entryOfKind(await inventoryOf(ANIMATION_PAGE), 'CSSTransition');

    expect(transition.transitionProperty).toBe('opacity');
    expect(transition.target).toBe('html > body > main > div#fader');
    expect(transition.timing.duration).toBe(1500);
    expect(transition.timing.easing).toBe('linear');
    expect(transition.timing.iterations).toBe(1);
    expect(transition.keyframes.map((keyframe) => keyframe.properties)).toStrictEqual([
      { opacity: '0' },
      { opacity: '1' },
    ]);
  }, TEST_TIMEOUT_MS);

  test('control: a page with no motion lists no animations', async () => {
    expect(await inventoryOf(STILL_PAGE)).toStrictEqual([]);
  }, TEST_TIMEOUT_MS);

  test('lists a script-started animation as other, with an nth-of-type pseudo-element path and infinite duration', async () => {
    const entries = await withLoadedPage(browser, target(STILL_PAGE), async (page) => {
      await page.evaluate(() => {
        const main = document.querySelector('main');
        const second = document.createElement('p');

        main?.append(second);
        second.animate(
          [{ opacity: 0, color: 'red' }, { opacity: 1, color: 'blue' }],
          {
            duration: Number.POSITIVE_INFINITY,
            delay: 100,
            easing: 'ease-out',
            iterations: 3,
            direction: 'alternate',
            fill: 'both',
            pseudoElement: '::before',
          },
        );
      });

      return readAnimationInventory(page);
    });

    expect(entries).toHaveLength(1);

    const other = entryOfKind(entries, 'other');

    expect(other.target).toBe('html > body > main > p:nth-of-type(2)::before');
    expect(other.timing).toStrictEqual({
      duration: INFINITE,
      delay: 100,
      easing: 'ease-out',
      iterations: 3,
      direction: 'alternate',
      fill: 'both',
    });
    expect(other.keyframes.map((keyframe) => keyframe.properties)).toStrictEqual([
      { color: 'red', opacity: '0' },
      { color: 'blue', opacity: '1' },
    ]);
  }, TEST_TIMEOUT_MS);
});

describe('writeAnimations', () => {
  /** A fresh key directory path under the work dir, not yet created. */
  function freshKeyDir(): string {
    return join(mkdtempSync(join(workDir, 'key-')), 'playwright', 'hash');
  }

  function stillPage(page: string): PageAnimations {
    return { page, viewport: VIEWPORT.name, animations: [] };
  }

  test('writes the fixture inventory under the key dir, sorted by page, keeping infinite as a string', async () => {
    const keyDir = freshKeyDir();
    const animations = await inventoryOf(ANIMATION_PAGE);

    const written = writeAnimations(keyDir, [
      { page: STILL_PAGE, viewport: VIEWPORT.name, animations: [] },
      { page: ANIMATION_PAGE, viewport: VIEWPORT.name, animations },
    ]);
    const text = readFileSync(join(keyDir, ANIMATIONS_FILE), 'utf8');
    const parsed = animationsFileSchema.parse(JSON.parse(text));

    expect(written.map((entry) => entry.page)).toStrictEqual([ANIMATION_PAGE, STILL_PAGE]);
    expect(parsed).toStrictEqual(written);
    expect(text.endsWith('}\n]\n')).toBe(true);
    expect(entryOfKind(parsed[0]?.animations ?? [], 'CSSAnimation').timing.iterations).toBe(INFINITE);
    expect(readdirSync(keyDir)).toStrictEqual([ANIMATIONS_FILE]);
  }, TEST_TIMEOUT_MS);

  test('refuses a page listed twice and writes nothing', () => {
    const keyDir = freshKeyDir();

    expect(() => writeAnimations(keyDir, [stillPage('a.html'), stillPage('a.html')]))
      .toThrow(/page "a\.html" is listed twice/);
    expect(existsSync(keyDir)).toBe(false);
  });

  test('refuses an entry that fails the schema, naming the field', () => {
    const keyDir = freshKeyDir();
    const bad: PageAnimations = {
      page: 'a.html',
      viewport: VIEWPORT.name,
      animations: [{
        kind: 'other',
        target: null,
        timing: { duration: -1, delay: 0, easing: 'linear', iterations: 1, direction: 'normal', fill: 'none' },
        keyframes: [],
      }],
    };

    expect(() => writeAnimations(keyDir, [bad])).toThrow(AnimationsError);
    expect(() => writeAnimations(keyDir, [bad])).toThrow(/0\.animations\.0\.timing\.duration/);
    expect(existsSync(keyDir)).toBe(false);
  });

  test('builds the path directly inside the key dir', () => {
    expect(animationsPath('/tmp/base/1.0.0/abc')).toBe(join('/tmp/base/1.0.0/abc', ANIMATIONS_FILE));
  });
});
