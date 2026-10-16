/**
 * Tests for `run-capture.ts` over temporary copies of the `clock` fixture,
 * each given an import record and a `discovery.json` at test time.
 *
 * The refusals pass a browser launcher that records its calls: a refused
 * run must throw before calling it and leave the baseline dir holding only
 * `confirmed.json`. The control is the capturing run, which passes the same
 * kind of launcher and sees it called once, so a launcher left uncalled
 * means the refusal came first rather than that the seam is ignored.
 *
 * The capturing runs serve the copy and capture it in headless Chromium.
 * A still page is written into the copy under a folder with a space in its
 * name, so the keyed PNG paths are checked through a nested page path.
 *
 * The fixture is tracked and never modified: every test copies it first.
 *
 * @packageDocumentation
 */

import type { ConfirmedEntry } from './confirmed.ts';
import type { RunCaptureOptions } from './run-capture.ts';
import type { CaptureViewport } from './settings.ts';
import type { Browser } from 'playwright';

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';
import { writeImportRecord } from '../import/record.ts';

import { animationsFileSchema, ANIMATIONS_FILE } from './animations.ts';
import { CONFIRMED_FILE, writeConfirmed } from './confirmed.ts';
import { MissingImportRecordError, pagePngPath, readImportHash, readPlaywrightVersion } from './key.ts';
import {
  CAPTURE_FILE,
  captureFileSchema,
  CaptureRefusedError,
  flakyCaptures,
  runCapture,
} from './run-capture.ts';

const CLOCK_FIXTURE = join(import.meta.dirname, 'fixtures', 'clock');

/** A browser launch plus eight page loads with their waits, with room to spare. */
const CAPTURE_TIMEOUT_MS = 120_000;

const FIXED_CLOCK_PAGE = 'fixed-clock.html';

const LIVE_CLOCK_PAGE = 'live-clock.html';

const STILL_PAGE = 'about us/still.html';

const STILL_HTML = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Still</title></head>\n<body><main><h1>Still</h1><p>No motion.</p></main></body>\n</html>\n';

/** The baseline dir, relative to the test's root dir. */
const BASELINE_DIR = 'baselines/test';

/** An import hash no record has, standing for an earlier import. */
const STALE_HASH = '0'.repeat(64);

const CONFIRMED_AT = '2026-09-30T12:00:00.000Z';

const GENERATED_AT = new Date('2026-09-30T12:30:00.000Z');

const DESKTOP: CaptureViewport = { name: 'desktop', width: 800, height: 600 };

const MOBILE: CaptureViewport = { name: 'mobile', width: 375, height: 667 };

/** A temp copy of the clock fixture with its import record and discovery report. */
interface Workspace {
  readonly rootDir: string;
  readonly sourceDir: string;
  readonly baselineRoot: string;
  readonly importHash: string;
}

const workDirs: string[] = [];

afterEach(() => {
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Copies the clock fixture, adds the still page, and records and assesses it. */
function workspace(): Workspace {
  const rootDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-run-capture-test-'));
  const sourceDir = join(rootDir, 'clock');

  workDirs.push(rootDir);
  cpSync(CLOCK_FIXTURE, sourceDir, { recursive: true });
  mkdirSync(join(sourceDir, 'about us'));
  writeFileSync(join(sourceDir, STILL_PAGE), STILL_HTML);
  writeImportRecord({ sourceDir, kind: 'folder', originalPath: CLOCK_FIXTURE });
  writeDiscovery(sourceDir, discover(sourceDir));

  return { rootDir, sourceDir, baselineRoot: join(rootDir, BASELINE_DIR), importHash: readImportHash(sourceDir) };
}

/** A person's confirmation of `page` under `importHash`. */
function confirmation(page: string, importHash: string): ConfirmedEntry {
  return { page, confirmedAt: CONFIRMED_AT, by: 'person', importHash };
}

/** A launcher that records its calls and starts real headless Chromium. */
function recordingLauncher(): ReturnType<typeof vi.fn<() => Promise<Browser>>> {
  return vi.fn(() => chromium.launch());
}

/** Run options over `space`, keeping every page but `discard`. */
function options(
  space: Workspace,
  launchBrowser: () => Promise<Browser>,
  overrides: Partial<RunCaptureOptions> = {},
): RunCaptureOptions {
  return {
    sourceDir: space.sourceDir,
    baselineDir: BASELINE_DIR,
    rootDir: space.rootDir,
    pages: { discard: [LIVE_CLOCK_PAGE] },
    viewports: [DESKTOP, MOBILE],
    env: {},
    launchBrowser,
    now: () => GENERATED_AT,
    ...overrides,
  };
}

/** The refusal `runCapture` rejects with, failing the test when it resolves or throws anything else. */
async function refusalOf(run: Promise<unknown>): Promise<CaptureRefusedError> {
  const error: unknown = await run.then(() => null, (thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(CaptureRefusedError);

  return error as CaptureRefusedError;
}

describe('runCapture refusals, before any browser starts', () => {
  test('names each kept page that has no confirmation', async () => {
    const space = workspace();
    const launch = recordingLauncher();

    writeConfirmed(space.baselineRoot, [confirmation(STILL_PAGE, space.importHash)]);

    const refusal = await refusalOf(runCapture(options(space, launch, { pages: {} })));

    expect(refusal.pages).toStrictEqual([FIXED_CLOCK_PAGE, LIVE_CLOCK_PAGE]);
    expect(refusal.message).toContain(`${FIXED_CLOCK_PAGE}, ${LIVE_CLOCK_PAGE}`);
    expect(refusal.message).toContain('bun run d2c baseline confirm');
    expect(launch).not.toHaveBeenCalled();
    expect(readdirSync(space.baselineRoot)).toStrictEqual([CONFIRMED_FILE]);
  });

  test('refuses a confirmation recorded under a stale import hash', async () => {
    const space = workspace();
    const launch = recordingLauncher();

    writeConfirmed(space.baselineRoot, [
      confirmation(FIXED_CLOCK_PAGE, STALE_HASH),
      confirmation(STILL_PAGE, space.importHash),
    ]);

    const refusal = await refusalOf(runCapture(options(space, launch)));

    expect(refusal.pages).toStrictEqual([FIXED_CLOCK_PAGE]);
    expect(refusal.message).toContain(FIXED_CLOCK_PAGE);
    expect(refusal.message).not.toContain(STILL_PAGE);
    expect(launch).not.toHaveBeenCalled();
    expect(readdirSync(space.baselineRoot)).toStrictEqual([CONFIRMED_FILE]);
  });

  const viewportCases: readonly (readonly [string, readonly CaptureViewport[] | undefined])[] = [
    ['unset', undefined],
    ['empty', []],
  ];

  viewportCases.forEach(([label, viewports]) => test(`refuses ${label} viewports`, async () => {
    const space = workspace();
    const launch = recordingLauncher();

    writeConfirmed(space.baselineRoot, [
      confirmation(FIXED_CLOCK_PAGE, space.importHash),
      confirmation(STILL_PAGE, space.importHash),
    ]);

    const refusal = await refusalOf(runCapture(options(space, launch, { viewports })));

    expect(refusal.message).toContain('`viewports` is not set');
    expect(refusal.pages).toStrictEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(readdirSync(space.baselineRoot)).toStrictEqual([CONFIRMED_FILE]);
  }));

  test('refuses a source dir with no import record, naming the import command', async () => {
    const space = workspace();
    const launch = recordingLauncher();

    rmSync(join(space.sourceDir, '.import'), { recursive: true });

    const error: unknown = await runCapture(options(space, launch)).then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MissingImportRecordError);
    expect((error as Error).message).toContain('bun run d2c import');
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(space.baselineRoot)).toBe(false);
  });
});

describe('runCapture over confirmed pages', () => {
  test('writes two kept pages at two viewports as four PNGs at their keyed paths', async () => {
    const space = workspace();
    const launch = recordingLauncher();

    writeConfirmed(space.baselineRoot, [
      confirmation(FIXED_CLOCK_PAGE, space.importHash),
      confirmation(STILL_PAGE, space.importHash),
    ]);

    const { keyDir, record } = await runCapture(options(space, launch));
    const expectedKey = join(space.baselineRoot, readPlaywrightVersion(), space.importHash);
    const pngs = [FIXED_CLOCK_PAGE, STILL_PAGE].flatMap((page) => [DESKTOP, MOBILE].map((viewport) => ({
      viewport,
      path: pagePngPath(keyDir, page, viewport.name),
    })));

    expect(launch).toHaveBeenCalledTimes(1);
    expect(keyDir).toBe(expectedKey);
    expect(pngs.map(({ path }) => path)).toStrictEqual([
      join(expectedKey, 'pages', FIXED_CLOCK_PAGE, 'desktop.png'),
      join(expectedKey, 'pages', FIXED_CLOCK_PAGE, 'mobile.png'),
      join(expectedKey, 'pages', 'about us', 'still.html', 'desktop.png'),
      join(expectedKey, 'pages', 'about us', 'still.html', 'mobile.png'),
    ]);
    pngs.forEach(({ viewport, path }) => {
      expect(PNG.sync.read(readFileSync(path)).width).toBe(viewport.width);
    });
    expect(readdirSync(join(keyDir, 'pages')).sort()).toStrictEqual(['about us', FIXED_CLOCK_PAGE]);
    expect(readdirSync(keyDir).sort()).toStrictEqual([ANIMATIONS_FILE, CAPTURE_FILE, 'pages']);
    expect(captureFileSchema.parse(JSON.parse(readFileSync(join(keyDir, CAPTURE_FILE), 'utf8')))).toStrictEqual(record);
    expect(record).toStrictEqual({
      generatedAt: GENERATED_AT.toISOString(),
      playwrightVersion: readPlaywrightVersion(),
      importHash: space.importHash,
      pages: [STILL_PAGE, FIXED_CLOCK_PAGE].map((page) => ({
        page,
        viewports: [DESKTOP, MOBILE].map((viewport) => ({
          viewport: viewport.name,
          status: 'captured',
          file: `pages/${page}/${viewport.name}.png`,
        })),
      })),
    });
    expect(flakyCaptures(record)).toStrictEqual([]);
    expect(animationsFileSchema.parse(JSON.parse(readFileSync(join(keyDir, ANIMATIONS_FILE), 'utf8')))).toStrictEqual([
      { page: STILL_PAGE, viewport: DESKTOP.name, animations: [] },
      { page: FIXED_CLOCK_PAGE, viewport: DESKTOP.name, animations: [] },
    ]);
  }, CAPTURE_TIMEOUT_MS);

  test('records a flaky page with its region and removes its stale PNG', async () => {
    const space = workspace();
    const launch = recordingLauncher();

    writeConfirmed(space.baselineRoot, [
      confirmation(FIXED_CLOCK_PAGE, space.importHash),
      confirmation(LIVE_CLOCK_PAGE, space.importHash),
    ]);

    const stalePng = pagePngPath(
      join(space.baselineRoot, readPlaywrightVersion(), space.importHash),
      LIVE_CLOCK_PAGE,
      DESKTOP.name,
    );

    mkdirSync(join(stalePng, '..'), { recursive: true });
    writeFileSync(stalePng, 'stale');

    const { keyDir, record } = await runCapture(options(space, launch, {
      pages: { discard: [STILL_PAGE] },
      viewports: [DESKTOP],
    }));
    const flaky = flakyCaptures(record);

    expect(flaky.map(({ page, viewport }) => [page, viewport])).toStrictEqual([[LIVE_CLOCK_PAGE, DESKTOP.name]]);
    expect(flaky[0]?.differingPixels).toBeGreaterThan(0);
    expect(flaky[0]?.region.width).toBeGreaterThan(0);
    expect(existsSync(stalePng)).toBe(false);
    expect(existsSync(pagePngPath(keyDir, FIXED_CLOCK_PAGE, DESKTOP.name))).toBe(true);
    expect(existsSync(join(keyDir, CAPTURE_FILE))).toBe(true);
  }, CAPTURE_TIMEOUT_MS);
});
