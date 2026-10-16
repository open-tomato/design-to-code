/**
 * End-to-end tests for baseline capture: temp copies of the `clock` and
 * `animation` fixtures, served by a real {@link startServer} and captured
 * in headless Chromium, exercising the whole pipeline rather than one
 * module at a time.
 *
 * Two full {@link runCapture} runs over the same import, each starting and
 * stopping its own server and browser, write the fixed-clock page's PNG
 * byte for byte the same both times, and each records the live-clock page
 * `flaky` with a non-empty region in `capture.json`. Changing what
 * `.import/record.json` hashes — a plain file added to the export, no page
 * touched — moves the next run to a new key directory that sits beside the
 * first, which is left untouched. Last, every page this file serves is
 * checked directly against a server from {@link startServer}: a plain fetch
 * of a page includes the injected nav `<script>`, but the same page loaded
 * the way capture loads it, through `withLoadedPage`, never does, because
 * every capture load goes through `checkUrl`'s `?d2c-nav=0`.
 *
 * The fixtures are tracked and never modified: every test copies what it
 * needs into a fresh temporary directory first.
 *
 * @packageDocumentation
 */

import type { ConfirmedEntry } from './confirmed.ts';
import type { RunCaptureOptions } from './run-capture.ts';
import type { CaptureViewport } from './settings.ts';
import type { RunningServer } from '../serve/server.ts';
import type { Browser } from 'playwright';

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';
import { writeImportRecord } from '../import/record.ts';
import { NAV_SCRIPT_ATTRIBUTE } from '../serve/nav.ts';
import { startServer } from '../serve/server.ts';

import { withLoadedPage } from './capture.ts';
import { writeConfirmed } from './confirmed.ts';
import { pagePngPath, readImportHash, readPlaywrightVersion } from './key.ts';
import { CAPTURE_FILE, captureFileSchema, flakyCaptures, runCapture } from './run-capture.ts';

const CLOCK_FIXTURE = join(import.meta.dirname, 'fixtures', 'clock');

const ANIMATION_FIXTURE = join(import.meta.dirname, 'fixtures', 'animation');

const FIXED_CLOCK_PAGE = 'fixed-clock.html';

const LIVE_CLOCK_PAGE = 'live-clock.html';

const ANIMATION_PAGE = 'animation.html';

/** The baseline dir, relative to a test's root dir. */
const BASELINE_DIR = 'baselines/test';

const VIEWPORT: CaptureViewport = { name: 'desktop', width: 800, height: 600 };

const CONFIRMED_AT = '2026-09-30T12:00:00.000Z';

/** Two browser launches plus a handful of page loads with room to spare. */
const RUN_TIMEOUT_MS = 180_000;

/** One browser launch plus one page load, with room to spare. */
const NAV_TEST_TIMEOUT_MS = 30_000;

/** A temp copy of an export with its own baseline dir, nothing written under it yet. */
interface Workspace {
  readonly rootDir: string;
  readonly sourceDir: string;
  readonly baselineRoot: string;
}

const workDirs: string[] = [];

afterEach(() => {
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

/** A fresh, empty source dir under its own temp root, tracked for cleanup. */
function freshWorkspace(prefix: string): Workspace {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const sourceDir = join(rootDir, 'project');

  workDirs.push(rootDir);
  mkdirSync(sourceDir, { recursive: true });

  return { rootDir, sourceDir, baselineRoot: join(rootDir, BASELINE_DIR) };
}

/** A temp copy of both clock pages, recorded and discovered. */
function clockWorkspace(): Workspace {
  const space = freshWorkspace('d2c-pipeline-baseline-capture-integration-test-');

  cpSync(join(CLOCK_FIXTURE, FIXED_CLOCK_PAGE), join(space.sourceDir, FIXED_CLOCK_PAGE));
  cpSync(join(CLOCK_FIXTURE, LIVE_CLOCK_PAGE), join(space.sourceDir, LIVE_CLOCK_PAGE));
  writeImportRecord({ sourceDir: space.sourceDir, kind: 'folder', originalPath: CLOCK_FIXTURE });
  writeDiscovery(space.sourceDir, discover(space.sourceDir));

  return space;
}

/** A person's confirmation of `page` under `importHash`. */
function confirmation(page: string, importHash: string): ConfirmedEntry {
  return { page, confirmedAt: CONFIRMED_AT, by: 'person', importHash };
}

/** Run options over `space` at {@link VIEWPORT}, keeping every kept page unless `overrides` says otherwise. */
function options(space: Workspace, overrides: Partial<RunCaptureOptions> = {}): RunCaptureOptions {
  return {
    sourceDir: space.sourceDir,
    baselineDir: BASELINE_DIR,
    rootDir: space.rootDir,
    pages: {},
    viewports: [VIEWPORT],
    env: {},
    ...overrides,
  };
}

describe('two full runCapture runs over the clock fixture', () => {
  test('give byte-identical PNGs for the fixed-clock page and both record the live-clock page flaky', async () => {
    const space = clockWorkspace();
    const importHash = readImportHash(space.sourceDir);

    writeConfirmed(space.baselineRoot, [FIXED_CLOCK_PAGE, LIVE_CLOCK_PAGE].map((page) => confirmation(page, importHash)));

    const first = await runCapture(options(space));
    const firstFlaky = flakyCaptures(first.record);

    expect(firstFlaky).toHaveLength(1);
    expect(firstFlaky[0]?.page).toBe(LIVE_CLOCK_PAGE);
    expect(firstFlaky[0]?.viewport).toBe(VIEWPORT.name);
    expect(firstFlaky[0]?.differingPixels).toBeGreaterThan(0);
    expect(firstFlaky[0]?.region.width).toBeGreaterThan(0);
    expect(firstFlaky[0]?.region.height).toBeGreaterThan(0);

    const onDisk = captureFileSchema.parse(JSON.parse(readFileSync(join(first.keyDir, CAPTURE_FILE), 'utf8')));

    expect(onDisk).toStrictEqual(first.record);

    const firstPng = readFileSync(pagePngPath(first.keyDir, FIXED_CLOCK_PAGE, VIEWPORT.name));

    const second = await runCapture(options(space));
    const secondFlaky = flakyCaptures(second.record);

    expect(second.keyDir).toBe(first.keyDir);
    expect(secondFlaky).toHaveLength(1);
    expect(secondFlaky[0]?.page).toBe(LIVE_CLOCK_PAGE);
    expect(secondFlaky[0]?.region.width).toBeGreaterThan(0);
    expect(secondFlaky[0]?.region.height).toBeGreaterThan(0);

    const secondPng = readFileSync(pagePngPath(second.keyDir, FIXED_CLOCK_PAGE, VIEWPORT.name));

    expect(Buffer.compare(firstPng, secondPng)).toBe(0);
  }, RUN_TIMEOUT_MS);
});

describe('a changed .import/record.json', () => {
  test('writes the next run under a new key directory beside the old one', async () => {
    const space = clockWorkspace();
    const firstHash = readImportHash(space.sourceDir);

    writeConfirmed(space.baselineRoot, [confirmation(FIXED_CLOCK_PAGE, firstHash)]);

    const first = await runCapture(options(space, { pages: { discard: [LIVE_CLOCK_PAGE] } }));

    // A plain file, not a page: discovery stays the same, only the import hash changes.
    writeFileSync(join(space.sourceDir, 'note.txt'), 'a later import\n');
    writeImportRecord({
      sourceDir: space.sourceDir,
      kind: 'folder',
      originalPath: CLOCK_FIXTURE,
      now: new Date(Date.now() + 1000),
    });

    const secondHash = readImportHash(space.sourceDir);

    expect(secondHash).not.toBe(firstHash);

    writeConfirmed(space.baselineRoot, [confirmation(FIXED_CLOCK_PAGE, secondHash)]);

    const second = await runCapture(options(space, { pages: { discard: [LIVE_CLOCK_PAGE] } }));

    expect(second.keyDir).not.toBe(first.keyDir);

    const versionDir = join(space.baselineRoot, readPlaywrightVersion());
    const listing = readdirSync(versionDir).sort();

    expect(listing).toStrictEqual([firstHash, secondHash].sort());
    expect(existsSync(pagePngPath(first.keyDir, FIXED_CLOCK_PAGE, VIEWPORT.name))).toBe(true);
    expect(existsSync(pagePngPath(second.keyDir, FIXED_CLOCK_PAGE, VIEWPORT.name))).toBe(true);
  }, RUN_TIMEOUT_MS);
});

describe('capture loads over a real server from startServer', () => {
  let workDir: string;
  let server: RunningServer;
  let browser: Browser;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-capture-integration-nav-test-'));

    const sourceDir = join(workDir, 'project');

    mkdirSync(sourceDir, { recursive: true });
    cpSync(join(CLOCK_FIXTURE, FIXED_CLOCK_PAGE), join(sourceDir, FIXED_CLOCK_PAGE));
    cpSync(join(CLOCK_FIXTURE, LIVE_CLOCK_PAGE), join(sourceDir, LIVE_CLOCK_PAGE));
    cpSync(join(ANIMATION_FIXTURE, 'index.html'), join(sourceDir, ANIMATION_PAGE));

    server = await startServer({ sourceDir, env: {}, port: 0 });
    browser = await chromium.launch();
  }, NAV_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser.close();
    await server.stop();
    rmSync(workDir, { recursive: true, force: true });
  });

  test.each([FIXED_CLOCK_PAGE, LIVE_CLOCK_PAGE, ANIMATION_PAGE])(
    'keeps the nav host out of the %s capture, though the plain page serves it',
    async (page) => {
      const plain = await fetch(new URL(page, server.address), { headers: { connection: 'close' } });
      const plainHtml = await plain.text();

      expect(plainHtml).toContain(NAV_SCRIPT_ATTRIBUTE);

      const capturedHtml = await withLoadedPage(
        browser,
        { address: server.address, path: page, viewport: VIEWPORT },
        (loadedPage) => loadedPage.content(),
      );

      expect(capturedHtml).not.toContain(NAV_SCRIPT_ATTRIBUTE);
    },
    NAV_TEST_TIMEOUT_MS,
  );
});
