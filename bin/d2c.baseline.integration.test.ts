/**
 * Integration test for `bun run d2c baseline capture`, run as the real
 * package script (`bun run d2c ...`) rather than by calling {@link run} or
 * spawning `bin/d2c.ts` directly, so it exercises the script wiring in
 * `package.json`, a real server and a real headless Chromium too.
 *
 * Each case copies the `clock` fixture
 * (`pipeline/baseline/fixtures/clock`) into a fresh temporary root, with
 * absolute `source.dir` and `baselineDir` under it, writes a throwaway
 * `projects/<slug>.json` under the real repo root — `projects/*.json` is
 * gitignored except the tracked `example.json`, so this leaves nothing to
 * commit — and removes both the temporary root and the project file
 * afterwards, even if the assertion fails.
 *
 * The live-clock page's worker reads the real wall clock rather than the
 * page clock capture installs, so its double capture always finds a
 * difference: it is always the page left flaky.
 *
 * @packageDocumentation
 */

import type { ConfirmedEntry } from '../pipeline/baseline/confirmed.ts';
import type { SpawnSyncReturns } from 'node:child_process';

import { spawnSync } from 'node:child_process';
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

import { afterEach, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../pipeline/assess/discover.ts';
import { writeConfirmed } from '../pipeline/baseline/confirmed.ts';
import { pagePngPath, readImportHash, readPlaywrightVersion } from '../pipeline/baseline/key.ts';
import { CAPTURE_FILE, captureFileSchema } from '../pipeline/baseline/run-capture.ts';
import { writeImportRecord } from '../pipeline/import/record.ts';

const PROJECTS_DIR = join(import.meta.dirname, '..', 'projects');

const CLOCK_FIXTURE = join(import.meta.dirname, '..', 'pipeline', 'baseline', 'fixtures', 'clock');

const FIXED_CLOCK_PAGE = 'fixed-clock.html';

const LIVE_CLOCK_PAGE = 'live-clock.html';

/** The fixture's pages, sorted by path as `keptPages` returns them. */
const PAGES = [FIXED_CLOCK_PAGE, LIVE_CLOCK_PAGE] as const;

const VIEWPORTS = [
  { name: 'desktop', width: 800, height: 600 },
  { name: 'mobile', width: 375, height: 667 },
];

const CONFIRMED_AT = '2026-09-30T12:00:00.000Z';

const TMP_PREFIX = 'd2c-bin-d2c-baseline-integration-test-';

/** Two browser page loads per viewport plus process startup, with room to spare. */
const CAPTURE_TIMEOUT_MS = 180_000;

/** A temp copy of the clock fixture, recorded and discovered, with absolute dirs. */
interface Workspace {
  readonly sourceDir: string;
  readonly baselineDir: string;
}

const workDirs: string[] = [];

const projectPaths: string[] = [];

afterEach(() => {
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
  projectPaths.splice(0).forEach((path) => {
    rmSync(path, { force: true });
  });
});

function projectPath(slug: string): string {
  return join(PROJECTS_DIR, `${slug}.json`);
}

/** A slug unique to this test run, valid under `SLUG_PATTERN`. */
function uniqueSlug(label: string): string {
  return `integration-baseline-${label}-${crypto.randomUUID()}`;
}

/** A temp copy of both clock pages, recorded and discovered, absolute dirs. */
function workspace(): Workspace {
  const rootDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  const sourceDir = join(rootDir, 'source');
  const baselineDir = join(rootDir, 'baselines');

  workDirs.push(rootDir);
  mkdirSync(sourceDir, { recursive: true });
  cpSync(join(CLOCK_FIXTURE, FIXED_CLOCK_PAGE), join(sourceDir, FIXED_CLOCK_PAGE));
  cpSync(join(CLOCK_FIXTURE, LIVE_CLOCK_PAGE), join(sourceDir, LIVE_CLOCK_PAGE));
  writeImportRecord({ sourceDir, kind: 'folder', originalPath: CLOCK_FIXTURE });
  writeDiscovery(sourceDir, discover(sourceDir));

  return { sourceDir, baselineDir };
}

/** Writes the throwaway `projects/<slug>.json`, cleaned up in `afterEach`. */
function writeProject(
  slug: string,
  workDir: Workspace,
  fields: Record<string, unknown> = {},
): void {
  mkdirSync(PROJECTS_DIR, { recursive: true });

  const path = projectPath(slug);

  projectPaths.push(path);
  writeFileSync(
    path,
    JSON.stringify({
      slug,
      source: { dir: workDir.sourceDir },
      baselineDir: workDir.baselineDir,
      viewports: VIEWPORTS,
      ...fields,
    }),
  );
}

/** A person's confirmation of `page` under `importHash`. */
function confirmation(page: string, importHash: string): ConfirmedEntry {
  return { page, confirmedAt: CONFIRMED_AT, by: 'person', importHash };
}

/** Runs `bun run d2c baseline capture` as a real child process for `slug`. */
function spawnCapture(slug: string): SpawnSyncReturns<string> {
  return spawnSync('bun', ['run', 'd2c', 'baseline', 'capture'], {
    encoding: 'utf8',
    env: { ...process.env, D2C_PROJECT: slug },
    timeout: CAPTURE_TIMEOUT_MS,
  });
}

/** The key directory a workspace's capture writes under. */
function keyDirectoryOf(workDir: Workspace, importHash: string): string {
  return join(workDir.baselineDir, readPlaywrightVersion(), importHash);
}

describe('bun run d2c baseline capture', () => {
  test('exits non-zero naming a kept page missing from confirmed.json', () => {
    const slug = uniqueSlug('missing-confirmation');
    const workDir = workspace();
    const importHash = readImportHash(workDir.sourceDir);

    writeConfirmed(workDir.baselineDir, [confirmation(FIXED_CLOCK_PAGE, importHash)]);
    writeProject(slug, workDir);

    const result = spawnCapture(slug);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(LIVE_CLOCK_PAGE);
    expect(result.stderr).not.toContain(FIXED_CLOCK_PAGE);
    expect(readdirSync(workDir.baselineDir)).toEqual(['confirmed.json']);
  }, CAPTURE_TIMEOUT_MS);

  test(
    'writes one PNG per kept non-flaky page per viewport and marks the live-clock page flaky, exiting 1',
    () => {
      const slug = uniqueSlug('flaky-live-clock');
      const workDir = workspace();
      const importHash = readImportHash(workDir.sourceDir);

      writeConfirmed(workDir.baselineDir, PAGES.map((page) => confirmation(page, importHash)));
      writeProject(slug, workDir);

      const result = spawnCapture(slug);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('d2c baseline: captured 2 pages');
      expect(result.stderr).toContain(LIVE_CLOCK_PAGE);

      const keyDir = keyDirectoryOf(workDir, importHash);

      for (const { name } of VIEWPORTS) {
        expect(existsSync(pagePngPath(keyDir, FIXED_CLOCK_PAGE, name))).toBe(true);
        expect(existsSync(pagePngPath(keyDir, LIVE_CLOCK_PAGE, name))).toBe(false);
      }

      const record = captureFileSchema.parse(JSON.parse(readFileSync(join(keyDir, CAPTURE_FILE), 'utf8')));
      const fixedClockEntry = record.pages.find((page) => page.page === FIXED_CLOCK_PAGE);
      const liveClockEntry = record.pages.find((page) => page.page === LIVE_CLOCK_PAGE);

      expect(fixedClockEntry?.viewports.map((viewport) => viewport.status)).toEqual(['captured', 'captured']);
      expect(liveClockEntry?.viewports.map((viewport) => viewport.status)).toEqual(['flaky', 'flaky']);
    },
    CAPTURE_TIMEOUT_MS,
  );

  test('exits 0 when the live-clock page is discarded', () => {
    const slug = uniqueSlug('discard-live-clock');
    const workDir = workspace();
    const importHash = readImportHash(workDir.sourceDir);

    writeConfirmed(workDir.baselineDir, [confirmation(FIXED_CLOCK_PAGE, importHash)]);
    writeProject(slug, workDir, { pages: { discard: [LIVE_CLOCK_PAGE] } });

    const result = spawnCapture(slug);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('d2c baseline: captured 1 pages');
    expect(result.stderr).not.toContain('d2c baseline:');

    const keyDir = keyDirectoryOf(workDir, importHash);

    for (const { name } of VIEWPORTS) {
      expect(existsSync(pagePngPath(keyDir, FIXED_CLOCK_PAGE, name))).toBe(true);
      expect(existsSync(pagePngPath(keyDir, LIVE_CLOCK_PAGE, name))).toBe(false);
    }
  }, CAPTURE_TIMEOUT_MS);
});
